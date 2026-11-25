import { describe, expect, it } from "vitest";
import type { SelectionSpec } from "../src/selection-engine.js";
import { scopeToSample, selectionSampleTotal, selectionScope } from "../src/selection-scope.js";

describe("sample selection snapshots", () => {
	it("preserves the source and records the selected sample", () => {
		const source: SelectionSpec = {
			kind: "polygon",
			points: [
				{ x: 0, y: 0 },
				{ x: 1, y: 0 },
				{ x: 0, y: 1 },
			],
		};
		const scoped = scopeToSample(source, 1);
		expect(source.kind).toBe("polygon");
		expect(scoped).toEqual({
			kind: "intersection",
			selections: [source, { kind: "samples", indices: [1] }],
		});
		expect(selectionScope(scoped, ["one", "two"])).toBe("Sample: two");
		expect(selectionScope(source, ["one", "two"])).toBe("All samples");
		expect(selectionSampleTotal(scoped, [100, 20])).toBe(20);
	});
	it("derives sample denominators through intersections and unions", () => {
		const s0 = { kind: "samples" as const, indices: [0] };
		const s1 = { kind: "samples" as const, indices: [1] };
		expect(selectionSampleTotal({ kind: "intersection", selections: [s0, s1] }, [100, 20])).toBe(0);
		expect(selectionSampleTotal({ kind: "union", selections: [s0, s1] }, [100, 20, 5])).toBe(120);
		expect(
			selectionSampleTotal({ kind: "union", selections: [s0, { kind: "all" }] }, [100, 20, 5]),
		).toBe(125);
	});
	it("does not add duplicate sample predicates to a full-limit saved selection", () => {
		const scoped: SelectionSpec = {
			kind: "intersection",
			selections: [
				{ kind: "samples", indices: [1] },
				...Array.from({ length: 7 }, () => ({ kind: "all" as const })),
			],
		};
		expect(scopeToSample(scoped, 1)).toEqual(scoped);
		const union: SelectionSpec = {
			kind: "union",
			selections: [scoped, { kind: "samples", indices: [0, 1] }],
		};
		expect(selectionSampleTotal(scopeToSample(union, 1), [100, 20])).toBe(20);
	});
});
