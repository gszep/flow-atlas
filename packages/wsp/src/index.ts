/**
 * FlowJo .wsp reader → workspace model. Ported from FlowWorkspace.jl with the limits removed:
 * the gate model is designed for the full Gating-ML 2.0 set even though Phase 1 evaluates only
 * polygon and rectangle gates. All gate geometry is kept in RAW channel space; transforms are
 * attached separately so the compute layer decides when to apply them.
 */

import { type FcsChannel, parseChannels } from "@flow-atlas/fcs";
import type { TransformSpec } from "@flow-atlas/transforms";
import {
	attr,
	child,
	childrenOf,
	descendants,
	localName,
	parseXml,
	type XmlElement,
} from "./xml.js";

export * from "./xml.js";

export type GateGeometry =
	| { type: "rectangle"; min: number[]; max: number[] }
	| { type: "polygon"; vertices: [number, number][] }
	| { type: "ellipsoid"; mean: number[]; covariance: number[][]; distanceSquare: number }
	| { type: "quadrant"; divider: number[]; position: number[] }
	| { type: "boolean"; op: "and" | "or" | "not"; refs: string[] }
	| { type: "unsupported"; element: string };

export interface WspGate {
	id: string;
	parentId: string | null;
	/** Population name as shown in FlowJo. Not unique. */
	name: string;
	/** FlowJo's own event count for this population, if recorded. Parity oracle. */
	count: number | null;
	/** $PnN names of the gate dimensions, in order. */
	dimensions: string[];
	geometry: GateGeometry;
}

export interface WspSample {
	id: string;
	name: string;
	uri: string;
	/** Basename of the FCS file as referenced by the workspace. */
	basename: string;
	keywords: Record<string, string>;
	/** Channels from the sample's <Keywords> (FlowJo copies the FCS TEXT segment). */
	channels: FcsChannel[];
	/** $PnN → transform. Channels absent here are untransformed. */
	transforms: Record<string, TransformSpec>;
	gates: WspGate[];
	/** Total events per SampleNode/@count. */
	eventCount: number | null;
}

export interface WspGroup {
	name: string;
	sampleIds: string[];
}

export interface Workspace {
	version: string;
	flowJoVersion: string;
	samples: WspSample[];
	groups: WspGroup[];
}

export class WspError extends Error {
	override name = "WspError";
}

const numAttr = (el: XmlElement, name: string): number | undefined => {
	const v = attr(el, name);
	if (v === undefined) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
};

function parseTransforms(sample: XmlElement): Record<string, TransformSpec> {
	const out: Record<string, TransformSpec> = {};
	const tr = child(sample, "Transformations");
	if (!tr) return out;
	for (const t of tr.children) {
		const param = child(t, "parameter");
		const channel = param ? attr(param, "name") : undefined;
		if (!channel) continue;
		const type = localName(t.name);
		const params: Record<string, number> = {};
		for (const [k, v] of Object.entries(t.attrs)) {
			const n = Number(v);
			if (Number.isFinite(n)) params[localName(k)] = n;
		}
		if (type === "biex" || type === "linear" || type === "log") {
			out[channel] = { type, ...params } as TransformSpec;
		} else {
			// e.g. logicle, hyperlog, fasinh: recorded so the UI can warn; Phase 2 implements them.
			out[channel] = { type: "linear", minRange: 0, maxRange: 262144, gain: 1 };
		}
	}
	return out;
}

function parseGeometry(gateEl: XmlElement, dims: XmlElement[]): GateGeometry {
	switch (localName(gateEl.name)) {
		case "RectangleGate": {
			const min: number[] = [];
			const max: number[] = [];
			for (const d of dims) {
				min.push(numAttr(d, "min") ?? Number.NEGATIVE_INFINITY);
				max.push(numAttr(d, "max") ?? Number.POSITIVE_INFINITY);
			}
			return { type: "rectangle", min, max };
		}
		case "PolygonGate": {
			const vertices: [number, number][] = [];
			for (const v of childrenOf(gateEl, "vertex")) {
				const c = childrenOf(v, "coordinate").map((x) => numAttr(x, "value") ?? Number.NaN);
				vertices.push([c[0] ?? Number.NaN, c[1] ?? Number.NaN]);
			}
			return { type: "polygon", vertices };
		}
		case "EllipsoidGate": {
			const mean = childrenOf(child(gateEl, "mean") ?? gateEl, "coordinate").map(
				(x) => numAttr(x, "value") ?? Number.NaN,
			);
			const cov = childrenOf(child(gateEl, "covarianceMatrix") ?? gateEl, "row").map((r) =>
				childrenOf(r, "entry").map((e) => numAttr(e, "value") ?? Number.NaN),
			);
			const ds = child(gateEl, "distanceSquare");
			return {
				type: "ellipsoid",
				mean,
				covariance: cov,
				distanceSquare: ds ? (numAttr(ds, "value") ?? 1) : 1,
			};
		}
		case "QuadrantGate":
			return {
				type: "quadrant",
				divider: childrenOf(gateEl, "divider").map((d) => numAttr(d, "value") ?? Number.NaN),
				position: [],
			};
		case "BooleanGate": {
			const op = child(gateEl, "and") ? "and" : child(gateEl, "or") ? "or" : "not";
			const refs = descendants(gateEl, "gateReference").map((r) => attr(r, "ref") ?? "");
			return { type: "boolean", op, refs };
		}
		default:
			return { type: "unsupported", element: gateEl.name };
	}
}

