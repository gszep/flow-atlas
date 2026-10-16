import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	CompensationNumericalError,
	compensateChunk,
	prepareCompensation,
} from "../src/compensation.js";
import { Kernels } from "../src/kernels.js";
import { getDevice, releaseDevice } from "./setup.js";

afterAll(() => releaseDevice());
let k: Kernels;
beforeAll(async () => {
	k = new Kernels((await getDevice()).device);
}, 30_000);
// CPU forward mixture is a TEST reference only, never a runtime fallback.
function mix(truth: number[], matrix: number[], n: number): Float32Array {
	return Float32Array.from(truth, (_, i) => {
		let v = 0;
		for (let j = 0; j < n; j++)
			v += (truth[Math.floor(i / n) * n + j] as number) * (matrix[j * n + (i % n)] as number);
		return v;
	});
}
describe("GPU conventional fluorescence compensation", () => {
	it("supports the 128-channel ceiling and concurrent independent chunks", async () => {
		const n = 128;
		const channels = Array.from({ length: n }, (_, i) => `${i}`);
		const matrix = new Float32Array(n * n);
		for (let i = 0; i < n; i++) matrix[i * n + i] = 0.5;
		const plan = await prepareCompensation(k, channels, { channels, matrix }, 65536);
		try {
			const results = await Promise.all(
				[1, -3].map((v) => compensateChunk(k, plan, new Float32Array(n).fill(v), 65536)),
			);
			expect(results).toEqual([new Float32Array(n).fill(2), new Float32Array(n).fill(-6)]);
			await expect(compensateChunk(k, plan, new Float32Array(n), 65532)).rejects.toThrow(/limit/);
		} finally {
			plan.destroy();
		}
	}, 15000);
	it.each([
		[2, [1, 0.2, 0.7, 1]],
		[3, [1, 0.1, 0.2, 0.3, 1, 0.4, 0.05, 0.2, 1]],
		[2, [0, 1, 1, 0.2]], // actual row pivot required
	] as const)(
		"recovers asymmetric %i-channel row mixtures without a transpose",
		async (n, source) => {
			const matrix = [...source];
			const channels = Array.from({ length: n }, (_, i) => `C${i}`);
			const truth = Array.from({ length: n * 137 }, (_, i) => ((i % 7) - 3) * 16000 + i / 10);
			const recorded = mix(truth, matrix, n),
				before = recorded.slice();
			const plan = await prepareCompensation(k, channels, { channels, matrix }, 64);
			try {
				const actual = await compensateChunk(k, plan, recorded, 64);
				const error = Math.max(...actual.map((v, i) => Math.abs(v - (truth[i] as number))));
				expect(error).toBeLessThan(0.03);
				expect(recorded).toEqual(before);
				expect(await compensateChunk(k, plan, recorded, 64)).toEqual(actual);
				expect(plan.diagnostics).toMatchObject({
					source: "gpu-computation",
					status: 0,
					numericalErrors: 0,
				});
				expect(JSON.parse(JSON.stringify(plan.diagnostics))).toEqual(plan.diagnostics);
			} finally {
				plan.destroy();
			}
		},
	);
	it("maps exact reordered subsets, preserves nonparticipating bits, immutable snapshot and empty output", async () => {
		const channels = ["B", "A"],
			matrix = [1, 0.5, 0.25, 1];
		const plan = await prepareCompensation(k, ["A", "FSC", "B"], { channels, matrix }, 32);
		channels.reverse();
		matrix.fill(0);
		try {
			expect(plan.channelIndices).toEqual([2, 0]);
			expect(
				Object.isFrozen(plan) &&
					Object.isFrozen(plan.channelIndices) &&
					Object.isFrozen(plan.diagnostics),
			).toBe(true);
			const input = new Float32Array([8, 0, 5.5]); // true B=4, A=6
			new Uint32Array(input.buffer)[1] = 0x7fc00123;
			const result = await compensateChunk(k, plan, input, 32);
			expect(result[0]).toBeCloseTo(6, 5);
			expect(result[2]).toBeCloseTo(4, 5);
			expect(new Uint32Array(result.buffer)[1]).toBe(0x7fc00123);
			const empty = new Float32Array();
			expect(await compensateChunk(k, plan, empty, 32)).not.toBe(empty);
			await expect(compensateChunk(k, plan, new Float32Array(2), 32)).rejects.toThrow(/complete/);
			await expect(compensateChunk({ device: {} } as Kernels, plan, empty, 32)).rejects.toThrow(
				/another/,
			);
		} finally {
			plan.destroy();
			plan.destroy();
		}
		await expect(compensateChunk(k, plan, new Float32Array(), 32)).rejects.toThrow(/destroyed/);
	});
	it.each([
		[[1, 1, 1, 1], 1],
		[[1, 0, 0, 0.000001], 3],
		[[1, 1, 1, 1.0000001], 3],
	] as const)(
		"rejects singular/ill-conditioned matrices with compute diagnostics %j",
		async (matrix, status) => {
			try {
				await prepareCompensation(k, ["A", "B"], { channels: ["A", "B"], matrix }, 64);
				throw new Error("accepted");
			} catch (e) {
				expect(e).toBeInstanceOf(CompensationNumericalError);
				expect((e as CompensationNumericalError).diagnostics).toMatchObject({
					status,
					numericalErrors: 1,
				});
			}
		},
	);
	it("rejects invalid shapes, exact names, size limits and non-f32 metadata before GPU allocation", async () => {
		const spy = vi.spyOn(k.device, "createBuffer");
		try {
			const cases = [
				{ names: ["A"], channels: ["A"], matrix: [1, 2] },
				{ names: ["A", "A"], channels: ["A"], matrix: [1] },
				{ names: ["A"], channels: ["A", "A"], matrix: [1, 0, 0, 1] },
				{ names: ["A"], channels: ["a"], matrix: [1] },
				{ names: [""], channels: [""], matrix: [1] },
				{ names: ["A"], channels: [], matrix: [] },
				...Array.from([NaN, Infinity, 1e40, 1e-50, 1e-40], (v) => ({
					names: ["A"],
					channels: ["A"],
					matrix: [v],
				})),
			];
			for (const c of cases) await expect(prepareCompensation(k, c.names, c, 64)).rejects.toThrow();
			await expect(
				prepareCompensation(k, ["A"], { channels: ["A"], matrix: [1] }, NaN),
			).rejects.toThrow(/limit/);
			const channels = Array.from({ length: 129 }, (_, i) => `${i}`);
			await expect(prepareCompensation(k, channels, { channels, matrix: [] }, 64)).rejects.toThrow(
				/128/,
			);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
	it("bounds every buffer/window, cleans success and failures, and permits in-flight destroy", async () => {
		const created: Array<{ size: number; destroyed: ReturnType<typeof vi.spyOn> }> = [];
		const create = k.device.createBuffer.bind(k.device);
		const spy = vi.spyOn(k.device, "createBuffer").mockImplementation((desc) => {
			const b = create(desc);
			created.push({ size: b.size, destroyed: vi.spyOn(b, "destroy") });
			return b;
		});
		k.device.pushErrorScope("validation");
		try {
			const plan = await prepareCompensation(k, ["A"], { channels: ["A"], matrix: [0.5] }, 16);
			const broken = new Kernels(k.device, {});
			await expect(
				prepareCompensation(broken, ["A"], { channels: ["A"], matrix: [1] }, 16),
			).rejects.toThrow(/unknown kernel/);
			await expect(compensateChunk(broken, plan, new Float32Array([1]), 16)).rejects.toThrow(
				/unknown kernel/,
			);
			await expect(
				compensateChunk(k, plan, new Float32Array([Infinity, 3e38]), 16),
			).rejects.toMatchObject({ diagnostics: { status: 4, numericalErrors: 2 } });
			const pending = compensateChunk(k, plan, new Float32Array(53).fill(-100), 16);
			plan.destroy();
			plan.destroy();
			expect(await pending).toEqual(new Float32Array(53).fill(-200));
			await expect(
				prepareCompensation(k, ["A"], { channels: ["A"], matrix: [0] }, 16),
			).rejects.toThrow(/unsafe/);
			expect(Math.max(...created.map((b) => b.size))).toBeLessThanOrEqual(16);
			expect(created.every((b) => b.destroyed.mock.calls.length === 1)).toBe(true);
			expect(await k.device.popErrorScope()).toBeNull();
		} finally {
			spy.mockRestore();
		}
	});
});
