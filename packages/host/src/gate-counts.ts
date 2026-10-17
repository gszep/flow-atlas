import {
	evaluateBooleanGate,
	evaluateGate,
	type GateInput,
	type GateResult,
	type Kernels,
	upload,
} from "@flow-atlas/compute";
import { type FcsFile, openFcs } from "@flow-atlas/fcs";
import { type ArtifactStore, canonical, digest, fileSource } from "./artifact-store.js";
import { AnalysisError, type OperationArgs, validateOperation } from "./contracts.js";

export type GateCountRequest = OperationArgs<"start_gate_counts">;
type Gate = GateCountRequest["gates"][number];
const F32_MAX = Math.fround(3.4028234663852886e38);
const BUDGET = 128 * 2 ** 20;
const POLICY = "stored-f32-finite-geometric-even-odd-bounded-v1";

export interface ResolvedGateCounts {
	request: GateCountRequest;
	recipeHash: string;
	startEvent: number;
	eventCount: number;
	metadataHash: string;
	channelIndices: number[];
	channelNames: string[];
	order: number[];
	numericalPolicy: string;
}
export interface GateCountResult {
	coordinateSpace: "stored-f32";
	numericalPolicy: string;
	startEvent: number;
	eventCount: number;
	rootCount: number;
	counts: Array<{
		id: string;
		name: string;
		parentId: string | null;
		count: number;
		parentCount: number;
		rootCount: number;
		frequencyOfParent: number | null;
		frequencyOfRoot: number | null;
	}>;
}

function invalid(message: string): never {
	throw new AnalysisError("INVALID_GATE_RECIPE", message);
}
function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
function exact(value: number): boolean {
	return (
		Number.isFinite(value) &&
		Math.fround(value) === value &&
		(value === 0 || Math.abs(value) >= 2 ** -126)
	);
}

/** Metadata-only admission. Event values are never inspected by the CPU here or below.
 * Geometry uses normal-or-zero exact F32 coordinates. GPU F32 rounding (including
 * permitted subnormal flushing) applies, not real-number or vendor boundary parity.
 * Geometric gates exclude NaN/infinities; Boolean NOT complements within its parent
 * (or all selected rows), so it can include rows excluded by geometric gates.
 */
