import { intersectSelections, type SelectionSpec, unionSelections } from "./selection-engine.js";

/** Snapshot a sample display choice into a new exploratory selection, without changing its source. */
export function scopeToSample(source: SelectionSpec, index: number | null): SelectionSpec {
	if (index === null) return structuredClone(source);
	if (source.kind === "union")
		return unionSelections(...source.selections.map((part) => scopeToSample(part, index)));
	if (source.kind === "samples" && source.indices.includes(index))
		return { kind: "samples", indices: [index] };
	if (source.kind === "intersection") {
		const sampleIndex = source.selections.findIndex(
			(part) => part.kind === "samples" && part.indices.includes(index),
		);
		if (sampleIndex >= 0) {
			const selections = structuredClone(source.selections);
			selections[sampleIndex] = { kind: "samples", indices: [index] };
			return { kind: "intersection", selections };
		}
	}
	return intersectSelections(source, { kind: "samples", indices: [index] });
}

/** Null means all samples are eligible; an array is the exact eligible sample set. */
export function eligibleSamples(source: SelectionSpec): number[] | null {
	if (source.kind === "samples") return [...new Set(source.indices)];
	if (source.kind !== "union" && source.kind !== "intersection") return null;
	const parts = source.selections.map(eligibleSamples);
	if (source.kind === "union") {
		if (parts.some((part) => part === null)) return null;
		return [...new Set(parts.flatMap((part) => part ?? []))];
	}
	const bounded = parts.filter((part): part is number[] => part !== null);
	if (!bounded.length) return null;
	return (bounded[0] ?? []).filter((index) => bounded.every((part) => part.includes(index)));
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
