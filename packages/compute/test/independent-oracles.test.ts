import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { linearizeChunk, prepareAcquisition } from "../src/acquisition.js";
import { Kernels } from "../src/kernels.js";
import { prepareSpectralUnmixing, SpectralNumericalError, unmixChunk } from "../src/spectral.js";
import { getDevice, releaseDevice } from "./setup.js";

interface SpectralCase {
	id: string;
	S_fluor_by_detector: number[][];
	Y_event_by_detector: number[][];
	expected_X: number[][];
	expected_residual_l2: number[];
	detector_ids: string[];
	fluor_ids: string[];
	rank: number;
	condition_number: number;
}
interface AcquisitionCase {
	id: string;
	proposed_profile_policy: string;
	channels: Array<{ name: string; gain?: number; range?: number; pne?: string }>;
	timestep: string | null;
	stored: number[][];
	flowio_preprocessed: number[][];
}
const spectral = JSON.parse(
	readFileSync(join(import.meta.dirname, "data/spectral-oracle.json"), "utf8"),
) as { cases: SpectralCase[] };
const acquisition = JSON.parse(
	readFileSync(join(import.meta.dirname, "data/acquisition-oracle.json"), "utf8"),
) as { cases: AcquisitionCase[] };
let k: Kernels;
beforeAll(async () => {
	k = new Kernels((await getDevice()).device);
}, 30_000);
afterAll(() => releaseDevice());

describe("independent NumPy/FlowUtils spectral references", () => {
	it.each(spectral.cases)("$id", async (test) => {
		const names = ["unrelated", ...test.detector_ids.toReversed()];
		const reference = {
			detectors: test.detector_ids,
			fluorochromes: test.fluor_ids,
			matrix: test.S_fluor_by_detector.flat(),
			residualChannel: "fit-L2",
		};
		if (test.rank < test.fluor_ids.length || test.condition_number > 10000) {
			await expect(prepareSpectralUnmixing(k, names, reference, 1 << 20)).rejects.toBeInstanceOf(
				SpectralNumericalError,
			);
			return;
		}
		const plan = await prepareSpectralUnmixing(k, names, reference, 1 << 20);
		try {
			const input = Float32Array.from(
				test.Y_event_by_detector.flatMap((row, event) => [
					100 + event,
					...names.slice(1).map((name) => row[test.detector_ids.indexOf(name)] as number),
				]),
			);
			const actual = await unmixChunk(k, plan, input, 256);
			const stride = names.length + test.fluor_ids.length + 1;
			let maximum = 0,
				originalsMatch = true;
			for (let event = 0; event < test.expected_X.length; event++) {
				for (let channel = 0; channel < names.length; channel++)
					originalsMatch &&=
						actual[event * stride + channel] === input[event * names.length + channel];
				const expected = [
					...(test.expected_X[event] as number[]),
					test.expected_residual_l2[event] as number,
				];
				for (let channel = 0; channel < expected.length; channel++)
					maximum = Math.max(
						maximum,
						Math.abs(
							(actual[event * stride + names.length + channel] as number) -
								(expected[channel] as number),
						) /
							(1 + Math.abs(expected[channel] as number)),
					);
			}
			expect(originalsMatch).toBe(true);
			expect(maximum).toBeLessThanOrEqual(1e-5);
		} finally {
			plan.destroy();
		}
	});
});

describe("independent FlowIO acquisition references", () => {
	it.each(acquisition.cases)("$id", async (test) => {
		const channels = test.channels.map((channel) => ({
			name: channel.name,
			gain: channel.gain ?? 1,
			range: channel.range ?? 1024,
			amplification: (channel.pne ?? "0,0").split(",").map(Number) as [number, number],
		}));
		const options = { timeStep: test.timestep === null ? 1 : Number(test.timestep) };
		if (test.proposed_profile_policy.startsWith("reject")) {
			await expect(prepareAcquisition(k, channels, options, 1 << 20)).rejects.toThrow();
			return;
		}
		const plan = await prepareAcquisition(k, channels, options, 1 << 20);
		try {
			const actual = await linearizeChunk(k, plan, Float32Array.from(test.stored.flat()), 64);
			const expected = test.flowio_preprocessed.flat();
			let maximum = 0;
			for (let i = 0; i < expected.length; i++)
				maximum = Math.max(
					maximum,
					Math.abs((actual[i] as number) - (expected[i] as number)) /
						(1 + Math.abs(expected[i] as number)),
				);
			expect(maximum).toBeLessThanOrEqual(1e-5);
		} finally {
			plan.destroy();
		}
	});
});
