import { canonical, digest } from "./artifact-store.js";
import { AnalysisError, operationSchemas } from "./contracts.js";
import type { GateCountRequest } from "./gate-counts.js";
import type { PopulationMedianRequest } from "./population-medians.js";

const PROFILE = "nearest-f32-compiled-v1";
const MAX_BYTES = 64 * 1024;
type Gate = GateCountRequest["gates"][number];
type Geometry = Gate["geometry"];
type Deltas = Exclude<Geometry, { type: "boolean" }> | null;

export interface CoordinateCompilationReport {
	profile: typeof PROFILE;
	semantics: "new-compiled-recipe";
	rounding: "binary32-nearest-ties-to-even";
	zeroPolicy: "canonical-positive-zero";
	membershipPreservation: "not-guaranteed";
	topologyPreservation: "not-guaranteed";
	topologyValidation: "limited-structural-checks";
	lossy: boolean;
	originalRecipeHash: string;
	compiledRecipeHash: string;
	recipeHashDefinition: "sha256-of-host-canonical-json-of-entire-projected-recipe";
	deltaDefinition: "compiled-minus-original";
	changedCoordinateDefinition: "Object.is-difference-including-negative-zero-canonicalization";
	changedCoordinateCount: number;
	maxAbsoluteError: number;
	gates: Array<{
		id: string;
		originalGeometry: Geometry;
		compiledGeometry: Geometry;
		deltas: Deltas;
	}>;
}

function reject(gateId: string | null, reason: string, coordinate?: string): never {
	throw new AnalysisError(
		"COORDINATE_COMPILATION_REJECTED",
		`Coordinate compilation rejected: ${reason}`,
		{
			profile: PROFILE,
			gateId,
			reason,
			...(coordinate === undefined ? {} : { coordinate }),
		},
	);
}
function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
function recipeSize(value: unknown, which: "original" | "compiled"): void {
	if (Buffer.byteLength(canonical(value)) > MAX_BYTES) reject(null, `${which}-recipe-too-large`);
}

/** Existing shape/nonprecision restrictions, independent of coordinate representability. */
function validateGate(gate: Gate): void {
	const parsed = operationSchemas.start_gate_counts.shape.gates.element.safeParse(gate);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		let value: unknown = gate;
		for (const part of issue?.path ?? [])
			value =
				value !== null && typeof value === "object"
					? (value as Record<PropertyKey, unknown>)[part]
					: undefined;
		reject(
			typeof gate?.id === "string" ? gate.id : null,
			typeof value === "number" && !Number.isFinite(value)
				? "nonfinite-original"
				: "invalid-gate-shape",
			issue?.path.map(String).join("."),
		);
	}
	if (new Set(gate.dimensions).size !== gate.dimensions.length)
		reject(gate.id, "duplicate-dimensions");
	const geometry = gate.geometry;
	if (geometry.type === "boolean") {
		if (
			gate.dimensions.length ||
			new Set(geometry.refs).size !== geometry.refs.length ||
			(geometry.op === "not" && geometry.refs.length !== 1)
		)
			reject(gate.id, "invalid-boolean-shape");
	} else if (geometry.type === "rectangle") {
		if (
			!gate.dimensions.length ||
			geometry.min.length !== gate.dimensions.length ||
			geometry.max.length !== gate.dimensions.length
		)
			reject(gate.id, "rectangle-dimension-mismatch");
		for (let i = 0; i < geometry.min.length; i++) {
			const min = geometry.min[i],
				max = geometry.max[i];
			if (min !== null && max !== null && (min as number) > (max as number))
				reject(gate.id, "reversed-rectangle-bounds", `geometry.min[${i}]`);
		}
	} else {
		if (gate.dimensions.length !== 2) reject(gate.id, "polygon-dimension-mismatch");
		for (let i = 0; i < geometry.vertices.length; i++) {
			const point = geometry.vertices[i] as [number, number];
			for (let axis = 0; axis < 2; axis++)
				if (Math.abs(point[axis] as number) > 2 ** 30)
					reject(gate.id, "polygon-magnitude-limit", `geometry.vertices[${i}][${axis}]`);
			const previous = geometry.vertices[
				(i + geometry.vertices.length - 1) % geometry.vertices.length
			] as [number, number];
			const dy = Math.abs(point[1] - previous[1]);
			if (dy !== 0 && dy < 2 ** -30)
				reject(gate.id, "polygon-edge-dy-limit", `geometry.vertices[${i}][1]`);
		}
	}
}

