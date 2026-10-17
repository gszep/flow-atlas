import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Kernels } from "../src/kernels.js";
import {
	EmptyMedianSelectionError,
	MedianNumericalError,
	summarizeMedians,
} from "../src/median.js";
import { getDevice, releaseDevice } from "./setup.js";

let k: Kernels;
beforeAll(async () => {
	k = new Kernels((await getDevice()).device);
}, 30_000);
afterAll(() => releaseDevice());
const source = (data: Float32Array) =>
	async function* () {
		yield data;
	};
describe("bounded GPU exact-rank medians", () => {
	it.each([
		[3, -1, 7],
		[9, -9, 2, 3],
		[0, -0, 0, -0],
		[8, 8, 8],
		[-3e38, 3e38],
		[2 ** -149, -(2 ** -149), 2 ** -126, -(2 ** -126)],
	])("selects exact odd/even signed/tied/zero/subnormal endpoints: %j", async (...values) => {
		const data = new Float32Array(values),
			sorted = Array.from(data)
				.sort((a, b) => a - b)
				.map((v) => (v === 0 ? 0 : v));
		const result = await summarizeMedians(k, ["A"], ["A"], source(data), 8);
		expect(result.lower).toEqual([sorted[Math.floor((data.length - 1) / 2)]]);
		expect(result.upper).toEqual([sorted[Math.floor(data.length / 2)]]);
		expect(JSON.parse(JSON.stringify(result))).toEqual(result);
		expect(
			[result, result.channels, result.lower, result.upper, result.diagnostics].every(
				Object.isFrozen,
			),
		).toBe(true);
	});
	it("matches CPU-sort oracle across targets, large byte offsets, windows and differing replay chunks", async () => {
		const storage = new Float32Array(100000 + 513 * 3),
			data = storage.subarray(100000);
		for (let i = 0; i < 513; i++) data.set([Math.sin(i) * 100, ((i * 73) % 29) - 9, i], i * 3);
		const before = data.slice(),
			passes: number[] = [];
		const replay = async function* (pass: number) {
			passes.push(pass);
			const step = (pass + 1) * 37 * 3;
			for (let i = 0; i < data.length; i += step) yield data.subarray(i, i + step);
		};
		const result = await summarizeMedians(k, ["A", "B", "C"], ["B", "A"], replay, 252);
		const sorted = [1, 0].map((c) =>
			Array.from({ length: 513 }, (_, r) => data[r * 3 + c] as number).sort((a, b) => a - b),
		);
		expect(result.lower).toEqual(sorted.map((a) => a[256]));
		expect(result.upper).toEqual(result.lower);
		expect(passes).toEqual([0, 1, 2, 3]);
		expect(data).toEqual(before);
	});
	it("ANDs inclusive named ranges, excludes nonfinite filter values, preserves subnormal bounds", async () => {
		const data = new Float32Array([
			NaN,
			NaN,
			0,
			2,
			-1,
			1,
			8,
			1,
			1,
			99,
			2,
			0,
			4,
			0,
			1,
			Infinity,
			Infinity,
			1,
		]);
		const result = await summarizeMedians(k, ["T", "F", "G"], ["T"], source(data), 12, {
			selection: [
				{ channel: "F", min: -1, max: 1 },
				{ channel: "G", min: 1, max: null },
			],
		});
		expect([result.count, ...result.lower, ...result.upper]).toEqual([3, 4, 4]);
		const tiny = new Float32Array([-(2 ** -149), 0, 2 ** -149]);
		expect(
			(
				await summarizeMedians(k, ["A"], ["A"], source(tiny), 4, {
					selection: [{ channel: "A", min: 2 ** -149, max: 2 ** -149 }],
				})
			).lower,
		).toEqual([2 ** -149]);
	});
	it("rejects selected nonfinite targets and empty populations with typed errors", async () => {
		for (const v of [NaN, Infinity, -Infinity])
			await expect(
				summarizeMedians(k, ["A"], ["A"], source(new Float32Array([v])), 4),
			).rejects.toBeInstanceOf(MedianNumericalError);
		await expect(
			summarizeMedians(k, ["A"], ["A"], source(new Float32Array()), 4),
		).rejects.toBeInstanceOf(EmptyMedianSelectionError);
		await expect(
			summarizeMedians(k, ["A"], ["A"], source(new Float32Array([1])), 4, {
				selection: [{ channel: "A", min: 2, max: null }],
			}),
		).rejects.toBeInstanceOf(EmptyMedianSelectionError);
	});
	it("detects replay row and selected-count mismatches", async () => {
		await expect(
			summarizeMedians(
				k,
				["A"],
				["A"],
				async function* (p) {
					yield new Float32Array(p ? [1, 2] : [1]);
				},
				8,
			),
		).rejects.toThrow(/replay/);
		await expect(
			summarizeMedians(
				k,
				["A"],
				["A"],
				async function* (p) {
					yield new Float32Array(p ? [1, 2] : [1, -2]);
				},
				8,
				{ selection: [{ channel: "A", min: 0, max: null }] },
			),
		).rejects.toThrow(/replay/);
	});
	it("validates names, shapes, ranges, budgets and channel ceilings", async () => {
		const empty = source(new Float32Array());
		for (const [names, targets] of [
			[[], ["A"]],
			[["A", "A"], ["A"]],
			[[""], [""]],
			[["A"], []],
			[["A"], ["B"]],
			[["A"], ["A", "A"]],
			[Array.from({ length: 4097 }, (_, i) => `${i}`), ["0"]],
			[
				Array.from({ length: 129 }, (_, i) => `${i}`),
				Array.from({ length: 129 }, (_, i) => `${i}`),
			],
		])
			await expect(
				summarizeMedians(k, names as string[], targets as string[], empty, 16384),
			).rejects.toThrow();
		for (const selection of [
			[{ channel: "B", min: null, max: null }],
			[{ channel: "A", min: 2, max: 1 }],
			[{ channel: "A", min: 0.1, max: null }],
			[{ channel: "A", min: Infinity, max: null }],
			Array.from({ length: 17 }, (_, i) => ({ channel: `${i}`, min: null, max: null })),
			[
				{ channel: "A", min: null, max: null },
				{ channel: "A", min: null, max: null },
			],
		])
			await expect(summarizeMedians(k, ["A"], ["A"], empty, 4, { selection })).rejects.toThrow();
		for (const budget of [0, 3, 4.5, NaN])
			await expect(summarizeMedians(k, ["A"], ["A"], empty, budget)).rejects.toThrow();
		await expect(
			summarizeMedians(k, ["A", "B"], ["A"], source(new Float32Array(3)), 8),
		).rejects.toThrow(/complete/);
		await expect(summarizeMedians(k, ["A", "B"], ["A"], empty, 4)).rejects.toThrow(/row/);
		const names = Array.from({ length: 4096 }, (_, i) => `${i}`),
			targets = names.slice(0, 128);
		expect(
			(await summarizeMedians(k, names, targets, source(new Float32Array(4096).fill(7)), 16384))
				.lower,
		).toEqual(Array(128).fill(7));
	});
	it("snapshots metadata and enforces the u32 ceiling before upload", async () => {
		const names = ["A"],
			targets = ["A"],
			selection = [{ channel: "A", min: 1, max: 2 }];
		const replay = async function* () {
			names[0] = "changed";
			targets[0] = "changed";
			selection.length = 0;
			yield new Float32Array([0, 1, 2, 3]);
		};
		const result = await summarizeMedians(k, names, targets, replay, 16, { selection });
		expect([result.channels, result.lower, result.upper, result.count]).toEqual([
			["A"],
			[1],
			[2],
			2,
		]);
		// Spoof only metadata to exercise the guard without allocating 16 GiB.
		const oversized = new Float32Array();
		Object.defineProperty(oversized, "length", { value: 0x100000000 });
		await expect(summarizeMedians(k, ["A"], ["A"], source(oversized), 4)).rejects.toThrow(/u32/);
	});
	it("drains and cleans owned buffers; closes iterators on abort, invalid data and source failure", async () => {
		const created: Array<{ size: number; destroy: ReturnType<typeof vi.spyOn> }> = [];
		const create = k.device.createBuffer.bind(k.device);
		const spy = vi.spyOn(k.device, "createBuffer").mockImplementation((desc) => {
			const b = create(desc);
			created.push({ size: b.size, destroy: vi.spyOn(b, "destroy") });
			return b;
		});
		try {
			let closed = 0;
			const controller = new AbortController();
			const aborting = async function* () {
				try {
					yield new Float32Array([1]);
					controller.abort();
					yield new Float32Array([2]);
				} finally {
					closed++;
				}
			};
			await expect(
				summarizeMedians(k, ["A"], ["A"], aborting, 4, { signal: controller.signal }),
			).rejects.toThrow();
			const failing = async function* () {
				try {
					yield new Float32Array([1]);
					throw new Error("source failure");
				} finally {
					closed++;
				}
			};
			await expect(summarizeMedians(k, ["A"], ["A"], failing, 4)).rejects.toThrow(/source failure/);
			const invalid = async function* () {
				try {
					yield new Float32Array(3);
				} finally {
					closed++;
				}
			};
			await expect(summarizeMedians(k, ["A", "B"], ["A"], invalid, 8)).rejects.toThrow(/complete/);
			await summarizeMedians(k, ["A"], ["A"], source(new Float32Array(10000).fill(1)), 4096);
			await expect(
				summarizeMedians(new Kernels(k.device, {}), ["A"], ["A"], source(new Float32Array([1])), 4),
			).rejects.toThrow(/unknown kernel/);
			expect(closed).toBe(3);
			expect(created.every((b) => b.destroy.mock.calls.length === 1)).toBe(true);
			expect(Math.max(...created.map((b) => b.size))).toBeLessThanOrEqual(4096);
		} finally {
			spy.mockRestore();
		}
	});
});