function parseGates(sampleNode: XmlElement): WspGate[] {
	const out: WspGate[] = [];
	for (const pop of descendants(sampleNode, "Population")) {
		const g = child(pop, "Gate");
		if (!g) continue;
		const gateEl = g.children[0];
		if (!gateEl) continue;
		const dims = childrenOf(gateEl, "dimension");
		const dimensions = dims.map((d) => {
			const fd = child(d, "fcs-dimension");
			return (fd ? attr(fd, "name") : undefined) ?? "";
		});
		out.push({
			id: attr(g, "id") ?? "",
			parentId: attr(g, "parent_id") ?? null,
			name: pop.attrs.name ?? "",
			count: numAttr(pop, "count") ?? null,
			dimensions,
			geometry: parseGeometry(gateEl, dims),
		});
	}
	return out;
}

function parseSample(s: XmlElement): WspSample {
	const ds = child(s, "DataSet");
	const uri = ds?.attrs.uri ?? "";
	const kw: Record<string, string> = {};
	for (const k of childrenOf(child(s, "Keywords") ?? s, "Keyword")) {
		if (k.attrs.name !== undefined) kw[k.attrs.name.toUpperCase()] = k.attrs.value ?? "";
	}
	const node = child(s, "SampleNode");
	const id = ds?.attrs.sampleID ?? node?.attrs.sampleID ?? "";
	const decodedUri = decodeURIComponent(uri);
	const basename = decodedUri.split(/[\\/]/).pop() ?? "";
	const channels = kw.$PAR ? parseChannels(kw) : [];
	return {
		id,
		name: node?.attrs.name ?? basename,
		uri,
		basename,
		keywords: kw,
		channels,
		transforms: parseTransforms(s),
		gates: node ? parseGates(node) : [],
		eventCount: node ? (numAttr(node, "count") ?? null) : null,
	};
}

export function readWsp(xml: string): Workspace {
	const doc = parseXml(xml);
	const ws = child(doc, "Workspace");
	if (!ws) throw new WspError("no <Workspace> root");
	const samples = childrenOf(child(ws, "SampleList") ?? ws, "Sample").map(parseSample);
	const groups: WspGroup[] = [];
	for (const g of childrenOf(child(ws, "Groups") ?? ws, "GroupNode")) {
		const refs = descendants(g, "SampleRef").map((r) => r.attrs.sampleID ?? "");
		groups.push({ name: g.attrs.name ?? "", sampleIds: refs });
	}
	return {
		version: ws.attrs.version ?? "",
		flowJoVersion: ws.attrs.flowJoVersion ?? "",
		samples,
		groups,
	};
}

/** Display name for a channel: $PnS if present else $PnN. */
export const displayName = (c: FcsChannel): string => c.stain ?? c.name;

/** Gates as a forest; children ordered as in the file. */
export function gateTree(sample: WspSample): Array<WspGate & { children: WspGate[] }> {
	const byParent = new Map<string | null, WspGate[]>();
	for (const g of sample.gates) {
		const arr = byParent.get(g.parentId) ?? [];
		arr.push(g);
		byParent.set(g.parentId, arr);
	}
	const build = (g: WspGate): WspGate & { children: WspGate[] } => ({
		...g,
		children: (byParent.get(g.id) ?? []).map(build),
	});
	return (byParent.get(null) ?? []).map(build);
}

/** Leaf populations per sample (FlowAtlas.jl semantics: outdegree 0). */
export function leafGates(sample: WspSample): WspGate[] {
	const parents = new Set(sample.gates.map((g) => g.parentId).filter((p): p is string => !!p));
	return sample.gates.filter((g) => !parents.has(g.id));
}
