import {
	type Gate,
	type GateOperation,
	ModelError,
	type Transaction,
	type WorkspaceDocument,
} from "./types.js";
import {
	canonical,
	dependencies,
	fields,
	gateShape,
	integer,
	invalid,
	jsonValue,
	object,
	text,
	validateWorkspace,
} from "./validation.js";

export * from "./types.js";
export { validateWorkspace } from "./validation.js";

export function createWorkspace(id: string): WorkspaceDocument {
	const document: WorkspaceDocument = {
		schemaVersion: 1,
		id,
		revision: 0,
		samples: [],
		gates: [],
		groups: [],
		annotations: [],
	};
	validateWorkspace(document);
	return document;
}

/** Import boundary, NOT an authorized edit endpoint. UI stamps may only come from trusted storage/UI. */
export function parseWorkspace(json: string): WorkspaceDocument {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		invalid("Invalid JSON");
	}
	validateWorkspace(value);
	return value;
}

export function serializeWorkspace(document: WorkspaceDocument): string {
	validateWorkspace(document);
	return `${canonical(document)}\n`;
}

function affected(gates: Gate[], seeds: Iterable<string>): Set<string> {
	const reverse = new Map<string, string[]>();
	for (const gate of gates) {
		for (const dep of dependencies(gate)) {
			const list = reverse.get(dep) ?? [];
			list.push(gate.id);
			reverse.set(dep, list);
		}
	}
	const result = new Set(seeds);
	for (const id of result) for (const child of reverse.get(id) ?? []) result.add(child);
	return result;
}

function operation(value: unknown): asserts value is GateOperation {
	const op = object(value);
	switch (op.type) {
		case "addGate":
			fields(op, ["type", "gate"]);
			gateShape(op.gate);
			break;
		case "updateGate":
			fields(op, ["type", "id", "changes"]);
			text(op.id);
			fields(op.changes, [], ["sampleId", "name", "parentId", "dimensions", "geometry"]);
			break;
		case "deleteGate":
			fields(op, ["type", "id", "mode"]);
			text(op.id);
			if (op.mode !== "reject" && op.mode !== "cascade")
				invalid("Expected reject or cascade delete mode");
			break;
		default:
			throw new ModelError("UNSUPPORTED_CAPABILITY", `Operation: ${JSON.stringify(op.type)}`);
	}
}

export interface TransactionResult {
	document: WorkspaceDocument;
	changed: boolean;
	/** Changed definitions plus transitive dependents, including deleted IDs, for external cache invalidation. */
	invalidatedGateIds: string[];
	deletedAnnotationIds: string[];
}

/**
 * Pure atomic transaction. No input is mutated, including on rejection. All references/cycles
 * are checked on the final candidate, allowing forward references within a batch.
 * The host supplies authenticated agentId and serializes compare-and-swap publication; this
 * function does not provide storage, locking, authentication, compute, or human finalization.
 */