export function resolveGateCounts(
	input: GateCountRequest,
	metadata: Omit<FcsFile, "data">,
): ResolvedGateCounts {
	if (Buffer.byteLength(canonical(input)) > 64 * 1024)
		throw new AnalysisError("GATE_REQUEST_TOO_LARGE", "Gate recipe exceeds 64 KiB");
	const request = validateOperation("start_gate_counts", input) as GateCountRequest;
	const startEvent = request.startEvent ?? 0;
	const eventCount = request.eventCount ?? metadata.eventCount - startEvent;
	if (
		!Number.isSafeInteger(metadata.eventCount) ||
		metadata.eventCount < 0 ||
		!Number.isSafeInteger(startEvent) ||
		!Number.isSafeInteger(eventCount) ||
		startEvent < 0 ||
		eventCount < 0 ||
		startEvent > metadata.eventCount ||
		eventCount > metadata.eventCount - startEvent
	)
		throw new AnalysisError(
			"INVALID_GATE_RANGE",
			"Gate range must lie within the file and use safe integers",
		);
	const names = metadata.channels.map((channel) => channel.name);
	if (!names.length || names.length > 4096 || new Set(names).size !== names.length)
		invalid("Gate sources require 1..4096 unique channel names");
	const byId = new Map(request.gates.map((gate, index) => [gate.id, index]));
	if (byId.size !== request.gates.length) invalid("Gate IDs must be unique");
	const selected = new Set<string>();
	for (const gate of request.gates) {
		const geometry = gate.geometry;
		if (new Set(gate.dimensions).size !== gate.dimensions.length)
			invalid(`Duplicate dimensions for ${gate.id}`);
		for (const name of gate.dimensions) {
			if (!names.includes(name)) invalid(`Unknown gate channel: ${name}`);
			selected.add(name);
		}
		if (geometry.type === "boolean") {
			if (
				gate.dimensions.length ||
				(geometry.op === "not" && geometry.refs.length !== 1) ||
				new Set(geometry.refs).size !== geometry.refs.length
			)
				invalid("Boolean gates require no dimensions, unique references, and unary NOT");
		} else if (geometry.type === "rectangle") {
			if (
				!gate.dimensions.length ||
				geometry.min.length !== gate.dimensions.length ||
				geometry.max.length !== gate.dimensions.length
			)
				invalid("Rectangle bounds must match one or two dimensions");
			for (let i = 0; i < gate.dimensions.length; i++) {
				const lo = geometry.min[i] as number | null,
					hi = geometry.max[i] as number | null;
				if (
					(lo !== null && !exact(lo)) ||
					(hi !== null && !exact(hi)) ||
					(lo !== null && hi !== null && lo > hi)
				)
					invalid(
						"Rectangle bounds must be exact normal-or-zero finite F32 or null, with min <= max",
					);
			}
		} else {
			if (gate.dimensions.length !== 2) invalid("Polygons require two dimensions");
			for (let i = 0; i < geometry.vertices.length; i++) {
				const point = geometry.vertices[i] as [number, number];
				const previous = geometry.vertices[
					(i + geometry.vertices.length - 1) % geometry.vertices.length
				] as [number, number];
				const dy = Math.abs(point[1] - previous[1]);
				if (point.some((v) => !exact(v) || Math.abs(v) > 2 ** 30) || (dy !== 0 && dy < 2 ** -30))
					invalid(
						"Polygon coordinates must be exact normal-or-zero F32 with magnitude <= 2^30; nonhorizontal edge |dy| must be >= 2^-30",
					);
			}
		}
	}
	const order: number[] = [],
		visiting = new Set<number>(),
		visited = new Set<number>();
	const visit = (index: number) => {
		if (visited.has(index)) return;
		if (visiting.has(index)) invalid("Gate ancestry/reference dependency cycle");
		visiting.add(index);
		const gate = request.gates[index] as Gate;
		for (const id of new Set([
			...(gate.parentId === null ? [] : [gate.parentId]),
			...(gate.geometry.type === "boolean" ? gate.geometry.refs : []),
		])) {
			const dep = byId.get(id);
			if (dep === undefined) invalid(`Unknown gate dependency: ${id}`);
			visit(dep);
		}
		visiting.delete(index);
		visited.add(index);
		order.push(index);
	};
	request.gates.forEach((_, index) => {
		visit(index);
	});
	const channelNames = [...selected];
	return freeze({
		request,
		startEvent,
		eventCount,
		order,
		channelNames,
		channelIndices: channelNames.map((name) => names.indexOf(name)),
		metadataHash: digest(metadata),
		numericalPolicy: POLICY,
		recipeHash: digest({ request, startEvent, eventCount, numericalPolicy: POLICY }),
	});
}

function rectangle(gate: Gate): GateInput["geometry"] {
	if (gate.geometry.type !== "rectangle") throw new Error("Expected rectangle");
	const { min, max } = gate.geometry;
	// A 1-D gate aliases x as y, with an unconstrained finite y interval.
	return {
		type: "rectangle",
		min: [min[0] ?? -F32_MAX, min[1] ?? -F32_MAX],
		max: [max[0] ?? F32_MAX, max[1] ?? F32_MAX],
	};
}

