import { type Gate, ModelError, type WorkspaceDocument } from "./types.js";

export function invalid(message: string): never {
	throw new ModelError("INVALID_DOCUMENT", message);
}

/** Reject lossy JSON values before cloning, including hidden/accessor properties and cycles. */
export function jsonValue(value: unknown, ancestors = new Set<object>(), depth = 0): void {
	if (depth > 100) invalid("JSON nesting exceeds 100");
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value) || Object.is(value, -0)) invalid("Expected finite JSON number");
		return;
	}
	if (typeof value !== "object") invalid("Expected JSON value");
	if (ancestors.has(value)) invalid("Cyclic JSON value");
	if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
		invalid("Expected plain JSON object");
	if (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype)
		invalid("Expected plain JSON array");
	ancestors.add(value);
	const keys = Reflect.ownKeys(value);
	if (Array.isArray(value) && keys.length !== value.length + 1) invalid("Sparse or extended array");
	for (const key of keys) {
		if (Array.isArray(value) && key === "length") continue;
		if (typeof key !== "string") invalid("Symbol property is not JSON");
		if (Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
			invalid("Extended array");
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) invalid("Expected JSON data property");
		jsonValue(descriptor.value, ancestors, depth + 1);
	}
	ancestors.delete(value);
}

export function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Expected object");
	return value as Record<string, unknown>;
}

export function fields(value: unknown, required: string[], optional: string[] = []) {
	const record = object(value);
	for (const key of required) if (!Object.hasOwn(record, key)) invalid(`Missing field: ${key}`);
	for (const key of Object.keys(record)) {
		if (!required.includes(key) && !optional.includes(key)) invalid(`Unknown field: ${key}`);
	}
	return record;
}

export function text(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 4096)
		invalid("Expected nonempty string (max 4096 characters)");
}

export function integer(value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		invalid("Expected nonnegative safe integer");
}

export function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) invalid("Expected array");
	return value;
}

function strings(value: unknown): string[] {
	const values = array(value);
	for (const item of values) text(item);
	if (new Set(values).size !== values.length) invalid("Duplicate reference or dimension");
	return values as string[];
}

function identified(value: unknown) {
	const result = new Map<string, Record<string, unknown>>();
	for (const item of array(value)) {
		const record = object(item);
		text(record.id);
		if (result.has(record.id)) invalid(`Duplicate ID: ${record.id}`);
		result.set(record.id, record);
	}
	return result;
}

export function edit(value: unknown, revision: number) {
	const e = fields(value, ["agentId", "revision"]);
	text(e.agentId);
	integer(e.revision);
	if (e.revision === 0 || e.revision > revision) invalid("Invalid attribution revision");
}

function provenance(record: Record<string, unknown>, revision: number) {
	if ("author" in record || "modified" in record) {
		text(record.author);
		text(record.modified);
	}
	if ("agentEdit" in record) edit(record.agentEdit, revision);
}

const gateFields = ["id", "sampleId", "name", "parentId", "dimensions", "geometry"];
const provenanceFields = ["author", "modified", "agentEdit"];

export function gateShape(value: unknown, withProvenance = false, revision = 0) {
	const g = fields(value, gateFields, withProvenance ? provenanceFields : []);
	text(g.id);
	text(g.sampleId);
	text(g.name);
	if (g.parentId !== null) text(g.parentId);
	const dimensions = strings(g.dimensions);
	const geometry = object(g.geometry);
	switch (geometry.type) {
		case "rectangle": {
			fields(geometry, ["type", "min", "max"]);
			const min = array(geometry.min);
			const max = array(geometry.max);
			if (!dimensions.length || min.length !== dimensions.length || max.length !== min.length)
				invalid("Rectangle bounds must match nonempty dimensions");
			for (let i = 0; i < min.length; i++) {
				const lo = min[i];
				const hi = max[i];
				if (lo !== null && typeof lo !== "number") invalid("Invalid lower bound");
				if (hi !== null && typeof hi !== "number") invalid("Invalid upper bound");
				if (typeof lo === "number" && typeof hi === "number" && lo > hi) invalid("Reversed bounds");
			}
			break;
		}
		case "polygon": {
			fields(geometry, ["type", "vertices"]);
			const vertices = array(geometry.vertices);
			if (dimensions.length !== 2 || vertices.length < 3)
				invalid("Polygon needs 2 axes and 3 vertices");
			for (const vertex of vertices) {
				const pair = array(vertex);
				if (pair.length !== 2 || pair.some((v) => typeof v !== "number")) invalid("Invalid vertex");
			}
			break;
		}
		case "boolean": {
			fields(geometry, ["type", "op", "refs"]);
			const refs = strings(geometry.refs);
			if (geometry.op !== "and" && geometry.op !== "or" && geometry.op !== "not")
				invalid("Invalid boolean operator");
			if (dimensions.length || !refs.length || (geometry.op === "not" && refs.length !== 1))
				invalid("Boolean gate needs references, no dimensions; not takes one reference");
			break;
		}
		default:
			throw new ModelError(
				"UNSUPPORTED_CAPABILITY",
				`Gate geometry: ${JSON.stringify(geometry.type)}`,
			);
	}
	if (withProvenance) provenance(g, revision);
}

