import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Kernels } from "../src/kernels.js";
import { prepareSpectralUnmixing, SpectralNumericalError, unmixChunk } from "../src/spectral.js";
import { getDevice, releaseDevice } from "./setup.js";

afterAll(() => releaseDevice());
let k: Kernels;
beforeAll(async () => {
	k = new Kernels((await getDevice()).device);
}, 30_000);

// TEST-ONLY double forward model. Known abundances plus independently constructed
// orthogonal detector noise determine the OLS answer, without mirroring the QR solver.
function forward(x: number[], matrix: number[], d: number, noise: number[]): Float32Array {
	const f = matrix.length / d;
	return Float32Array.from({ length: (x.length / f) * d }, (_, i) => {
		let y = noise[i % d] as number;
		for (let j = 0; j < f; j++)
			y += (x[Math.floor(i / d) * f + j] as number) * (matrix[j * d + (i % d)] as number);
		return y;
	});
}
describe("GPU named rectangular spectral OLS", () => {
	it.each([
		{ d: 3, matrix: [1, 2, 0, 0, 1, 3], noise: [6, -3, 1] },
		{ d: 4, matrix: [1, 2, 0, 1, 0, 1, 3, 2], noise: [6, -3, 1, 0] },
	])(
		"recovers known X with orthogonal noise, D=$d, and preserves inputs through unequal-stride windows",
		async ({ d, matrix, noise }) => {
			const detectors = Array.from({ length: d }, (_, i) => `D${i}`);
			const inputNames = ["raw", ...detectors.toReversed()];
			const fluorochromes = ["F0", "F1"];
			const plan = await prepareSpectralUnmixing(
				k,
				inputNames,
				{ detectors, fluorochromes, matrix, residualChannel: "L2" },
				65536,
			);
			const truth = Array.from({ length: 274 }, (_, i) => ((i % 13) - 6) * 1000 + 0.25);
			const measured = forward(truth, matrix, d, noise);
			const input = new Float32Array(137 * inputNames.length);
			const bits = new Uint32Array(input.buffer);
			for (let row = 0; row < 137; row++) {
				bits[row * (d + 1)] = row % 2 ? 0x7fa00123 : 0x80000000;
				for (let j = 0; j < d; j++)
					input[row * (d + 1) + j + 1] = measured[row * d + d - 1 - j] as number;
			}
			const before = bits.slice();
			// Caller mutation after preparation must not change the immutable plan.
			detectors.reverse();
			fluorochromes.reverse();
			matrix.fill(0);
			try {
				const result = await unmixChunk(k, plan, input, 64);
				const outBits = new Uint32Array(result.buffer);
				let maxError = 0,
					maxResidualError = 0,
					preserved = true;
				const residual = Math.hypot(...noise);
				for (let row = 0; row < 137; row++) {
					for (let j = 0; j < d + 1; j++)
						preserved &&= outBits[row * (d + 4) + j] === before[row * (d + 1) + j];
					for (let j = 0; j < 2; j++)
						maxError = Math.max(
							maxError,
							Math.abs(
								(result[row * (d + 4) + d + 1 + j] as number) - (truth[row * 2 + j] as number),
							),
						);
					maxResidualError = Math.max(
						maxResidualError,
						Math.abs((result[row * (d + 4) + d + 3] as number) - residual),
					);
				}
				expect(preserved).toBe(true);
				expect(bits).toEqual(before);
				expect(maxError).toBeLessThan(0.01);
				expect(maxResidualError).toBeLessThan(0.01);
				expect(new Uint32Array((await unmixChunk(k, plan, input, 64)).buffer)).toEqual(outBits);
				expect(plan.outputChannelNames).toEqual([...inputNames, "F0", "F1", "L2"]);
				expect(plan.diagnostics).toMatchObject({ source: "gpu-computation", rank: 2, status: 0 });
				expect(JSON.parse(JSON.stringify(plan.diagnostics))).toEqual(plan.diagnostics);
				expect(
					Object.isFrozen(plan) &&
						Object.isFrozen(plan.outputChannelNames) &&
						Object.isFrozen(plan.diagnostics),
				).toBe(true);
			} finally {
				plan.destroy();
			}
		},
	);
	it("handles exact mixtures, permuted pivots and no residual column", async () => {
		const matrix = [0, 0.2, 0.4, 5, 1, 2];
		const truth = [-2, 7, 1234, -500];
		const input = forward(truth, matrix, 3, [0, 0, 0]);
		const plan = await prepareSpectralUnmixing(
			k,
			["a", "b", "c"],
			{ detectors: ["a", "b", "c"], fluorochromes: ["x", "y"], matrix },
			65536,
		);
		try {
			const output = await unmixChunk(k, plan, input, 32);
			expect([output[3], output[4], output[8], output[9]]).toEqual(
				truth.map((v) => expect.closeTo(v, 2)),
			);
			expect(await unmixChunk(k, plan, new Float32Array(), 32)).toEqual(new Float32Array());
			await expect(unmixChunk(k, plan, new Float32Array(2), 32)).rejects.toThrow(/complete/);
			await expect(unmixChunk({ device: {} } as Kernels, plan, input, 32)).rejects.toThrow(
				/another/,
			);
		} finally {
			plan.destroy();
		}
	});
	it("snapshots metadata before asynchronous setup and preserves subarray byte offsets", async () => {
		const names = ["raw", "a", "b"];
		const reference: {
			detectors: string[];
			fluorochromes: string[];
			matrix: number[];
			residualChannel?: string;
		} = {
			detectors: ["a", "b"],
			fluorochromes: ["x"],
			matrix: [1, 2],
			residualChannel: "L2",
		};
		const pending = prepareSpectralUnmixing(k, names, reference, 64);
		names.length = 0;
		reference.detectors.reverse();
		reference.matrix.fill(0);
		reference.fluorochromes[0] = "changed";
		delete reference.residualChannel;
		const plan = await pending;
		try {
			const backing = new Float32Array([77, 0, 3, 6, 88]);
			new Uint32Array(backing.buffer)[1] = 1; // original nonparticipating subnormal bits
			const result = await unmixChunk(k, plan, backing.subarray(1, 4), 32);
			expect(plan.inputChannelCount).toBe(3);
			expect(plan.outputChannelNames).toEqual(["raw", "a", "b", "x", "L2"]);
			expect(new Uint32Array(result.buffer)[0]).toBe(1);
			expect(result[3]).toBeCloseTo(3, 5);
			expect(result[4]).toBeLessThan(0.00001);
		} finally {
			plan.destroy();
		}
	});
	it("has a conservative finite-range setup policy and stable scaled residual norm", async () => {
		await expect(
			prepareSpectralUnmixing(
				k,
				["a"],
				{ detectors: ["a"], fluorochromes: ["x"], matrix: [1e38] },
				32,
			),
		).rejects.toMatchObject({ diagnostics: { status: 2 } });
		const plan = await prepareSpectralUnmixing(
			k,
			["a", "b"],
			{ detectors: ["a", "b"], fluorochromes: ["x"], matrix: [1, 0], residualChannel: "L2" },
			32,
		);
		try {
			const output = await unmixChunk(k, plan, new Float32Array([2, 1e30]), 32);
			expect(output[2]).toBe(2);
			expect((output[3] as number) / 1e30).toBeCloseTo(1, 6);
		} finally {
			plan.destroy();
		}
	});
	it.each([
		[0, 0, 0, 0, 0, 0],
		[1, 2, 3, 2, 4, 6],
		[1, 0, 0, 0, 0.00000001, 0],
		[1, 0, 0, 0, 0.00001, 0],
	])("rejects degenerate/ill-conditioned references %j", async (...matrix) => {
		try {
			await prepareSpectralUnmixing(
				k,
				["a", "b", "c"],
				{ detectors: ["a", "b", "c"], fluorochromes: ["x", "y"], matrix },
				64,
			);
			throw new Error("accepted");
		} catch (e) {
			expect(e).toBeInstanceOf(SpectralNumericalError);
			expect([1, 3]).toContain((e as SpectralNumericalError).diagnostics.status);
			expect(JSON.parse(JSON.stringify((e as SpectralNumericalError).diagnostics))).toEqual(
				(e as SpectralNumericalError).diagnostics,
			);
		}
	});
	it("validates names/shapes/limits/f32 metadata before allocating", async () => {
		const spy = vi.spyOn(k.device, "createBuffer");
		const reference = { detectors: ["a", "b"], fluorochromes: ["x"], matrix: [1, 2] };
		try {
			const cases = [
				{ ...reference, detectors: ["a", "a"] },
				{ ...reference, detectors: ["A", "b"] },
				{ ...reference, fluorochromes: [""] },
				{ ...reference, fluorochromes: ["a"] },
				{ ...reference, residualChannel: "x" },
				{ ...reference, residualChannel: "a" },
				{ ...reference, residualChannel: "" },
				{ ...reference, matrix: [1] },
				{ ...reference, fluorochromes: ["x", "x"], matrix: [1, 0, 0, 1] },
				{ ...reference, fluorochromes: ["x", "y", "z"], matrix: [1, 2, 3, 4, 5, 6] },
				...Array.from([NaN, Infinity, 1e40, 1e-40, 1e-50], (v) => ({
					...reference,
					matrix: [1, v],
				})),
			];
			for (const r of cases)
				await expect(prepareSpectralUnmixing(k, ["a", "b"], r, 64)).rejects.toThrow();
			for (const names of [["a", "a"], ["", "b"], []])
				await expect(prepareSpectralUnmixing(k, names, reference, 64)).rejects.toThrow();
			await expect(prepareSpectralUnmixing(k, ["a", "b"], reference, NaN)).rejects.toThrow(/limit/);
			const names = Array.from({ length: 129 }, (_, i) => `${i}`);
			await expect(
				prepareSpectralUnmixing(
					k,
					names,
					{ detectors: names, fluorochromes: ["x"], matrix: names.map(() => 1) },
					65536,
				),
			).rejects.toThrow(/128/);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
	it("bounds buffers, cleans errors, counts failing rows and defers in-flight destroy", async () => {
		const created: Array<{ size: number; destroyed: ReturnType<typeof vi.spyOn> }> = [];
		const create = k.device.createBuffer.bind(k.device);
		const spy = vi.spyOn(k.device, "createBuffer").mockImplementation((desc) => {
			const b = create(desc);
			created.push({ size: b.size, destroyed: vi.spyOn(b, "destroy") });
			return b;
		});
		k.device.pushErrorScope("validation");
		try {
			const reference = {
				detectors: ["a"],
				fluorochromes: ["x"],
				matrix: [0.5],
				residualChannel: "L2",
			};
			const plan = await prepareSpectralUnmixing(k, ["a"], reference, 32);
			const broken = new Kernels(k.device, {});
			await expect(prepareSpectralUnmixing(broken, ["a"], reference, 32)).rejects.toThrow(
				/unknown kernel/,
			);
			await expect(unmixChunk(broken, plan, new Float32Array([1]), 32)).rejects.toThrow(
				/unknown kernel/,
			);
			for (const value of [Infinity, NaN, 3e38])
				await expect(unmixChunk(k, plan, new Float32Array([value]), 32)).rejects.toMatchObject({
					diagnostics: { status: 4, numericalErrors: 1 },
				});
			const pending = Promise.all(
				[1, -3].map((v) => unmixChunk(k, plan, new Float32Array(53).fill(v), 32)),
			);
			plan.destroy();
			plan.destroy();
			const outputs = await pending;
			expect(outputs).toEqual(
				[1, -3].map((v) =>
					Float32Array.from({ length: 159 }, (_, i) => (i % 3 === 0 ? v : i % 3 === 1 ? v * 2 : 0)),
				),
			);
			await expect(unmixChunk(k, plan, new Float32Array(), 32)).rejects.toThrow(/destroyed/);
			await expect(
				prepareSpectralUnmixing(k, ["a"], { ...reference, matrix: [0] }, 32),
			).rejects.toThrow(/unsafe/);
			expect(Math.max(...created.map((b) => b.size))).toBeLessThanOrEqual(32);
			expect(created.every((b) => b.destroyed.mock.calls.length === 1)).toBe(true);
			expect(await k.device.popErrorScope()).toBeNull();
		} finally {
			spy.mockRestore();
		}
	});
	it("supports 128 detectors/fluorochromes with persistent matrices larger than event windows", async () => {
		const detectors = Array.from({ length: 128 }, (_, i) => `D${i}`);
		const fluorochromes = Array.from({ length: 128 }, (_, i) => `F${i}`);
		const matrix = new Float32Array(128 * 128);
		for (let i = 0; i < 128; i++) matrix[i * 128 + i] = 0.5;
		const plan = await prepareSpectralUnmixing(
			k,
			detectors,
			{ detectors, fluorochromes, matrix },
			65536,
		);
		try {
			const input = new Float32Array(256).fill(-3);
			expect(await unmixChunk(k, plan, input, 1024)).toEqual(
				Float32Array.from({ length: 512 }, (_, i) => (i % 256 < 128 ? -3 : -6)),
			);
			await expect(unmixChunk(k, plan, input, 1020)).rejects.toThrow(/row exceeds/);
		} finally {
			plan.destroy();
		}
	}, 30000);
	it("caps complete-row windows by dispatch limits as well as buffer limits", async () => {
		// Restrict the advertised dispatch ceiling without altering the actual device.
		const device = new Proxy(k.device, {
			get(target, property) {
				if (property === "limits")
					return {
						maxComputeWorkgroupsPerDimension: 1,
						maxStorageBufferBindingSize: target.limits.maxStorageBufferBindingSize,
						maxBufferSize: target.limits.maxBufferSize,
					};
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const limited = new Kernels(device);
		const plan = await prepareSpectralUnmixing(
			limited,
			["a"],
			{ detectors: ["a"], fluorochromes: ["x"], matrix: [1] },
			65536,
		);
		const sizes: number[] = [];
		const create = k.device.createBuffer.bind(k.device);
		const spy = vi.spyOn(k.device, "createBuffer").mockImplementation((desc) => {
			sizes.push(desc.size);
			return create(desc);
		});
		try {
			expect(await unmixChunk(limited, plan, new Float32Array(137).fill(7), 65536)).toEqual(
				new Float32Array(274).fill(7),
			);
			expect(Math.max(...sizes)).toBe(64 * 2 * 4);
		} finally {
			plan.destroy();
			spy.mockRestore();
		}
	});
});
