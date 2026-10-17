import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Kernels } from "../src/kernels.js";
import {
	EmptyMedianSelectionError,
	type MedianChunk,
	MedianNumericalError,
	summarizeMedians,
} from "../src/median.js";
import { getDevice, releaseDevice } from "./setup.js";

let k: Kernels;
beforeAll(async () => {
	k = new Kernels((await getDevice()).device);
}, 30_000);
afterAll(() => releaseDevice());
const source = (chunk: MedianChunk) =>
	async function* () {
		yield chunk;
	};

// Independent test-only CPU sort of explicitly selected rows, not a GPU rank implementation.
function oracle(data: Float32Array, stride: number, targets: number[], selected: number[]) {
	const ordered = targets.map((column) =>
		selected
			.map((row) => {
				const value = data[row * stride + column] as number;
				return value === 0 ? 0 : value;
			})
			.sort((a, b) => a - b),
	);
	return {
		count: selected.length,
		lower: ordered.map((values) => values[Math.floor((selected.length - 1) / 2)]),
		upper: ordered.map((values) => values[Math.floor(selected.length / 2)]),
	};
}

describe("bounded median ranks with borrowed membership masks", () => {
	it.each([3, 4])(
		"sorts holes and arbitrary nonzero membership for %i selected rows",
		async (count) => {
			const data = new Float32Array([8, -5, 999, 999, -4, 7, 999, 999, 2, 1, 999, 999, 12, -9]);
			const mask = new Uint32Array([1, 0, 2, 0, 0xffffffff, 0, count === 4 ? 0x80000000 : 0]);
			const result = await summarizeMedians(k, ["A", "B"], ["B", "A"], source({ data, mask }), 16);
			expect(result).toMatchObject(oracle(data, 2, [1, 0], count === 4 ? [0, 2, 4, 6] : [0, 2, 4]));
			expect(result.diagnostics).toMatchObject({
				sourceRows: 7,
				passCount: 4,
				precision: "exact-f32-rank-endpoints",
			});
		},
	);
	it("preserves subnormal endpoints and canonical positive zero through masked bit ordering", async () => {
		const tiny = 2 ** -149;
		const data = new Float32Array([99, -tiny, tiny, -0, 0, -99]);
		const endpoints = await summarizeMedians(
			k,
			["A"],
			["A"],
			source({ data, mask: new Uint32Array([0, 2, 3, 0, 0, 0]) }),
			4,
		);
		expect(endpoints).toMatchObject({ count: 2, lower: [-tiny], upper: [tiny] });
		const zeros = await summarizeMedians(
			k,
			["A"],
			["A"],
			source({ data, mask: new Uint32Array([0, 1, 1, 1, 1, 0]) }),
			4,
		);
		expect(zeros).toMatchObject({ count: 4, lower: [0], upper: [0] });
		expect(Object.is(zeros.lower[0], -0) || Object.is(zeros.upper[0], -0)).toBe(false);
	});
	it("ANDs masks/ranges with offset views, empty chunks and different replay boundaries", async () => {
		const data = new Float32Array(100003 + 513 * 3).subarray(100003);
		const mask = new Uint32Array(12289 + 513).subarray(12289);
		for (let row = 0; row < 513; row++) {
			data.set([((row * 71) % 97) - 48, Math.sin(row) * 10, row % 7], row * 3);
			mask[row] = row % 5 === 0 ? 0 : row % 2 === 0 ? 0x80000000 : 17;
		}
		const beforeData = data.slice(),
			beforeMask = mask.slice(),
			passes: number[] = [];
		const replay = async function* (pass: number): AsyncIterable<MedianChunk> {
			passes.push(pass);
			yield { data: data.subarray(0, 0), mask: mask.subarray(0, 0) };
			yield new Float32Array();
			const step = (pass + 1) * 31;
			for (let first = 0; first < 513; first += step) {
				const last = Math.min(first + step, 513);
				yield { data: data.subarray(first * 3, last * 3), mask: mask.subarray(first, last) };
			}
		};
		const selected = Array.from({ length: 513 }, (_, row) => row).filter(
			(row) => mask[row] !== 0 && row % 7 >= 2 && row % 7 <= 5,
		);
		const allocations: Array<{ label: string; size: number }> = [];
		const create = k.device.createBuffer.bind(k.device);
		const spy = vi.spyOn(k.device, "createBuffer").mockImplementation((descriptor) => {
			if (descriptor.label === "median.mask" || descriptor.label === "median.input")
				allocations.push({ label: descriptor.label, size: descriptor.size });
			return create(descriptor);
		});
		try {
			const result = await summarizeMedians(k, ["A", "B", "F"], ["B", "A"], replay, 252, {
				selection: [{ channel: "F", min: 2, max: 5 }],
			});
			expect(result).toMatchObject(oracle(data, 3, [1, 0], selected));
			expect(passes).toEqual([0, 1, 2, 3]);
			expect(result.diagnostics.sourceRows).toBe(513);
			expect(data).toEqual(beforeData);
			expect(mask).toEqual(beforeMask);
			expect(Math.max(...allocations.map(({ size }) => size))).toBeLessThanOrEqual(252);
			expect(
				Math.max(
					...allocations.filter(({ label }) => label === "median.mask").map(({ size }) => size),
				),
			).toBeLessThanOrEqual(84);
		} finally {
			spy.mockRestore();
		}
	});
	it("allows mixed masked/plain chunks and changes in representation across replay", async () => {
		const replay = async function* (pass: number): AsyncIterable<MedianChunk> {
			if (pass % 2) {
				yield {
					data: new Float32Array([9, 500, 2, 6, -1]),
					mask: new Uint32Array([1, 0, 1, 1, 7]),
				};
			} else {
				yield { data: new Float32Array([9, 500]), mask: new Uint32Array([1, 0]) };
				yield new Float32Array([2, 6]);
				yield { data: new Float32Array([-1]), mask: new Uint32Array([7]) };
			}
		};
		expect(await summarizeMedians(k, ["A"], ["A"], replay, 8)).toMatchObject({
			count: 4,
			lower: [2],
			upper: [6],
			diagnostics: { sourceRows: 5 },
		});
	});
	it.each([NaN, Infinity, -Infinity])(
		"ignores masked-out %s targets but rejects them when selected",
		async (value) => {
			const data = new Float32Array([value, 2, 8]);
			expect(
				await summarizeMedians(
					k,
					["A"],
					["A"],
					source({ data, mask: new Uint32Array([0, 2, 9]) }),
					4,
				),
			).toMatchObject({ count: 2, lower: [2], upper: [8] });
			await expect(
				summarizeMedians(k, ["A"], ["A"], source({ data, mask: new Uint32Array([1, 2, 9]) }), 4),
			).rejects.toBeInstanceOf(MedianNumericalError);
		},
	);
	it("applies ranges before nonfinite target rejection and rejects an empty masked population", async () => {
		const data = new Float32Array([NaN, 0, 4, 1, 12, 2, Infinity, 3, 100, 1]);
		expect(
			await summarizeMedians(
				k,
				["A", "F"],
				["A"],
				source({ data, mask: new Uint32Array([1, 3, 7, 1, 0]) }),
				16,
				{
					selection: [{ channel: "F", min: 1, max: 2 }],
				},
			),
		).toMatchObject({ count: 2, lower: [4], upper: [12] });
		await expect(
			summarizeMedians(
				k,
				["A"],
				["A"],
				source({ data: new Float32Array([1, 2]), mask: new Uint32Array(2) }),
				8,
			),
		).rejects.toBeInstanceOf(EmptyMedianSelectionError);
		await expect(
			summarizeMedians(
				k,
				["A"],
				["A"],
				source({ data: new Float32Array(), mask: new Uint32Array() }),
				4,
			),
		).rejects.toBeInstanceOf(EmptyMedianSelectionError);
	});
	it("retains replay count checks and the source u32 ceiling for masked sources", async () => {
		await expect(
			summarizeMedians(
				k,
				["A"],
				["A"],
				async function* (pass) {
					yield { data: new Float32Array([1, 2]), mask: new Uint32Array([1, pass ? 1 : 0]) };
				},
				8,
			),
		).rejects.toThrow(/replay row\/selected counts changed/);
		const data = new Float32Array(),
			mask = new Uint32Array();
		Object.defineProperty(data, "length", { value: 0x100000000 });
		Object.defineProperty(mask, "length", { value: 0x100000000 });
		await expect(summarizeMedians(k, ["A"], ["A"], source({ data, mask }), 4)).rejects.toThrow(
			/u32/,
		);
	});
	it.each([
		["non-F32 data", { data: new Float64Array(2), mask: new Uint32Array(1) }],
		["incomplete row", { data: new Float32Array(3), mask: new Uint32Array(1) }],
		["signed mask", { data: new Float32Array(2), mask: new Int32Array(1) }],
		["missing mask", { data: new Float32Array(2) }],
		["short mask", { data: new Float32Array(4), mask: new Uint32Array(1) }],
		["long mask", { data: new Float32Array(2), mask: new Uint32Array(2) }],
		["nonempty mask for empty data", { data: new Float32Array(), mask: new Uint32Array(1) }],
		["null chunk", null],
	])("rejects %s and closes its iterator", async (_, invalid) => {
		let closed = 0;
		const replay = async function* () {
			try {
				yield invalid as MedianChunk;
			} finally {
				closed++;
			}
		};
		await expect(summarizeMedians(k, ["A", "B"], ["A"], replay, 16)).rejects.toThrow(
			/Median (input|mask)/,
		);
		expect(closed).toBe(1);
	});
	it.each(["allocation", "dispatch", "abort", "source"])(
		"drains and releases every owned buffer after %s failure",
		async (mode) => {
			const injected = new Error(`injected ${mode}`),
				controller = new AbortController();
			let drains = 0,
				closed = 0;
			const destroyedAfterDrain: boolean[] = [];
			const destroyed: Array<ReturnType<typeof vi.spyOn>> = [];
			const create = k.device.createBuffer.bind(k.device);
			const wait = k.device.queue.onSubmittedWorkDone.bind(k.device.queue);
			const drainSpy = vi
				.spyOn(k.device.queue, "onSubmittedWorkDone")
				.mockImplementation(async () => {
					await wait();
					drains++;
				});
			const createSpy = vi.spyOn(k.device, "createBuffer").mockImplementation((descriptor) => {
				if (mode === "allocation" && descriptor.label === "median.mask") throw injected;
				const buffer = create(descriptor),
					destroy = buffer.destroy.bind(buffer);
				destroyed.push(
					vi.spyOn(buffer, "destroy").mockImplementation(() => {
						destroyedAfterDrain.push(drains > 0);
						destroy();
					}),
				);
				return buffer;
			});
			const get = k.get.bind(k);
			const pipelineSpy = vi.spyOn(k, "get").mockImplementation((name) => {
				if (mode === "dispatch" && name === "median_histogram") throw injected;
				return get(name);
			});
			const replay = async function* () {
				try {
					yield { data: new Float32Array([1, 4, 2, 9]), mask: new Uint32Array([1, 2]) };
					if (mode === "abort") controller.abort(injected);
					if (mode === "source") throw injected;
					yield { data: new Float32Array([3, 5]), mask: new Uint32Array([1]) };
				} finally {
					closed++;
				}
			};
			try {
				await expect(
					summarizeMedians(k, ["A", "B"], ["A"], replay, 16, { signal: controller.signal }),
				).rejects.toBe(injected);
				expect(closed).toBe(1);
				expect(destroyed.length).toBeGreaterThan(0);
				expect(destroyed.every((spy) => spy.mock.calls.length === 1)).toBe(true);
				expect(destroyedAfterDrain.every(Boolean)).toBe(true);
				expect(drains).toBeGreaterThan(0);
			} finally {
				pipelineSpy.mockRestore();
				createSpy.mockRestore();
				drainSpy.mockRestore();
				for (const spy of destroyed) spy.mockRestore();
			}
		},
	);
});
