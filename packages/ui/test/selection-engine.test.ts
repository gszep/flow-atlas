import { afterAll, expect, it } from "vitest";
import { createStorage, readback, upload } from "../../compute/src/buffers.js";
import { getDevice, releaseDevice } from "../../compute/test/setup.js";
import {
	SelectionEngine,
	type SelectionSpec,
	validateSelectionSpec,
} from "../src/selection-engine.js";

afterAll(() => releaseDevice());

it("validates bounded finite embedding polygons and unique inclusive display ranges", () => {
	const invalid: SelectionSpec[] = [
		{
			kind: "polygon",
			points: [
				{ x: 0, y: 0 },
				{ x: 1, y: 1 },
			],
		},
		{ kind: "polygon", points: Array.from({ length: 129 }, () => ({ x: 0, y: 0 })) },
		{
			kind: "polygon",
			points: [
				{ x: 0, y: 0 },
				{ x: 1, y: 1 },
				{ x: NaN, y: 0 },
			],
		},
		{ kind: "ranges", ranges: [] },
		{ kind: "ranges", ranges: [{ channel: 0, min: 2, max: 1 }] },
		{ kind: "ranges", ranges: [{ channel: 0, min: null, max: Infinity }] },
		{ kind: "ranges", ranges: [{ channel: 2, min: null, max: null }] },
		{
			kind: "ranges",
			ranges: [
				{ channel: 0, min: 0, max: 1 },
				{ channel: 0, min: 0, max: 2 },
			],
		},
		{ kind: "reference", population: -1 },
		{ kind: "reference", population: 34 },
	];
	expect(
		invalid.map((spec) => {
			try {
				validateSelectionSpec(spec, 2, 34);
				return false;
			} catch {
				return true;
			}
		}),
	).toEqual(invalid.map(() => true));
	expect(() =>
		validateSelectionSpec(
			{ kind: "ranges", ranges: [{ channel: 1, min: null, max: null }] },
			2,
			34,
		),
	).not.toThrow();
});

