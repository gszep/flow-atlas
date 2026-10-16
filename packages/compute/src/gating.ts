/**
 * Evaluate a sample's gate DAG on the GPU. Geometric vertices use the same per-channel display
 * tables as the data; Boolean operations combine sample-local membership masks.
 */
import { interpolate, type Table } from "@flow-atlas/transforms";
import type { WspGate, WspSample } from "@flow-atlas/wsp";
import { evaluateBooleanGate, validateBoolean } from "./boolean.js";
import { evaluateGate, type GateInput, type GateResult, setLabelBit } from "./gate.js";
import type { Kernels } from "./kernels.js";

export interface SampleColumns {
	/** $PnN → transformed column buffer + element offset of this sample's first event. */
	columns: Map<string, { buffer: GPUBuffer; offset: number }>;
	count: number;
	/** Transform tables per $PnN (identity when absent). */
	tables: Map<string, Table>;
}

export interface GateCount {
	gate: WspGate;
	count: number;
	/** FlowJo's recorded count, if any. */
	expected: number | null;
}

const tx = (tables: Map<string, Table>, ch: string, v: number): number => {
	const t = tables.get(ch);
	return t ? interpolate(t, v) : v;
};

function geometryFor(g: WspGate, tables: Map<string, Table>): GateInput["geometry"] | null {
	const [cx, cy] = g.dimensions;
	if (!cx) return null;
	if (g.geometry.type === "polygon") {
		if (!cy) return null;
		return {
			type: "polygon",
			vertices: g.geometry.vertices.map(([x, y]) => [tx(tables, cx, x), tx(tables, cy, y)]),
		};
	}
	if (g.geometry.type === "rectangle") {
		const min = g.geometry.min;
		const max = g.geometry.max;
		const mx0 = min[0] ?? Number.NEGATIVE_INFINITY;
		const mx1 = max[0] ?? Number.POSITIVE_INFINITY;
		const my0 = min[1] ?? Number.NEGATIVE_INFINITY;
		const my1 = max[1] ?? Number.POSITIVE_INFINITY;
		const t = (ch: string, v: number) => (Number.isFinite(v) ? tx(tables, ch, v) : v);
		return {
			type: "rectangle",
			min: [t(cx, mx0), cy ? t(cy, my0) : Number.NEGATIVE_INFINITY],
			max: [t(cx, mx1), cy ? t(cy, my1) : Number.POSITIVE_INFINITY],
		};
	}
	return null;
}

export interface GatingOptions {
	/** Population name → bit index; ancestry leaves get their bit set (references do not change leafhood). */
	populationBits?: Map<string, number>;
	labels?: { buffer: GPUBuffer; offset: number; words: number };
	/** Keep per-gate masks (caller destroys) instead of freeing them. */
	keepMasks?: boolean;
}

export interface GatingResult {
	counts: GateCount[];
	masks: Map<string, GPUBuffer>;
	skipped: WspGate[];
}

/** Validate normalized IDs/Boolean arity and sort ancestry AND reference edges without recursion. */
export function orderGates(gates: WspGate[]): WspGate[] {
	const byId = new Map<string, WspGate>();
	for (const g of gates) {
		if (typeof g.id !== "string" || !g.id || byId.has(g.id)) {
			throw new Error(`Invalid or duplicate gate ID: ${g.id}`);
		}
		byId.set(g.id, g);
	}
	const pending = new Map<string, number>();
	const consumers = new Map<string, string[]>();
	const ready: WspGate[] = [];
	for (const g of gates) {
		if (g.parentId !== null && (typeof g.parentId !== "string" || !g.parentId)) {
			throw new Error(`Invalid parent ID for gate ${g.id}`);
		}
		let refs: string[] = [];
		if (g.geometry.type === "boolean") {
			if (!Array.isArray(g.geometry.refs)) throw new Error(`Invalid Boolean refs for ${g.id}`);
			validateBoolean(g.geometry.op, g.geometry.refs.length);
			refs = g.geometry.refs;
		}
		const deps = new Set([...refs, ...(g.parentId === null ? [] : [g.parentId])]);
		for (const id of deps) {
			if (typeof id !== "string" || !byId.has(id)) {
				throw new Error(`Dangling dependency ${id} for gate ${g.id}`);
			}
			const list = consumers.get(id) ?? [];
			list.push(g.id);
			consumers.set(id, list);
		}
		pending.set(g.id, deps.size);
		if (deps.size === 0) ready.push(g);
	}
	for (let i = 0; i < ready.length; i++) {
		const g = ready[i] as WspGate;
		for (const id of consumers.get(g.id) ?? []) {
			const n = (pending.get(id) as number) - 1;
			pending.set(id, n);
			if (n === 0) ready.push(byId.get(id) as WspGate);
		}
	}
	if (ready.length !== gates.length) {
		const blocked = gates.filter((g) => (pending.get(g.id) ?? 0) > 0).map((g) => g.id);
		throw new Error(`Gate dependency cycle; blocked gates: ${blocked.join(", ")}`);
	}
	return ready;
}

export async function gateSample(
	k: Kernels,
	sample: WspSample,
	cols: SampleColumns,
	maxBinding: number,
	opts: GatingOptions = {},
): Promise<GatingResult> {
	const order = orderGates(sample.gates);
	const masks = new Map<string, GPUBuffer>();
	const counts: GateCount[] = [];
	const skipped: WspGate[] = [];
	const children = new Set(sample.gates.map((g) => g.parentId).filter(Boolean));

	// Retain all masks through the last dependent and label submission. On failure none escape.
	try {
		for (const g of order) {
			const parentMask = g.parentId ? masks.get(g.parentId) : null;
			let r: GateResult;
			if (g.geometry.type === "boolean") {
				const operands = g.geometry.refs.map((id) => {
					const mask = masks.get(id);
					if (!mask) throw new Error(`Boolean gate ${g.id} depends on unevaluated gate ${id}`);
					return mask;
				});
				if (g.parentId && !parentMask) {
					throw new Error(`Boolean gate ${g.id} has unevaluated parent ${g.parentId}`);
				}
				r = await evaluateBooleanGate(
					k,
					{
						op: g.geometry.op,
						operands,
						parent: parentMask ?? null,
						count: cols.count,
					},
					maxBinding,
				);
			} else {
				const geometry = geometryFor(g, cols.tables);
				const cx = cols.columns.get(g.dimensions[0] ?? "");
				const cy = g.dimensions[1] ? cols.columns.get(g.dimensions[1]) : cx;
				if (!geometry || !cx || !cy || (g.parentId && !parentMask)) {
					skipped.push(g);
					continue;
				}
				r = await evaluateGate(
					k,
					{
						x: cx.buffer,
						y: cy.buffer,
						xOffset: cx.offset,
						yOffset: cy.offset,
						count: cols.count,
						parent: parentMask ?? null,
						geometry,
					},
					maxBinding,
				);
			}
			masks.set(g.id, r.mask);
			counts.push({ gate: g, count: r.count, expected: g.count });

			const isLeaf = !children.has(g.id);
			if (isLeaf && opts.labels && opts.populationBits) {
				const bit = opts.populationBits.get(g.name);
				if (bit !== undefined) {
					setLabelBit(
						k,
						r.mask,
						opts.labels.buffer,
						opts.labels.offset,
						cols.count,
						opts.labels.words,
						bit,
						maxBinding,
					);
				}
			}
		}
	} catch (error) {
		for (const m of masks.values()) m.destroy();
		throw error;
	}
	if (!opts.keepMasks) {
		for (const m of masks.values()) m.destroy();
		masks.clear();
	}
	return { counts, masks, skipped };
}