/** Exact binary64 value in integer units of 2^-1074. Metadata only, never events. */
function dyadicInteger(value: number): bigint {
	const view = new DataView(new ArrayBuffer(8));
	view.setFloat64(0, value, false);
	const bits = view.getBigUint64(0, false);
	const exponent = Number((bits >> 52n) & 0x7ffn);
	const fraction = bits & ((1n << 52n) - 1n);
	const magnitude = exponent === 0 ? fraction : ((1n << 52n) | fraction) << BigInt(exponent - 1);
	return bits >> 63n ? -magnitude : magnitude;
}
function collinear(vertices: [number, number][]): boolean {
	const points = vertices.map(([x, y]) => [dyadicInteger(x), dyadicInteger(y)] as const);
	const [ax, ay] = points[0] as readonly [bigint, bigint];
	const other = points.find(([x, y]) => x !== ax || y !== ay);
	if (!other) return true;
	const dx = other[0] - ax,
		dy = other[1] - ay;
	return points.every(([x, y]) => dx * (y - ay) === dy * (x - ax));
}
const samePoint = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];
function rejectIntroducedCollapse(id: string, original: Geometry, compiled: Geometry): void {
	if (original.type === "rectangle" && compiled.type === "rectangle") {
		for (let i = 0; i < original.min.length; i++) {
			const min = original.min[i],
				max = original.max[i];
			if (
				min !== null &&
				max !== null &&
				(min as number) < (max as number) &&
				compiled.min[i] === compiled.max[i]
			)
				reject(id, "introduced-zero-width-rectangle", `geometry.min[${i}]`);
		}
	} else if (original.type === "polygon" && compiled.type === "polygon") {
		const a = original.vertices,
			b = compiled.vertices;
		for (let axis = 0; axis < 2; axis++) {
			const before = a.map((point) => point[axis] as number),
				after = b.map((point) => point[axis] as number);
			if (Math.min(...before) < Math.max(...before) && Math.min(...after) === Math.max(...after))
				reject(id, "introduced-zero-span-polygon", `geometry.vertices.axis[${axis}]`);
		}
		if (
			new Set(b.map((point) => JSON.stringify(point))).size <
			new Set(a.map((point) => JSON.stringify(point))).size
		)
			reject(id, "lost-distinct-polygon-vertices");
		for (let i = 0; i < a.length; i++) {
			const next = (i + 1) % a.length;
			if (
				!samePoint(a[i] as [number, number], a[next] as [number, number]) &&
				samePoint(b[i] as [number, number], b[next] as [number, number])
			)
				reject(id, "introduced-duplicate-polygon-edge", `geometry.vertices[${i}]`);
		}
		if (!collinear(a) && collinear(b)) reject(id, "introduced-polygon-collinearity");
	}
}

/** Explicit opt-in only. This defines a new numeric recipe, not a membership-preserving conversion.
 * Hashes use host canonical JSON for the entire projected recipe (including sample/range/targets).
 * Deltas are signed compiled-minus-original doubles; null rectangle bounds remain null.
 * Negative zero canonicalization is counted as a change although canonical JSON hashes erase its sign.
 * Structural checks do not certify self-intersection or general topology preservation.
 */
