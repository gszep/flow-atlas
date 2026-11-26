import { describe, expect, it } from "vitest";
import {
	hasKnownReferenceCoverage,
	type ReferenceCoverageSample,
	referenceCoverage,
	referencedPopulationIndices,
} from "../src/reference-coverage.js";
import type { SelectionSpec } from "../src/selection-engine.js";

const sample = (count: number, gateCount: number | null = 3): ReferenceCoverageSample => ({
	count,
	skippedGateCount: 0,
	gateCounts: [{ name: "T cells", count: gateCount, isLeaf: true }],
});

describe("reference coverage", () => {
	it("sums evaluated leaf counts for eligible samples once, ignoring empty samples", () => {
		const samples = [sample(10, 3), sample(20, 7), { ...sample(0), skippedGateCount: null }];
		expect(referenceCoverage(samples, "T cells")).toBe(10);
		expect(referenceCoverage(samples, "T cells", [1, 1, 2])).toBe(7);
		expect(referenceCoverage(samples, "T cells", [])).toBe(0);
		expect(referenceCoverage(samples, "T cells", [3])).toBeNull();
	});

	it("rejects skipped or unevaluated gates, missing and ambiguous names, non-leaves and null counts", () => {
		const good = sample(10);
		const unknown: ReferenceCoverageSample[] = [
			{ ...good, skippedGateCount: 1 },
			{ ...good, skippedGateCount: null },
			{ ...good, gateCounts: [] },
			{ ...good, gateCounts: [{ name: "T cells", count: 3, isLeaf: false }] },
			{ ...good, gateCounts: [...good.gateCounts, ...good.gateCounts] },
			{ ...good, gateCounts: [...good.gateCounts, { name: "T cells", count: 2, isLeaf: false }] },
			sample(10, null),
		];
		for (const candidate of unknown) expect(referenceCoverage([candidate], "T cells")).toBeNull();
		expect(referenceCoverage([good, ...unknown], "T cells", [0])).toBe(3);
	});

	it("finds nested references and checks each against externally supplied eligibility", () => {
		const source: SelectionSpec = {
			kind: "union",
			selections: [
				{
					kind: "intersection",
					selections: [{ kind: "reference", population: 0 }, { kind: "all" }],
				},
				{
					kind: "intersection",
					selections: [
						{ kind: "reference", population: 1 },
						{ kind: "reference", population: 0 },
					],
				},
			],
		};
		const first = {
			...sample(10),
			gateCounts: [...sample(10).gateCounts, { name: "B cells", count: 2, isLeaf: true }],
		};
		const samples = [first, { ...sample(10), skippedGateCount: 1 }];
		expect(referencedPopulationIndices(source)).toEqual([0, 1]);
		expect(hasKnownReferenceCoverage(source, ["T cells", "B cells"], samples, [0])).toBe(true);
		expect(hasKnownReferenceCoverage(source, ["T cells", "B cells"], samples)).toBe(false);
		expect(hasKnownReferenceCoverage(source, ["T cells"], samples, [0])).toBe(false);
		expect(hasKnownReferenceCoverage({ kind: "all" }, [], samples)).toBe(true);
	});
});
