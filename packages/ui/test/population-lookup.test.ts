import { expect, it } from "vitest";
import { DemoPopulations } from "../src/demo-populations.js";
import { DemoToolError } from "../src/demo-tool-errors.js";
import { referencePopulations, resolvePopulation } from "../src/population-lookup.js";

const refs = referencePopulations(
	Array.from(
		{ length: 23 },
		(_, i) =>
			({ 18: "CD8 | CM", 19: "CD8 | EM", 20: "CD8 | EMRA", 21: "CD8 | Naive" })[i] ??
			`Population ${i}`,
	),
	Array(23).fill(100),
);
it("every advertised CD8 reference is inspectable by canonical id and legacy index", () => {
	for (const index of [18, 19, 20, 21]) {
		const reference = refs[index] as (typeof refs)[number];
		const targets = [reference.id, index, String(index), `reference:${index}`, reference.name];
		expect(targets.map((id) => resolvePopulation(id, [], refs).source)).toEqual(
			targets.map(() => ({ kind: "reference", population: index })),
		);
	}
});
it("keeps named IDs separate and returns actionable recovery for unknown lookups", () => {
	const store = new DemoPopulations();
	const p = store.add(
		{
			name: "Unknown CD8 ISH?",
			actor: "human",
			source: { kind: "reference", population: 20 },
			analysis: { count: 20, total: 100, channels: [] },
			refines: null,
			rationale: "",
		},
		0,
	);
	expect(resolvePopulation(p.id, store.items, refs).named).toBe(p);
	expect(resolvePopulation("all", store.items, refs).source).toEqual({ kind: "all" });
	let error: unknown;
	try {
		resolvePopulation("fake-reference-id", store.items, refs);
	} catch (e) {
		error = e;
	}
	expect(error).toBeInstanceOf(DemoToolError);
	expect((error as DemoToolError).code).toBe("population_not_found");
	expect(JSON.stringify((error as DemoToolError).recovery)).toContain("ref:20");
});
it("does not let a display name shadow a stable reference id", () => {
	const store = new DemoPopulations();
	store.add(
		{
			name: "ref:18",
			actor: "human",
			source: { kind: "reference", population: 0 },
			analysis: { count: 1, total: 1, channels: [] },
			refines: null,
			rationale: "",
		},
		0,
	);
	expect(resolvePopulation("ref:18", store.items, refs).reference?.index).toBe(18);
});
