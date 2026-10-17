import type { Kernels } from "@flow-atlas/compute";
import type { FcsFile } from "@flow-atlas/fcs";
import { type ArtifactStore, canonical, digest } from "./artifact-store.js";
import { AnalysisError, type OperationArgs, validateOperation } from "./contracts.js";
import { type ResolvedGateCounts, resolveGateCounts, runGateCounts } from "./gate-counts.js";

export type BatchCountRequest = OperationArgs<"start_batch_gate_counts">;

export interface BatchSampleBinding {
	sampleIndex: number;
	sampleId: string;
	label?: string;
	resolved: ResolvedGateCounts;
}

export interface ResolvedBatchCounts {
	request: BatchCountRequest;
	recipeHash: string;
	totalEvents: number;
	samples: BatchSampleBinding[];
}

export interface BatchCountResult {
	coordinateSpace: "stored-f32";
	numericalPolicy: string;
	sampleCount: number;
	gateCount: number;
	rowCount: number;
	samples: Array<{
		sampleIndex: number;
		sampleId: string;
		label?: string;
		startEvent: number;
		eventCount: number;
		rootCount: number;
		recipeHash: string;
	}>;
	rows: Array<{
		sampleIndex: number;
		gateIndex: number;
		count: number;
		parentCount: number;
		rootCount: number;
		frequencyOfParent: number | null;
		frequencyOfRoot: number | null;
	}>;
}

function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

/** Keep the original typed code and complete details under cause; never invent lineage. */
function sampleFailure(
	error: unknown,
	sampleIndex: number,
	sampleId: string,
	completedSamples: number,
	phase: "resolve" | "run",
): AnalysisError {
	const cause =
		error instanceof Error
			? {
					code: "code" in error && typeof error.code === "string" ? error.code : "ANALYSIS_ERROR",
					message: error.message,
					...("details" in error ? { details: error.details } : {}),
				}
			: { code: "ANALYSIS_ERROR", message: String(error) };
	return new AnalysisError(
		cause.code,
		`Batch sample ${sampleIndex} (${sampleId}) ${phase} failed: ${cause.message}`,
		{ sampleIndex, sampleId, completedSamples, phase, cause },
	);
}

/** Resolve every exact sample/channel/range binding before queue admission, without event reads. */
export async function resolveBatchCounts(
	input: BatchCountRequest,
	getSample: (id: string) => Promise<{ id: string; metadata: Omit<FcsFile, "data"> }>,
	signal?: AbortSignal,
): Promise<ResolvedBatchCounts> {
	signal?.throwIfAborted();
	if (Buffer.byteLength(canonical(input)) > 64 * 1024)
		throw new AnalysisError("BATCH_REQUEST_TOO_LARGE", "Batch gate recipe exceeds 64 KiB");
	// Own and freeze the recipe before the first asynchronous metadata lookup.
	const request = freeze(
		validateOperation("start_batch_gate_counts", structuredClone(input)) as BatchCountRequest,
	);
	if (request.samples.length * request.gates.length > 512)
		throw new AnalysisError(
			"BATCH_ROW_LIMIT",
			"Batch gate counts permit at most 512 sample/gate rows",
		);
	if (new Set(request.samples.map((sample) => sample.sampleId)).size !== request.samples.length)
		throw new AnalysisError("INVALID_BATCH_RECIPE", "Batch samples must have distinct sample IDs");
	const samples: BatchSampleBinding[] = [];
	let totalEvents = 0;
	// Sequential admission bounds transient metadata and fails at the first invalid source.
	for (const [sampleIndex, spec] of request.samples.entries()) {
		try {
			signal?.throwIfAborted();
			const source = await getSample(spec.sampleId);
			if (source.id !== spec.sampleId)
				throw new AnalysisError(
					"BATCH_SAMPLE_ID_MISMATCH",
					"Metadata lookup returned a different sample identity",
				);
			const resolved = resolveGateCounts(
				{
					sampleId: spec.sampleId,
					coordinateSpace: request.coordinateSpace,
					gates: request.gates,
					...(spec.startEvent === undefined ? {} : { startEvent: spec.startEvent }),
					...(spec.eventCount === undefined ? {} : { eventCount: spec.eventCount }),
				},
				source.metadata,
			);
			if (resolved.eventCount > Number.MAX_SAFE_INTEGER - totalEvents)
				throw new AnalysisError(
					"INVALID_BATCH_RANGE",
					"Total batch event count exceeds safe integers",
				);
			totalEvents += resolved.eventCount;
			samples.push({
				sampleIndex,
				sampleId: spec.sampleId,
				...(spec.label === undefined ? {} : { label: spec.label }),
				resolved,
			});
		} catch (error) {
			signal?.throwIfAborted();
			if (error instanceof Error && error.name === "AbortError") throw error;
			// No sample has been executed during admission, including earlier valid bindings.
			throw sampleFailure(error, sampleIndex, spec.sampleId, 0, "resolve");
		}
	}
	const recipeHash = digest({
		profile: "batch-stored-f32-gate-counts-v1",
		request,
		sources: samples.map(({ sampleIndex, sampleId, resolved }) => ({
			sampleIndex,
			sampleId,
			metadataHash: resolved.metadataHash,
			recipeHash: resolved.recipeHash,
			numericalPolicy: resolved.numericalPolicy,
			startEvent: resolved.startEvent,
			eventCount: resolved.eventCount,
		})),
	});
	return freeze({ request, recipeHash, totalEvents, samples });
}

