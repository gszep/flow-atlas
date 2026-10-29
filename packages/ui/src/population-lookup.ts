import type { DemoPopulation } from "./demo-populations.js";
import { DemoToolError } from "./demo-tool-errors.js";
import type { SelectionSpec } from "./selection-engine.js";

export interface ReferencePopulation {
	id: string;
	index: number;
	name: string;
	count: number;
}
export interface PopulationTarget {
	id: string;
	name: string;
	source: SelectionSpec;
	named?: DemoPopulation;
	reference?: ReferencePopulation;
}
export function referencePopulations(names: string[], counts: number[]): ReferencePopulation[] {
	return names.map((name, index) => ({
		id: `ref:${index}`,
		index,
		name,
		count: counts[index] ?? 0,
	}));
}
export function resolvePopulation(
	target: unknown,
	named: readonly DemoPopulation[],
	references: readonly ReferencePopulation[],
): PopulationTarget {
	if (target === "all") return { id: "all", name: "All cells", source: { kind: "all" } };
	const value = typeof target === "string" ? target.trim() : target;
	const direct = named.find((item) => item.id === value);
	if (direct) return { id: direct.id, name: direct.name, source: direct.source, named: direct };
	const match = typeof value === "string" ? /^(?:(?:ref|reference):)?(\d{1,5})$/.exec(value) : null;
	const index = typeof value === "number" ? value : match ? Number(match[1]) : undefined;
	const reference = references.find(
		(item) => item.id === value || item.index === index || item.name === value,
	);
	const byName = named.filter((item) => item.name === value);
	if (reference && (index !== undefined || reference.id === value))
		return {
			id: reference.id,
			name: reference.name,
			source: { kind: "reference", population: reference.index },
			reference,
		};
	if (byName.length > 1 || (byName.length && reference))
		throw new DemoToolError(
			"ambiguous_population",
			"Use the exact population id from list_populations, not this ambiguous name.",
			{
				candidates: [
					...byName.map(({ id, name }) => ({ id, name })),
					...(reference ? [{ id: reference.id, name: reference.name }] : []),
				],
			},
		);
	if (reference)
		return {
			id: reference.id,
			name: reference.name,
			source: { kind: "reference", population: reference.index },
			reference,
		};
	if (byName[0])
		return { id: byName[0].id, name: byName[0].name, source: byName[0].source, named: byName[0] };
	throw new DemoToolError(
		"population_not_found",
		"Unknown population. Imported references use ids such as ref:18; named populations use their returned id. Use all for the dataset baseline.",
		{
			named: named.map(({ id, name }) => ({ id, name })),
			references: references.map(({ id, name }) => ({ id, name })),
		},
	);
}
