import { describe, expect, it } from "vitest";
import { copySelectedRows, planSystematicSample } from "../src/sampling.js";

const source = (eventCount: number, sampleId = "s") => ({
	eventCount,
	sampleId,
	basename: `${sampleId}.fcs`,
});

describe("quick-view event sampling", () => {
	it("selects global midpoints across file boundaries and empty files", () => {
		const result = planSystematicSample(
			[source(0, "empty"), source(3, "a"), source(7, "b"), source(0, "end")],
			4,
		);
		expect(result.indices).toEqual([[], [1], [0, 3, 5], []]);
		expect(result.summary.sourceEventCount).toBe(10);
		expect(result.summary.selectedEventCount).toBe(4);
		expect(
			result.summary.files.map((file) => [
				file.sourceOffset,
				file.selectedOffset,
				file.selectedEventCount,
			]),
		).toEqual([
			[0, 0, 0],
			[0, 0, 1],
			[3, 1, 3],
			[10, 4, 0],
		]);
	});
	it("selects exactly 100000 ordered distinct rows across the publication-sized source", () => {
		const input = [source(36948, "first"), source(3885530 - 36948, "last")];
		const first = planSystematicSample(input);
		const again = planSystematicSample(input);
		const global = first.indices.flatMap((indices, file) => {
			const offset = first.summary.files[file]?.sourceOffset;
			if (offset === undefined) throw new Error("Missing source provenance");
			return indices.map((index) => index + offset);
		});
		expect(first).toEqual(again);
		expect(global).toHaveLength(100000);
		expect(new Set(global).size).toBe(100000);
		expect(global.every((index, i) => i === 0 || index > (global[i - 1] as number))).toBe(true);
		expect(global[0]).toBe(19);
		expect(global.at(-1)).toBe(3885510);
		expect(first.indices.every((indices) => indices.length > 0)).toBe(true);
		expect(input.map((file) => file.eventCount)).toEqual([36948, 3848582]);
	});
	it("keeps all rows when below the cap and handles an empty source", () => {
		expect(planSystematicSample([source(3)], 4).indices).toEqual([[0, 1, 2]]);
		expect(planSystematicSample([]).summary.selectedEventCount).toBe(0);
		expect(planSystematicSample([source(0)]).indices).toEqual([[]]);
	});
	it("copies whole rows with channel alignment and without mutating the source", () => {
		const values = new Float32Array([0, 1, 2, 10, 11, 12, 20, 21, 22, 30, 31, 32]);
		const original = values.slice();
		const sampled = copySelectedRows(values, 3, [1, 3]);
		expect([...sampled]).toEqual([10, 11, 12, 30, 31, 32]);
		sampled[0] = 99;
		expect(values).toEqual(original);
	});
	it("rejects invalid selection and incomplete source rows", () => {
		expect(() => planSystematicSample([source(-1)])).toThrow();
		expect(() => planSystematicSample([source(2)], 0)).toThrow();
		expect(() => planSystematicSample([source(2)], 100001)).toThrow();
		expect(() => copySelectedRows(new Float32Array(5), 2, [0])).toThrow();
		expect(() => copySelectedRows(new Float32Array(6), 2, [2, 1])).toThrow();
		expect(() => copySelectedRows(new Float32Array(6), 2, [3])).toThrow();
	});
});
