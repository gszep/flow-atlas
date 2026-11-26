import type { SelectionSpec } from "./selection-engine.js";

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

/** Only evaluated leaf counts can establish coverage of an imported reference. */
export interface ReferenceCoverageSample {
	count: number;
	skippedGateCount: number | null;
	gateCounts: readonly { name: string; count: number | null; isLeaf: boolean }[];
}

/** Null indicates unknown coverage; an empty eligible set has a known total of zero. */
export function referenceCoverage(
	samples: readonly ReferenceCoverageSample[],
	name: string,
	eligibleIndices: readonly number[] | null = null,
): number | null {
	const indices = eligibleIndices === null ? samples.map((_, index) => index) : eligibleIndices;
	let total = 0;
	for (const index of new Set(indices)) {
		const sample = samples[index];
		if (!Number.isInteger(index) || !sample) return null;
		if (sample.count === 0) continue;
		if (sample.skippedGateCount !== 0) return null;
		const matches = sample.gateCounts.filter((gate) => gate.name === name);
		const gate = matches[0];
		if (matches.length !== 1 || !gate?.isLeaf || gate.count === null) return null;
		total += gate.count;
	}
	return total;
}

/** Return unique referenced population indices in traversal order. */
export function referencedPopulationIndices(source: SelectionSpec): number[] {
	const indices = new Set<number>();
	function visit(part: SelectionSpec): void {
		if (part.kind === "reference") indices.add(part.population);
		else if (part.kind === "union" || part.kind === "intersection") {
			for (const child of part.selections) visit(child);
		}
	}
	visit(source);
	return [...indices];
}

/** Check every reference against the supplied eligible sample set. */
export function hasKnownReferenceCoverage(
	source: SelectionSpec,
	populationNames: readonly string[],
	samples: readonly ReferenceCoverageSample[],
	eligibleIndices: readonly number[] | null = null,
): boolean {
	return referencedPopulationIndices(source).every((index) => {
		const name = populationNames[index];
		return name !== undefined && referenceCoverage(samples, name, eligibleIndices) !== null;
	});
}
