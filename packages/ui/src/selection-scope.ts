import { eligibleSamples } from "./reference-coverage.js";
import { intersectSelections, type SelectionSpec, unionSelections } from "./selection-engine.js";

/** Snapshot a sample display choice into a new exploratory selection, without changing its source. */
export function scopeToSample(source: SelectionSpec, index: number | null): SelectionSpec {
	if (index === null) return structuredClone(source);
	if (source.kind === "union")
		return unionSelections(...source.selections.map((part) => scopeToSample(part, index)));
	if (source.kind === "samples")
		return { kind: "samples", indices: source.indices.includes(index) ? [index] : [] };
	if (source.kind === "intersection") {
		const sampleIndex = source.selections.findIndex((part) => part.kind === "samples");
		if (sampleIndex >= 0) {
			const selections = structuredClone(source.selections);
			const previous = selections[sampleIndex];
			if (previous?.kind !== "samples") throw new Error("Invalid sample selection");
			selections[sampleIndex] = {
				kind: "samples",
				indices: previous.indices.includes(index) ? [index] : [],
			};
			return { kind: "intersection", selections };
		}
	}
	return intersectSelections(source, { kind: "samples", indices: [index] });
}

/** Scope is evidence about a selection, not a claim about patient identity. */
export function selectionScope(source: SelectionSpec, names: readonly string[]): string {
	const eligible = eligibleSamples(source);
	if (eligible === null) return "All samples";
	if (eligible.length === 0) return "No overlapping samples";
	if (eligible.length === 1) return `Sample: ${names[eligible[0] as number] ?? "unknown"}`;
	return `${eligible.length} selected samples`;
}

/** Dataset-level sample denominator, not a parent-gate or condition denominator. */
export function selectionSampleTotal(source: SelectionSpec, counts: readonly number[]): number {
	const eligible = eligibleSamples(source) ?? counts.map((_, index) => index);
	return eligible.reduce((sum, index) => sum + (counts[index] ?? 0), 0);
}