export function dependencies(gate: Gate): string[] {
	return [
		...(gate.parentId === null ? [] : [gate.parentId]),
		...(gate.geometry.type === "boolean" ? gate.geometry.refs : []),
	];
}

function reference<T>(map: Map<string, T>, id: string): T {
	const item = map.get(id);
	if (!item) throw new ModelError("MISSING_REFERENCE", `Missing reference: ${id}`);
	return item;
}

/** Validate an untrusted in-memory document without executing transforms or compute. */
export function validateWorkspace(value: unknown): asserts value is WorkspaceDocument {
	jsonValue(value);
	const doc = fields(
		value,
		["schemaVersion", "id", "revision", "samples", "gates", "groups", "annotations"],
		["agentEdit"],
	);
	if (doc.schemaVersion !== 1)
		throw new ModelError("UNSUPPORTED_CAPABILITY", "Workspace schema version");
	text(doc.id);
	integer(doc.revision);
	if ("agentEdit" in doc) edit(doc.agentEdit, doc.revision);
	const samples = identified(doc.samples);
	for (const sample of samples.values()) {
		fields(sample, ["id", "file", "channels"]);
		const file = fields(sample.file, ["sha256", "basename", "size"]);
		text(file.sha256);
		if (!/^[a-f0-9]{64}$/.test(file.sha256)) invalid("Expected lowercase SHA-256 hex");
		text(file.basename);
		if (/[\\/]/.test(file.basename)) invalid("Expected basename, not path");
		integer(file.size);
		for (const channel of identified(sample.channels).values()) {
			fields(channel, ["id", "name"], ["transform"]);
			text(channel.name);
			if ("transform" in channel) {
				const t = object(channel.transform);
				if (t.type === "unsupported") {
					fields(t, ["type", "originalType", "element", "attributes"]);
					text(t.originalType);
					text(t.element);
					const attributes = object(t.attributes);
					if (Object.keys(attributes).length > 128)
						invalid("Too many unsupported transform attributes");
					for (const [key, value] of Object.entries(attributes)) {
						text(key);
						if (typeof value !== "string" || value.length > 4096)
							invalid("Invalid unsupported transform attribute");
					}
					continue;
				}
				const allowed =
					t.type === "linear"
						? ["minRange", "maxRange", "gain"]
						: t.type === "log"
							? ["offset", "decades", "minRange", "maxRange"]
							: t.type === "biex"
								? ["width", "neg", "pos", "maxRange", "channelRange", "length"]
								: null;
				if (!allowed)
					throw new ModelError("UNSUPPORTED_CAPABILITY", `Transform: ${JSON.stringify(t.type)}`);
				fields(t, ["type"], allowed);
				for (const key of allowed)
					if (key in t && typeof t[key] !== "number") invalid("Invalid transform parameter");
			}
		}
	}
	const gates = identified(doc.gates);
	for (const gate of gates.values()) {
		gateShape(gate, true, doc.revision);
		const g = gate as unknown as Gate;
		const sample = reference(samples, g.sampleId);
		const channels = identified(sample.channels);
		for (const dimension of g.dimensions) reference(channels, dimension);
		for (const id of dependencies(g)) {
			if (reference(gates, id).sampleId !== g.sampleId) invalid("Cross-sample gate dependency");
		}
	}
	// Kahn's algorithm avoids recursion limits for deep gate hierarchies.
	const degrees = new Map<string, number>();
	const reverse = new Map<string, string[]>();
	for (const [id, gate] of gates) {
		const deps = new Set(dependencies(gate as unknown as Gate));
		degrees.set(id, deps.size);
		for (const dep of deps) {
			const list = reverse.get(dep) ?? [];
			list.push(id);
			reverse.set(dep, list);
		}
	}
	const ready = [...degrees].filter(([, n]) => n === 0).map(([id]) => id);
	for (let i = 0; i < ready.length; i++) {
		for (const id of reverse.get(ready[i] as string) ?? []) {
			const n = (degrees.get(id) as number) - 1;
			degrees.set(id, n);
			if (!n) ready.push(id);
		}
	}
	if (ready.length !== gates.size)
		throw new ModelError("CYCLE", "Gate dependencies contain a cycle");
	for (const group of identified(doc.groups).values()) {
		fields(group, ["id", "name", "sampleIds"]);
		text(group.name);
		for (const id of strings(group.sampleIds)) reference(samples, id);
	}
	for (const annotation of identified(doc.annotations).values()) {
		fields(annotation, ["id", "gateId", "text"], provenanceFields);
		text(annotation.text);
		if (annotation.gateId !== null) {
			text(annotation.gateId);
			reference(gates, annotation.gateId);
		}
		provenance(annotation, doc.revision);
	}
}

/** Stable object-key ordering; array order remains meaningful. Call only on validated JSON. */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) as string;
}