/** Caller owns one GPU lease. Sequential sources reuse the existing bounded streaming runner. */
export async function runBatchCounts(
	k: Kernels,
	store: ArtifactStore,
	resolved: ResolvedBatchCounts,
	maxBinding: number,
	chunkBytes: number,
	signal: AbortSignal,
	progress: (
		delta: number,
		detail: { sampleIndex: number; sampleId: string; sampleProcessedEvents: number },
	) => void,
): Promise<BatchCountResult> {
	signal.throwIfAborted();
	const samples: BatchCountResult["samples"] = [];
	const rows: BatchCountResult["rows"] = [];
	let numericalPolicy: string | undefined;
	for (const binding of resolved.samples) {
		const { sampleIndex, sampleId } = binding;
		try {
			signal.throwIfAborted();
			let sampleProcessedEvents = 0;
			const result = await runGateCounts(
				k,
				store,
				binding.resolved,
				maxBinding,
				chunkBytes,
				signal,
				(delta) => {
					sampleProcessedEvents += delta;
					progress(delta, { sampleIndex, sampleId, sampleProcessedEvents });
				},
			);
			signal.throwIfAborted();
			if (numericalPolicy !== undefined && numericalPolicy !== result.numericalPolicy)
				throw new AnalysisError(
					"BATCH_POLICY_MISMATCH",
					"Batch sources produced different numerical policies",
				);
			numericalPolicy = result.numericalPolicy;
			if (result.counts.length !== resolved.request.gates.length)
				throw new AnalysisError(
					"BATCH_ROW_COUNT_MISMATCH",
					"Sample returned an unexpected number of gate rows",
				);
			for (const [gateIndex, row] of result.counts.entries()) {
				if (row.id !== resolved.request.gates[gateIndex]?.id)
					throw new AnalysisError(
						"BATCH_GATE_ORDER_MISMATCH",
						"Sample gate rows do not match recipe order",
					);
				rows.push({
					sampleIndex,
					gateIndex,
					count: row.count,
					parentCount: row.parentCount,
					rootCount: row.rootCount,
					frequencyOfParent: row.frequencyOfParent,
					frequencyOfRoot: row.frequencyOfRoot,
				});
			}
			samples.push({
				sampleIndex,
				sampleId,
				...(binding.label === undefined ? {} : { label: binding.label }),
				startEvent: result.startEvent,
				eventCount: result.eventCount,
				rootCount: result.rootCount,
				recipeHash: binding.resolved.recipeHash,
			});
		} catch (error) {
			// Preserve the actual abort reason and signal state; never convert cancellation
			// to an internal/typed batch error. Local rows are discarded on any failure.
			signal.throwIfAborted();
			throw sampleFailure(error, sampleIndex, sampleId, samples.length, "run");
		}
	}
	signal.throwIfAborted();
	if (numericalPolicy === undefined)
		throw new AnalysisError("INVALID_BATCH_RECIPE", "A batch must contain at least one sample");
	return {
		coordinateSpace: "stored-f32",
		numericalPolicy,
		sampleCount: samples.length,
		gateCount: resolved.request.gates.length,
		rowCount: rows.length,
		samples,
		rows,
	};
}
