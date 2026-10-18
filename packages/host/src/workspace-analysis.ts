import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import type { FcsFile } from "@flow-atlas/fcs";
import {
	type Channel,
	type Gate,
	ModelError,
	parseWorkspace,
	type Sample,
	type WorkspaceDocument,
} from "@flow-atlas/model";
import { type ArtifactStore, canonical, fileSource } from "./artifact-store.js";
import { AnalysisError, boundedJson, type OperationArgs, validateOperation } from "./contracts.js";
import {
	type GateCountRequest,
	type ResolvedGateCounts,
	resolveGateCounts,
} from "./gate-counts.js";
import { type ResolvedPopulationMedians, resolvePopulationMedians } from "./population-medians.js";

export type WorkspaceCountRequest = OperationArgs<"start_workspace_gate_counts">;
export type WorkspaceMedianRequest = OperationArgs<"start_workspace_population_medians">;
type InspectRequest = OperationArgs<"inspect_workspace">;
type DocumentIdentity = {
	path: string;
	id: string;
	revision: number;
	sha256: string;
	bytes: number;
};
type GetSample = (
	id: string,
) => Promise<{ id: string; size: number; metadata: Omit<FcsFile, "data"> }>;

export interface WorkspaceBinding {
	profile: "workspace-stored-f32-admitted-snapshot-v1";
	semantics: "admitted-snapshot";
	document: DocumentIdentity;
	sample: { id: string; sha256: string; bytes: number };
	channels: Array<{ id: string; name: string }>;
	coordinateSpace: "stored-f32";
	displayTransformsApplied: false;
}
export interface ResolvedWorkspaceCounts {
	request: WorkspaceCountRequest;
	analysis: ResolvedGateCounts;
	workspace: WorkspaceBinding;
}
export interface ResolvedWorkspaceMedians {
	request: WorkspaceMedianRequest;
	analysis: ResolvedPopulationMedians;
	workspace: WorkspaceBinding;
}
type InspectionItem =
	| { id: string; file: Sample["file"]; channelCount: number; gateCount: number }
	| { id: string; name: string; transform: NonNullable<Channel["transform"]> | null }
	| {
			id: string;
			name: string;
			sampleId: string;
			parentId: string | null;
			type: Gate["geometry"]["type"];
			dependencyCount: number;
			dimensionCount: number;
			humanFinalized: boolean;
	  };
export interface WorkspaceInspection {
	document: DocumentIdentity;
	counts: { samples: number; channels: number; gates: number; groups: number; annotations: number };
	view: InspectRequest["view"];
	sampleId: string | null;
	offset: number;
	total: number;
	items: InspectionItem[];
	nextOffset: number | null;
	capabilities: {
		workspaceEdits: false;
		coordinateSpace: "stored-f32";
		displayTransformsApplied: false;
		analyses: ["gate-counts", "population-medians"];
	};
}

function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
function requestSnapshot<
	N extends
		| "inspect_workspace"
		| "start_workspace_gate_counts"
		| "start_workspace_population_medians",
>(name: N, input: OperationArgs<N>): OperationArgs<N> {
	if (Buffer.byteLength(canonical(input)) > 64 * 1024)
		throw new AnalysisError("WORKSPACE_REQUEST_TOO_LARGE", "Workspace request exceeds 64 KiB");
	return freeze(validateOperation(name, structuredClone(input)) as OperationArgs<N>);
}

