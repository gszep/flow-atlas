import { expect, it } from "vitest";
import { DemoPopulations } from "../src/demo-populations.js";
import type { SelectionAnalysis } from "../src/selection-engine.js";

const analysis: SelectionAnalysis = { count: 3, total: 10, channels: [] };
const source = {
	kind: "polygon" as const,
	points: [
		{ x: 0, y: 0 },
		{ x: 1, y: 0 },
		{ x: 0, y: 1 },
	],
};
it("preserves human selections and accepted suggestions against agent mutation", () => {
	const store = new DemoPopulations();
	const human = store.add(
		{ name: "Human", actor: "human", source, analysis, rationale: "", refines: null },
		0,
	);
	expect(() => store.rename(human.id, "changed", "agent", store.revision)).toThrow(/human/);
	expect(() => store.remove(human.id, "agent", store.revision)).toThrow(/human/);
	const candidate = store.add(
		{
			name: "Proposed refinement",
			actor: "agent",
			source,
			analysis,
			rationale: "compare",
			refines: human.id,
		},
		store.revision,
	);
	store.rename(candidate.id, "Candidate", "agent", store.revision);
	store.accept(candidate.id);
	expect(() => store.rename(candidate.id, "changed", "agent", store.revision)).toThrow();
	expect(store.get(human.id).name).toBe("Human");
});
it("rejects stale writes across reset and keeps selection input immutable", () => {
	const store = new DemoPopulations();
	const item = store.add(
		{ name: "A", actor: "human", source, analysis, rationale: "", refines: null },
		0,
	);
	expect(item.source).not.toBe(source);
	const revision = store.revision;
	store.reset();
	expect(store.items).toEqual([]);
	expect(() =>
		store.add(
			{ name: "Stale", actor: "agent", source, analysis, rationale: "", refines: null },
			revision,
		),
	).toThrow(/revision/);
});