export function compileNearestF32<T extends GateCountRequest | PopulationMedianRequest>(
	original: T,
): { compiled: T; report: CoordinateCompilationReport } {
	recipeSize(original, "original");
	const source = structuredClone(original),
		compiled = structuredClone(source);
	if (!Array.isArray(source.gates) || source.gates.length > 128) reject(null, "invalid-gate-count");
	if (new Set(source.gates.map((gate) => gate?.id)).size !== source.gates.length)
		reject(null, "duplicate-gate-id");
	const report: CoordinateCompilationReport = {
		profile: PROFILE,
		semantics: "new-compiled-recipe",
		rounding: "binary32-nearest-ties-to-even",
		zeroPolicy: "canonical-positive-zero",
		membershipPreservation: "not-guaranteed",
		topologyPreservation: "not-guaranteed",
		topologyValidation: "limited-structural-checks",
		lossy: false,
		originalRecipeHash: digest(source),
		compiledRecipeHash: "",
		recipeHashDefinition: "sha256-of-host-canonical-json-of-entire-projected-recipe",
		deltaDefinition: "compiled-minus-original",
		changedCoordinateDefinition: "Object.is-difference-including-negative-zero-canonicalization",
		changedCoordinateCount: 0,
		maxAbsoluteError: 0,
		gates: [],
	};
	for (const [index, gate] of source.gates.entries()) {
		validateGate(gate);
		const target = compiled.gates[index] as Gate;
		const coordinate = (value: number, location: string): [number, number] => {
			if (!Number.isFinite(value)) reject(gate.id, "nonfinite-original", location);
			const rounded = Math.fround(value);
			if (!Number.isFinite(rounded)) reject(gate.id, "overflow", location);
			if (value !== 0 && rounded === 0) reject(gate.id, "underflow-to-zero", location);
			if (rounded !== 0 && Math.abs(rounded) < 2 ** -126)
				reject(gate.id, "compiled-subnormal", location);
			const result = rounded === 0 ? 0 : rounded;
			const delta = result - value;
			if (!Object.is(value, result)) report.changedCoordinateCount++;
			report.maxAbsoluteError = Math.max(report.maxAbsoluteError, Math.abs(delta));
			return [result, delta === 0 ? 0 : delta];
		};
		let deltas: Deltas = null;
		if (gate.geometry.type === "rectangle") {
			const geometry: Extract<Geometry, { type: "rectangle" }> = {
				type: "rectangle",
				min: [],
				max: [],
			};
			deltas = { type: "rectangle", min: [], max: [] };
			for (const side of ["min", "max"] as const)
				for (const [axis, value] of gate.geometry[side].entries()) {
					const pair: [number | null, number | null] =
						value === null ? [null, null] : coordinate(value, `geometry.${side}[${axis}]`);
					const [rounded, delta] = pair;
					geometry[side].push(rounded);
					deltas[side].push(delta);
				}
			target.geometry = geometry;
		} else if (gate.geometry.type === "polygon") {
			const vertices: [number, number][] = [],
				differences: [number, number][] = [];
			for (const [vertex, point] of gate.geometry.vertices.entries()) {
				const x = coordinate(point[0], `geometry.vertices[${vertex}][0]`);
				const y = coordinate(point[1], `geometry.vertices[${vertex}][1]`);
				vertices.push([x[0], y[0]]);
				differences.push([x[1], y[1]]);
			}
			target.geometry = { type: "polygon", vertices };
			deltas = { type: "polygon", vertices: differences };
		}
		validateGate(target);
		rejectIntroducedCollapse(gate.id, gate.geometry, target.geometry);
		report.gates.push({
			id: gate.id,
			originalGeometry: structuredClone(gate.geometry),
			compiledGeometry: structuredClone(target.geometry),
			deltas,
		});
	}
	recipeSize(compiled, "compiled");
	report.compiledRecipeHash = digest(compiled);
	report.lossy = report.changedCoordinateCount !== 0;
	const reportBytes = Buffer.byteLength(canonical(report));
	if (reportBytes > MAX_BYTES)
		throw new AnalysisError(
			"COORDINATE_REPORT_TOO_LARGE",
			"Coordinate compilation report exceeds 64 KiB",
			{
				profile: PROFILE,
				bytes: reportBytes,
				maxBytes: MAX_BYTES,
			},
		);
	return freeze({ compiled, report });
}