/** Read one descriptor once, hash raw UTF-8 bytes, and never snapshot/import/write the document. */
async function readWorkspace(
	store: ArtifactStore,
	args: {
		path: string;
		expectedRevision?: number | undefined;
		expectedSha256?: string | undefined;
	},
	signal?: AbortSignal,
): Promise<{ document: DocumentIdentity; model: WorkspaceDocument }> {
	signal?.throwIfAborted();
	const lexical = relative(store.root, resolve(store.root, args.path));
	if (
		isAbsolute(args.path) ||
		win32.isAbsolute(args.path) ||
		isAbsolute(lexical) ||
		lexical === ".." ||
		lexical.startsWith(`..${sep}`)
	)
		throw new AnalysisError(
			"PATH_OUTSIDE_ROOT",
			"Workspace path must stay relative to the workspace root",
		);
	const file = await fileSource(join(store.root, args.path), store.root);
	let outcome:
		| { value: { document: DocumentIdentity; model: WorkspaceDocument } }
		| { error: unknown };
	try {
		signal?.throwIfAborted();
		const size = file.source.size;
		if (size > 1024 * 1024)
			throw new AnalysisError("WORKSPACE_TOO_LARGE", "Workspace document exceeds 1 MiB");
		const bytes = await file.source.read(0, size);
		signal?.throwIfAborted();
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new AnalysisError("WORKSPACE_ENCODING", "Workspace document must contain valid UTF-8");
		}
		let model: WorkspaceDocument;
		try {
			model = parseWorkspace(text);
		} catch (error) {
			if (error instanceof ModelError) throw new AnalysisError(error.code, error.message);
			throw error;
		}
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		if (args.expectedRevision !== undefined && args.expectedRevision !== model.revision)
			throw new AnalysisError(
				"WORKSPACE_REVISION_CONFLICT",
				"Workspace revision differs from the expected revision",
				{
					expectedRevision: args.expectedRevision,
					actualRevision: model.revision,
				},
			);
		if (args.expectedSha256 !== undefined && args.expectedSha256 !== sha256)
			throw new AnalysisError(
				"WORKSPACE_HASH_MISMATCH",
				"Workspace bytes differ from the expected SHA-256",
				{
					expectedSha256: args.expectedSha256,
					actualSha256: sha256,
				},
			);
		signal?.throwIfAborted();
		outcome = {
			value: freeze({
				document: { path: args.path, id: model.id, revision: model.revision, sha256, bytes: size },
				model,
			}),
		};
	} catch (error) {
		outcome = { error };
	}
	let cleanupError: { error: unknown } | undefined;
	try {
		await file.assertUnchanged();
	} catch (error) {
		cleanupError = { error };
	}
	try {
		await file.close();
	} catch (error) {
		cleanupError = { error };
	}
	// Decide error precedence after both cleanup attempts, rather than throwing
	// from finally and accidentally replacing an in-flight cancellation.
	signal?.throwIfAborted();
	if (cleanupError) throw cleanupError.error;
	if ("error" in outcome) throw outcome.error;
	return outcome.value;
}
function selectedSample(model: WorkspaceDocument, id: string): Sample {
	const sample = model.samples.find((candidate) => candidate.id === id);
	if (!sample)
		throw new AnalysisError(
			"WORKSPACE_SAMPLE_NOT_FOUND",
			"Selected sample does not exist in the workspace",
			{ sampleId: id },
		);
	return sample;
}
async function importedSample(sample: Sample, getSample: GetSample, signal?: AbortSignal) {
	signal?.throwIfAborted();
	let source: Awaited<ReturnType<GetSample>>;
	try {
		source = await getSample(sample.file.sha256);
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			throw new AnalysisError(
				"WORKSPACE_SAMPLE_NOT_IMPORTED",
				"Workspace sample hash has not been imported",
				{
					sampleId: sample.id,
					sha256: sample.file.sha256,
				},
			);
		throw error;
	}
	signal?.throwIfAborted();
	if (source.id !== sample.file.sha256 || source.size !== sample.file.size)
		throw new AnalysisError(
			"WORKSPACE_SAMPLE_MISMATCH",
			"Imported sample identity or byte size differs from the workspace declaration",
			{
				sampleId: sample.id,
				expectedSha256: sample.file.sha256,
				actualSha256: source.id,
				expectedBytes: sample.file.size,
				actualBytes: source.size,
			},
		);
	return source;
}