it("GPU selections cover bounded windows, nested label words, missing values, polygon edges and immutable colors", async () => {
	const { device } = await getDevice();
	device.pushErrorScope("validation");
	const n = 65539,
		tail = n - 1;
	const a = new Float32Array(n).fill(NaN),
		b = new Float32Array(n).fill(NaN);
	const positions = new Float32Array(n * 2).fill(NaN),
		labels = new Uint32Array(n * 2);
	a.set([-4, -2, 0, 2, Infinity, -Infinity]);
	b.set([10, NaN, 30, 40, 50, -Infinity]);
	positions.set([0, 0, 1, 0, 1, 1, 2, 2, 0.5, 0.5, Infinity, 0]);
	a[tail] = 4;
	b[tail] = 60;
	positions[tail * 2] = 0;
	positions[tail * 2 + 1] = 1;
	// Population 33 crosses a word boundary and overlaps its parent population 0.
	for (const i of [0, 1, tail]) {
		labels[i * 2] = 1;
		labels[i * 2 + 1] = 2;
	}
	labels[2 * 2] = 1;
	labels[5 * 2 + 1] = 4; // population 34 contains only nonfinite channel values
	const colors = new Uint32Array(n).fill(0x80445566);
	colors[1] = 0x00112233;
	const buffers = [
		upload(device, a),
		upload(device, b),
		upload(device, positions),
		upload(device, labels),
		upload(device, colors),
		createStorage(device, n * 4),
	];
	try {
		const [columnA, columnB, embedding, labelBuffer, source, target] = buffers as [
			GPUBuffer,
			GPUBuffer,
			GPUBuffer,
			GPUBuffer,
			GPUBuffer,
			GPUBuffer,
		];
		const ws = {
			n,
			words: 2,
			channels: ["A", "B (missing in one sample)"],
			channelBuffers: [columnA, columnB],
			embedding,
			labels: labelBuffer,
			populations: Array.from({ length: 35 }, (_, i) => `Population ${i}`),
		};
		const engine = new SelectionEngine(device, ws, 128 * 1024 ** 2);
		const reference: SelectionSpec = { kind: "reference", population: 33 };
		const analysis = await engine.analyze(reference);
		expect(analysis.count).toBe(3);
		expect(analysis.total).toBe(n);
		expect(
			analysis.channels.map(
				({ name, finiteCount, missingCount, min, max, domain, approximateMedian, bins }) => ({
					name,
					finiteCount,
					missingCount,
					min,
					max,
					domain,
					approximateMedian,
					sum: bins.reduce((sum, value) => sum + value, 0),
				}),
			),
		).toEqual([
			{
				name: "A",
				finiteCount: 3,
				missingCount: 0,
				min: -4,
				max: 4,
				domain: "display-transformed",
				approximateMedian: true,
				sum: 3,
			},
			{
				name: "B (missing in one sample)",
				finiteCount: 2,
				missingCount: 1,
				min: 10,
				max: 60,
				domain: "display-transformed",
				approximateMedian: true,
				sum: 2,
			},
		]);
		expect(analysis.channels[0]?.median).toBeCloseTo(-2 + 8 / 256);
		expect(analysis.channels[1]?.median).toBe(35);
		expect(analysis.channels[0]?.bins).toHaveLength(128);
		expect((await engine.analyze({ kind: "reference", population: 0 })).count).toBe(4);
		const missing = await engine.analyze({ kind: "reference", population: 34 });
		expect(missing.count).toBe(1);
		expect(
			missing.channels.map(({ finiteCount, missingCount, min, max, median, bins }) => ({
				finiteCount,
				missingCount,
				min,
				max,
				median,
				sum: bins.reduce((sum, value) => sum + value, 0),
			})),
		).toEqual(
			Array.from({ length: 2 }, () => ({
				finiteCount: 0,
				missingCount: 1,
				min: null,
				max: null,
				median: null,
				sum: 0,
			})),
		);
		const ranges: SelectionSpec = {
			kind: "ranges",
			ranges: [
				{ channel: 0, min: -2, max: 4 },
				{ channel: 1, min: null, max: 40 },
			],
		};
		const ranged = await engine.analyze(ranges);
		expect(ranged.count).toBe(2);
		expect(ranged.channels.map(({ min, max, finiteCount }) => [min, max, finiteCount])).toEqual([
			[0, 2, 2],
			[30, 40, 2],
		]);
		const empty = await engine.analyze({
			kind: "ranges",
			ranges: [{ channel: 0, min: 100, max: null }],
		});
		expect(empty.count).toBe(0);
		expect(empty.channels.map(({ median }) => median)).toEqual([null, null]);
		// A deliberately smaller binding window exercises dynamic offsets independent of the dispatch cap.
		const bounded = new SelectionEngine(device, { ...ws, n: 257 }, 1024);
		const polygon: SelectionSpec = {
			kind: "polygon",
			points: [
				{ x: 0, y: 0 },
				{ x: 1, y: 0 },
				{ x: 1, y: 1 },
				{ x: 0, y: 1 },
			],
		};
		expect((await engine.analyze(polygon)).count).toBe(5);
		expect((await bounded.analyze(polygon)).count).toBe(4);
		await engine.highlight(reference, source, target);
		expect(await readback(device, source, Uint32Array)).toEqual(colors);
		const highlighted = await readback(device, target, Uint32Array);
		expect([highlighted[0], highlighted[1], highlighted[2], highlighted[tail]]).toEqual([
			0x8033aaff, 0x0033aaff, 0x80383838, 0x8033aaff,
		]);
		await expect(engine.highlight(reference, source, source)).rejects.toThrow("distinct target");
		await engine.highlight(reference, source, target, undefined, 0x00112233);
		const custom = await readback(device, target, Uint32Array, 12);
		expect([...custom]).toEqual([0x80112233, 0x00112233, 0x80383838]);
		const controller = new AbortController();
		controller.abort();
		await expect(engine.analyze(reference, { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		await expect(
			engine.highlight(reference, source, target, controller.signal),
		).rejects.toMatchObject({ name: "AbortError" });
		// Abort after an actual drained batch, then prove the serialized engine remains reusable.
		let checks = 0;
		const midFlight = {
			throwIfAborted() {
				if (++checks === 3) throw new DOMException("Cancelled", "AbortError");
			},
		} as AbortSignal;
		await expect(engine.analyze(reference, { signal: midFlight })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect((await engine.analyze(reference)).count).toBe(3);
	} finally {
		await device.queue.onSubmittedWorkDone().catch(() => {});
		for (const buffer of buffers) buffer.destroy();
		expect(await device.popErrorScope()).toBeNull();
	}
}, 30000);
