import { DemoToolError } from "./demo-tool-errors.js";
import type { SelectionAnalysis, SelectionSpec } from "./selection-engine.js";

export interface DemoPopulation {
	id: string;
	name: string;
	actor: "human" | "agent";
	source: SelectionSpec;
	analysis: SelectionAnalysis;
	color: string;
	rationale: string;
	refines: string | null;
	within?: string;
	accepted: boolean;
}
const COLORS = ["#ffcc66", "#60d6b4", "#82b5ff", "#e897ff", "#ff9485", "#c7dc66"];
export function populationName(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.trim().length > 80)
		throw new DemoToolError("invalid_name", "Choose a population name of 1–80 characters");
	return value.trim();
}

/** Definition-only demo selections. Event memberships remain GPU/cache artifacts. */
export class DemoPopulations {
	revision = 0;
	readonly items: DemoPopulation[] = [];
	checkRevision(expected: unknown) {
		if (expected !== this.revision)
			throw new DemoToolError(
				"stale_revision",
				`Stale revision: expected ${this.revision}; inspect_dataset again`,
				{ revision: this.revision },
			);
	}
	get(id: unknown) {
		const item = this.items.find((p) => p.id === id);
		if (!item)
			throw new DemoToolError(
				"population_not_found",
				"Saved population not found; use an id from list_populations. Imported references use ref:<index> for inspection.",
			);
		return item;
	}
	add(input: Omit<DemoPopulation, "id" | "color" | "accepted">, expected: number): DemoPopulation {
		this.checkRevision(expected);
		if (this.items.length >= 32)
			throw new Error("The demo supports up to 32 named selections; remove one or reset");
		const name = populationName(input.name);
		if (input.refines) this.get(input.refines);
		const item = {
			...structuredClone(input),
			name,
			id: crypto.randomUUID(),
			color: COLORS[this.items.length % COLORS.length] as string,
			accepted: input.actor === "human",
		};
		this.items.push(item);
		this.revision++;
		return item;
	}
	rename(id: unknown, name: unknown, actor: "human" | "agent", expected: unknown) {
		this.checkRevision(expected);
		const item = this.get(id);
		if (actor === "agent" && (item.actor === "human" || item.accepted))
			throw new DemoToolError(
				"population_protected",
				"Preserve the human-finalized selection; create a proposed refinement instead",
			);
		item.name = populationName(name);
		this.revision++;
	}
	remove(id: unknown, actor: "human" | "agent", expected: unknown) {
		this.checkRevision(expected);
		const item = this.get(id);
		if (actor === "agent" && (item.actor === "human" || item.accepted))
			throw new DemoToolError(
				"population_protected",
				"Only the human may remove a finalized population. Create a separate proposal instead.",
			);
		this.items.splice(this.items.indexOf(item), 1);
		this.revision++;
	}
	accept(id: string) {
		this.get(id).accepted = true;
		this.revision++;
	}
	reset() {
		this.items.length = 0;
		this.revision++;
	}
}