/** Resolve only used IDs. Distinct unused model aliases are not an ambiguity in the FCS mapping. */
function channelMapper(sample: Sample, metadata: Omit<FcsFile, "data">) {
	const byId = new Map(sample.channels.map((channel) => [channel.id, channel]));
	const multiplicity = new Map<string, number>();
	for (const channel of metadata.channels)
		multiplicity.set(channel.name, (multiplicity.get(channel.name) ?? 0) + 1);
	const used = new Map<string, { id: string; name: string }>();
	const name = (id: string): string => {
		const channel = byId.get(id);
		if (!channel)
			throw new AnalysisError(
				"WORKSPACE_CHANNEL_NOT_FOUND",
				"Selected channel ID does not exist in the workspace sample",
				{ sampleId: sample.id, channelId: id },
			);
		if (multiplicity.get(channel.name) !== 1)
			throw new AnalysisError(
				"WORKSPACE_CHANNEL_MISMATCH",
				"Workspace channel name is missing or ambiguous in the imported sample",
				{
					sampleId: sample.id,
					channelId: id,
					name: channel.name,
				},
			);
		used.set(id, { id, name: channel.name });
		return channel.name;
	};
	return { name, used };
}
function projectGate(gate: Gate, name: (id: string) => string): GateCountRequest["gates"][number] {
	// Source ownership is in WorkspaceBinding. UI/agent provenance remains on the
	// untouched source document, not on a numerical recipe or result.
	return {
		id: gate.id,
		name: gate.name,
		parentId: gate.parentId,
		dimensions: gate.dimensions.map(name),
		geometry: structuredClone(gate.geometry),
	};
}
function workspaceBinding(
	document: DocumentIdentity,
	sample: Sample,
	channels: Array<{ id: string; name: string }>,
): WorkspaceBinding {
	const binding: WorkspaceBinding = {
		profile: "workspace-stored-f32-admitted-snapshot-v1",
		semantics: "admitted-snapshot",
		document,
		sample: { id: sample.id, sha256: sample.file.sha256, bytes: sample.file.size },
		channels,
		coordinateSpace: "stored-f32",
		displayTransformsApplied: false,
	};
	if (Buffer.byteLength(canonical(binding)) > 32 * 1024)
		throw new AnalysisError(
			"WORKSPACE_BINDING_TOO_LARGE",
			"Workspace analysis binding exceeds 32 KiB",
		);
	return freeze(binding);
}

export async function resolveWorkspaceCounts(
	store: ArtifactStore,
	input: WorkspaceCountRequest,
	getSample: GetSample,
	signal?: AbortSignal,
): Promise<ResolvedWorkspaceCounts> {
	signal?.throwIfAborted();
	const request = requestSnapshot("start_workspace_gate_counts", input);
	const { document, model } = await readWorkspace(store, request, signal);
	const sample = selectedSample(model, request.sampleId);
	const definitions = model.gates.filter((gate) => gate.sampleId === sample.id);
	if (!definitions.length)
		throw new AnalysisError("WORKSPACE_NO_GATES", "Selected workspace sample has no gates");
	const source = await importedSample(sample, getSample, signal);
	const mapping = channelMapper(sample, source.metadata);
	const analysis = resolveGateCounts(
		{
			sampleId: sample.file.sha256,
			coordinateSpace: "stored-f32",
			gates: definitions.map((gate) => projectGate(gate, mapping.name)),
			...(request.startEvent === undefined ? {} : { startEvent: request.startEvent }),
			...(request.eventCount === undefined ? {} : { eventCount: request.eventCount }),
		},
		source.metadata,
	);
	const workspace = workspaceBinding(document, sample, [...mapping.used.values()]);
	signal?.throwIfAborted();
	return freeze({ request, analysis, workspace });
}

export async function resolveWorkspaceMedians(
	store: ArtifactStore,
	input: WorkspaceMedianRequest,
	getSample: GetSample,
	signal?: AbortSignal,
): Promise<ResolvedWorkspaceMedians> {
	signal?.throwIfAborted();
	const request = requestSnapshot("start_workspace_population_medians", input);
	const { document, model } = await readWorkspace(store, request, signal);
	const sample = selectedSample(model, request.sampleId);
	const definitions =
		request.populationId === null ? [] : model.gates.filter((gate) => gate.sampleId === sample.id);
	if (
		request.populationId !== null &&
		!definitions.some((gate) => gate.id === request.populationId)
	)
		throw new AnalysisError(
			"WORKSPACE_GATE_NOT_FOUND",
			"Selected population does not belong to the workspace sample",
			{
				sampleId: sample.id,
				populationId: request.populationId,
			},
		);
	const source = await importedSample(sample, getSample, signal);
	const mapping = channelMapper(sample, source.metadata);
	const gates = definitions.map((gate) => projectGate(gate, mapping.name));
	const channels = request.channels.map(mapping.name);
	const analysis = resolvePopulationMedians(
		{
			sampleId: sample.file.sha256,
			coordinateSpace: "stored-f32",
			populationId: request.populationId,
			gates,
			channels,
			...(request.startEvent === undefined ? {} : { startEvent: request.startEvent }),
			...(request.eventCount === undefined ? {} : { eventCount: request.eventCount }),
		},
		source.metadata,
	);
	const workspace = workspaceBinding(document, sample, [...mapping.used.values()]);
	signal?.throwIfAborted();
	return freeze({ request, analysis, workspace });
}