export function applyTransaction(
	document: WorkspaceDocument,
	transaction: Transaction,
): TransactionResult {
	validateWorkspace(document);
	jsonValue(transaction);
	const tx = fields(transaction, ["expectedRevision", "agentId", "operations"]);
	integer(tx.expectedRevision);
	text(tx.agentId);
	if (tx.expectedRevision !== document.revision)
		throw new ModelError(
			"REVISION_CONFLICT",
			`Expected revision ${tx.expectedRevision}; current revision ${document.revision}`,
		);
	if (!Array.isArray(tx.operations)) invalid("Expected operations array");
	const candidate = parseWorkspace(serializeWorkspace(document));
	for (const raw of tx.operations) {
		operation(raw);
		// Clone the payload so the result never aliases caller-owned arrays or objects.
		const op = JSON.parse(canonical(raw)) as GateOperation;
		if (op.type === "addGate") {
			if (candidate.gates.some((gate) => gate.id === op.gate.id))
				invalid(`Duplicate ID: ${op.gate.id}`);
			candidate.gates.push(op.gate);
			continue;
		}
		const index = candidate.gates.findIndex((gate) => gate.id === op.id);
		const gate = candidate.gates[index];
		if (!gate) throw new ModelError("MISSING_REFERENCE", `Missing gate: ${op.id}`);
		if (op.type === "updateGate") {
			const next = { ...gate, ...op.changes };
			gateShape(next, true, document.revision);
			candidate.gates[index] = next;
		} else {
			const removed = affected(candidate.gates, [op.id]);
			const annotations = candidate.annotations.filter(
				(a) => a.gateId !== null && removed.has(a.gateId),
			);
			if (op.mode === "reject" && (removed.size > 1 || annotations.length))
				throw new ModelError(
					"DEPENDENTS_EXIST",
					`Gate ${op.id} has dependent gates or annotations`,
				);
			candidate.gates = candidate.gates.filter((g) => !removed.has(g.id));
			candidate.annotations = candidate.annotations.filter(
				(a) => a.gateId === null || !removed.has(a.gateId),
			);
		}
	}
	validateWorkspace(candidate);
	if (canonical(candidate) === canonical(document))
		return {
			document: candidate,
			changed: false,
			invalidatedGateIds: [],
			deletedAnnotationIds: [],
		};
	const before = new Map(document.gates.map((g) => [g.id, g]));
	const after = new Map(candidate.gates.map((g) => [g.id, g]));
	const changed = new Set(
		[...before.keys(), ...after.keys()].filter(
			(id) => canonical(before.get(id) ?? null) !== canonical(after.get(id) ?? null),
		),
	);
	const impacted = affected([...document.gates, ...candidate.gates], changed);
	for (const gate of document.gates) {
		if (gate.author !== undefined && impacted.has(gate.id))
			throw new ModelError("HUMAN_FINALIZED", `Human-finalized gate affected: ${gate.id}`);
	}
	const annotationsAfter = new Map(candidate.annotations.map((a) => [a.id, a]));
	for (const annotation of document.annotations) {
		// Cascading deletion can remove an annotation even if every gate is recreated unchanged.
		const annotationChanged =
			canonical(annotation) !== canonical(annotationsAfter.get(annotation.id) ?? null);
		if (
			annotation.author !== undefined &&
			(annotationChanged || (annotation.gateId !== null && impacted.has(annotation.gateId)))
		)
			throw new ModelError(
				"HUMAN_FINALIZED",
				`Human-finalized annotation affected: ${annotation.id}`,
			);
	}
	if (document.revision === Number.MAX_SAFE_INTEGER) invalid("Revision exhausted");
	candidate.revision++;
	candidate.agentEdit = { agentId: tx.agentId, revision: candidate.revision };
	for (const gate of candidate.gates)
		if (changed.has(gate.id)) gate.agentEdit = { ...candidate.agentEdit };
	validateWorkspace(candidate);
	const retainedAnnotations = new Set(candidate.annotations.map((a) => a.id));
	return {
		document: candidate,
		changed: true,
		invalidatedGateIds: [...impacted].sort(),
		deletedAnnotationIds: document.annotations
			.filter((a) => !retainedAnnotations.has(a.id))
			.map((a) => a.id)
			.sort(),
	};
}

/** Bounded, deterministic gate page without geometry, results, or unbounded dependency lists. */
export function inspectWorkspace(
	document: WorkspaceDocument,
	options: { offset?: number; limit?: number } = {},
) {
	validateWorkspace(document);
	jsonValue(options);
	fields(options, [], ["offset", "limit"]);
	const { offset = 0, limit = 50 } = options;
	integer(offset);
	integer(limit);
	if (limit < 1 || limit > 100) invalid("Inspection limit must be 1..100");
	const gates = document.gates.slice(offset, offset + limit).map((gate) => ({
		id: gate.id,
		name: gate.name,
		sampleId: gate.sampleId,
		parentId: gate.parentId,
		type: gate.geometry.type,
		dependencyCount: new Set(dependencies(gate)).size,
		humanFinalized: gate.author !== undefined,
	}));
	return {
		id: document.id,
		revision: document.revision,
		counts: {
			samples: document.samples.length,
			channels: document.samples.reduce((n, s) => n + s.channels.length, 0),
			gates: document.gates.length,
			groups: document.groups.length,
			annotations: document.annotations.length,
		},
		gates,
		nextOffset: offset + gates.length < document.gates.length ? offset + gates.length : null,
		capabilities: {
			operations: ["addGate", "updateGate", "deleteGate"],
			geometry: ["rectangle", "polygon", "boolean"],
			compute: false,
			humanFinalization: false,
		},
	};
}
