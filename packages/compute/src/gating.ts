/**
 * Evaluate a sample's gate DAG on the GPU in transformed (display) space, exactly as FlowJo does:
 * gate vertices are transformed with the same per-channel tables as the data.
 */
import { interpolate, type Table } from "@flow-atlas/transforms";
import type { WspGate, WspSample } from "@flow-atlas/wsp";
import { evaluateGate, type GateInput, setLabelBit } from "./gate.js";
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
	/** Population name → bit index; leaves get their bit set in `labels`. */
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

export async function gateSample(
	k: Kernels,
	sample: WspSample,
	cols: SampleColumns,
	maxBinding: number,
	opts: GatingOptions = {},
): Promise<GatingResult> {
	const byId = new Map(sample.gates.map((g) => [g.id, g]));
	const masks = new Map<string, GPUBuffer>();
	const counts: GateCount[] = [];
	const skipped: WspGate[] = [];
	const children = new Set(sample.gates.map((g) => g.parentId).filter(Boolean));

	// Topological order: parents first (gates appear in document order which is already parent-first,
	// but be safe).
	const order: WspGate[] = [];
	const visited = new Set<string>();
	const visit = (g: WspGate) => {
		if (visited.has(g.id)) return;
		if (g.parentId) {
			const p = byId.get(g.parentId);
			if (p) visit(p);
		}
		visited.add(g.id);
		order.push(g);
	};
	for (const g of sample.gates) visit(g);

	for (const g of order) {
		const geometry = geometryFor(g, cols.tables);
		const cx = cols.columns.get(g.dimensions[0] ?? "");
		const cy = g.dimensions[1] ? cols.columns.get(g.dimensions[1]) : cx;
		const parentMask = g.parentId ? masks.get(g.parentId) : null;
		if (!geometry || !cx || !cy || (g.parentId && !parentMask)) {
			skipped.push(g);
			continue;
		}
		const r = await evaluateGate(
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
	if (!opts.keepMasks) {
		for (const m of masks.values()) m.destroy();
		masks.clear();
	}
	return { counts, masks, skipped };
}