/** Hold the caller's GPU lease. One bounded chunk and one gate dispatch/readback at a time. */
export async function runGateCounts(
	k: Kernels,
	store: ArtifactStore,
	resolved: ResolvedGateCounts,
	maxBinding: number,
	chunkBytes: number,
	signal: AbortSignal,
	progress: (count: number) => void,
): Promise<GateCountResult> {
	signal.throwIfAborted();
	const file = await fileSource(store.inputPath(resolved.request.sampleId), store.root);
	try {
		await file.verify(resolved.request.sampleId, signal);
		const reader = await openFcs(file.source, { signal });
		if (digest(reader.metadata) !== resolved.metadataHash)
			throw new AnalysisError(
				"GATE_METADATA_MISMATCH",
				"Gate source metadata changed after admission",
			);
		const limit = Math.min(
			maxBinding,
			BUDGET,
			k.device.limits.maxStorageBufferBindingSize,
			k.device.limits.maxBufferSize,
			k.device.limits.maxComputeWorkgroupsPerDimension * 256 * 4,
		);
		if (!Number.isFinite(limit) || limit < 256 || !Number.isFinite(chunkBytes) || chunkBytes < 1)
			throw new AnalysisError("GATE_RESOURCE_LIMIT", "Invalid gate binding/chunk budget");
		for (const gate of resolved.request.gates)
			if (gate.geometry.type === "polygon" && gate.geometry.vertices.length * 8 > limit)
				throw new AnalysisError("GATE_RESOURCE_LIMIT", "Polygon vertices exceed binding limit");
		const stride = reader.metadata.channels.length * 4;
		const encoded = reader.metadata.channels.reduce((sum, channel) => sum + channel.bits / 8, 0);
		// Includes decoded + encoded data, CPU/GPU columns, every retained gate mask,
		// bounding-box temporary + output, and 1 MiB for vertices/uniforms/readbacks.
		const bytesPerRow =
			stride + encoded + resolved.channelNames.length * 8 + (resolved.request.gates.length + 2) * 4;
		const chunkEvents = Math.floor(
			Math.min(chunkBytes / stride, (BUDGET - 2 ** 20) / bytesPerRow, limit / 4),
		);
		if (chunkEvents < 1)
			throw new AnalysisError("ROW_TOO_LARGE", "Gate event exceeds chunk budget");
		const totals = new Map(resolved.request.gates.map((gate) => [gate.id, 0]));
		let processed = 0;
		for await (const chunk of reader.chunks({
			startEvent: resolved.startEvent,
			eventCount: resolved.eventCount,
			chunkEvents,
			signal,
		})) {
			const owned: GPUBuffer[] = [];
			try {
				signal.throwIfAborted();
				const columns = new Map<string, GPUBuffer>();
				for (let c = 0; c < resolved.channelNames.length; c++) {
					const column = new Float32Array(chunk.count);
					const sourceIndex = resolved.channelIndices[c] as number;
					// Layout-only copy, no event filtering or arithmetic.
					for (let row = 0; row < chunk.count; row++)
						column[row] = chunk.data[row * reader.metadata.channels.length + sourceIndex] as number;
					const buffer = upload(k.device, column, "gate-counts.column");
					owned.push(buffer);
					columns.set(resolved.channelNames[c] as string, buffer);
				}
				const masks = new Map<string, GPUBuffer>();
				for (const index of resolved.order) {
					signal.throwIfAborted();
					const gate = resolved.request.gates[index] as Gate;
					const parent = gate.parentId === null ? null : (masks.get(gate.parentId) as GPUBuffer);
					let result: GateResult;
					if (gate.geometry.type === "boolean") {
						result = await evaluateBooleanGate(
							k,
							{
								op: gate.geometry.op,
								operands: gate.geometry.refs.map((id) => masks.get(id) as GPUBuffer),
								parent,
								count: chunk.count,
							},
							limit,
						);
					} else {
						const x = columns.get(gate.dimensions[0] as string) as GPUBuffer;
						const y = columns.get(
							gate.dimensions[1] ?? (gate.dimensions[0] as string),
						) as GPUBuffer;
						const base = { x, y, xOffset: 0, yOffset: 0, count: chunk.count, parent };
						if (gate.geometry.type === "rectangle") {
							result = await evaluateGate(k, { ...base, geometry: rectangle(gate) }, limit);
						} else {
							const vertices = gate.geometry.vertices;
							const bounds = await evaluateGate(
								k,
								{
									...base,
									geometry: {
										type: "rectangle",
										min: [
											Math.min(...vertices.map((v) => v[0])),
											Math.min(...vertices.map((v) => v[1])),
										],
										max: [
											Math.max(...vertices.map((v) => v[0])),
											Math.max(...vertices.map((v) => v[1])),
										],
									},
								},
								limit,
							);
							try {
								signal.throwIfAborted();
								result = await evaluateGate(
									k,
									{ ...base, parent: bounds.mask, geometry: gate.geometry },
									limit,
								);
							} finally {
								bounds.mask.destroy();
							}
						}
					}
					owned.push(result.mask);
					masks.set(gate.id, result.mask);
					totals.set(gate.id, (totals.get(gate.id) as number) + result.count);
				}
				processed += chunk.count;
				signal.throwIfAborted();
				progress(chunk.count);
			} finally {
				for (const buffer of owned) buffer.destroy();
			}
		}
		await file.assertUnchanged();
		signal.throwIfAborted();
		if (processed !== resolved.eventCount)
			throw new AnalysisError("GATE_ROW_COUNT_MISMATCH", "Gate source row count changed");
		return {
			coordinateSpace: "stored-f32",
			numericalPolicy: POLICY,
			startEvent: resolved.startEvent,
			eventCount: processed,
			rootCount: processed,
			counts: resolved.request.gates.map((gate) => {
				const count = totals.get(gate.id) as number;
				const parentCount =
					gate.parentId === null ? processed : (totals.get(gate.parentId) as number);
				return {
					id: gate.id,
					name: gate.name,
					parentId: gate.parentId,
					count,
					parentCount,
					rootCount: processed,
					frequencyOfParent: parentCount === 0 ? null : count / parentCount,
					frequencyOfRoot: processed === 0 ? null : count / processed,
				};
			}),
		};
	} finally {
		await file.close();
	}
}