/** Read-only summaries, with byte-budget pagination; IDs are never truncated. */
export async function inspectWorkspaceFile(
	store: ArtifactStore,
	input: InspectRequest,
	signal?: AbortSignal,
): Promise<WorkspaceInspection> {
	signal?.throwIfAborted();
	const args = requestSnapshot("inspect_workspace", input);
	if (args.view === "samples" && args.sampleId !== undefined)
		throw new AnalysisError("INVALID_PARAMS", "The samples view does not accept a sampleId filter");
	if (args.view === "channels" && args.sampleId === undefined)
		throw new AnalysisError("INVALID_PARAMS", "The channels view requires sampleId");
	const { document, model } = await readWorkspace(store, args, signal);
	const sample = args.sampleId === undefined ? undefined : selectedSample(model, args.sampleId);
	const gateCounts = new Map<string, number>();
	for (const gate of model.gates)
		gateCounts.set(gate.sampleId, (gateCounts.get(gate.sampleId) ?? 0) + 1);
	const definitions = sample
		? model.gates.filter((gate) => gate.sampleId === sample.id)
		: model.gates;
	const total =
		args.view === "samples"
			? model.samples.length
			: args.view === "channels"
				? (sample as Sample).channels.length
				: definitions.length;
	const offset = args.offset ?? 0,
		limit = args.limit ?? 50;
	const result: WorkspaceInspection = {
		document,
		// Same aggregate counts as model.inspectWorkspace; avoid revalidating a parsed document.
		counts: {
			samples: model.samples.length,
			channels: model.samples.reduce((sum, item) => sum + item.channels.length, 0),
			gates: model.gates.length,
			groups: model.groups.length,
			annotations: model.annotations.length,
		},
		view: args.view,
		sampleId: args.sampleId ?? null,
		offset,
		total,
		items: [],
		nextOffset: offset < total ? offset : null,
		capabilities: {
			workspaceEdits: false,
			coordinateSpace: "stored-f32",
			displayTransformsApplied: false,
			analyses: ["gate-counts", "population-medians"],
		},
	};
	const itemAt = (index: number): InspectionItem => {
		if (args.view === "samples") {
			const item = model.samples[index] as Sample;
			return {
				id: item.id,
				file: structuredClone(item.file),
				channelCount: item.channels.length,
				gateCount: gateCounts.get(item.id) ?? 0,
			};
		}
		if (args.view === "channels") {
			const item = (sample as Sample).channels[index] as Channel;
			return {
				id: item.id,
				name: item.name,
				transform: item.transform === undefined ? null : structuredClone(item.transform),
			};
		}
		const gate = definitions[index] as Gate;
		return {
			id: gate.id,
			name: gate.name,
			sampleId: gate.sampleId,
			parentId: gate.parentId,
			type: gate.geometry.type,
			dimensionCount: gate.dimensions.length,
			dependencyCount: new Set([
				...(gate.parentId === null ? [] : [gate.parentId]),
				...(gate.geometry.type === "boolean" ? gate.geometry.refs : []),
			]).size,
			humanFinalized: gate.author !== undefined,
		};
	};
	boundedJson(result, 256 * 1024);
	for (let index = offset; index < total && result.items.length < limit; index++) {
		signal?.throwIfAborted();
		result.items.push(itemAt(index));
		result.nextOffset = index + 1 < total ? index + 1 : null;
		try {
			boundedJson(result, 256 * 1024);
		} catch (error) {
			if (!(error instanceof AnalysisError) || error.code !== "RESPONSE_TOO_LARGE") throw error;
			result.items.pop();
			if (!result.items.length) throw error;
			result.nextOffset = index;
			break;
		}
	}
	boundedJson(result, 256 * 1024);
	signal?.throwIfAborted();
	return freeze(result);
}
