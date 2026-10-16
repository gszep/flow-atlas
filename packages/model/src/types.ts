import type { TransformSpec } from "@flow-atlas/transforms";
import type { GateGeometry } from "@flow-atlas/wsp";

/** Definition only. null bounds mean unbounded, never JSON-lossy infinities. */
export type RawGeometry =
	| { type: "rectangle"; min: (number | null)[]; max: (number | null)[] }
	| Extract<GateGeometry, { type: "polygon" | "boolean" }>;

export interface Channel {
	id: string;
	name: string;
	/** Display-only; never changes raw gate coordinates. */
	transform?: TransformSpec;
}

export interface Sample {
	id: string;
	file: { sha256: string; basename: string; size: number };
	/** Per-sample channels support differing panels and transform parameters. */
	channels: Channel[];
}

/** Read/preserve UI stamps; the agent transaction API cannot set or remove them. */
export interface Provenance {
	author?: string;
	modified?: string;
	agentEdit?: { agentId: string; revision: number };
}

export interface GateDefinition {
	id: string;
	sampleId: string;
	name: string;
	parentId: string | null;
	dimensions: string[];
	geometry: RawGeometry;
}

export interface Gate extends GateDefinition, Provenance {}
export interface Group {
	id: string;
	name: string;
	sampleIds: string[];
}
export interface Annotation extends Provenance {
	id: string;
	/** null attaches to the workspace; a gate ID attaches to that definition. */
	gateId: string | null;
	text: string;
}

export interface WorkspaceDocument {
	schemaVersion: 1;
	id: string;
	revision: number;
	samples: Sample[];
	gates: Gate[];
	groups: Group[];
	annotations: Annotation[];
	/** Last accepted agent transaction; a host should journal the returned change separately. */
	agentEdit?: { agentId: string; revision: number };
}

export type GateOperation =
	| { type: "addGate"; gate: GateDefinition }
	| { type: "updateGate"; id: string; changes: Partial<Omit<GateDefinition, "id">> }
	| { type: "deleteGate"; id: string; mode: "reject" | "cascade" };

export interface Transaction {
	expectedRevision: number;
	agentId: string;
	operations: GateOperation[];
}

export type ModelErrorCode =
	| "INVALID_DOCUMENT"
	| "UNSUPPORTED_CAPABILITY"
	| "REVISION_CONFLICT"
	| "MISSING_REFERENCE"
	| "CYCLE"
	| "DEPENDENTS_EXIST"
	| "HUMAN_FINALIZED";

export class ModelError extends Error {
	override name = "ModelError";
	constructor(
		public readonly code: ModelErrorCode,
		message: string,
	) {
		super(message);
	}
}
