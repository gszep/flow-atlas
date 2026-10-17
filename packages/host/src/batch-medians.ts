import type { Kernels } from "@flow-atlas/compute";
import type { FcsFile } from "@flow-atlas/fcs";
import { type ArtifactStore, canonical, digest } from "./artifact-store.js";
import { AnalysisError, type OperationArgs, validateOperation } from "./contracts.js";
import {
	type PopulationMedianResult,
	type ResolvedPopulationMedians,
	resolvePopulationMedians,
	runPopulationMedians,
} from "./population-medians.js";

export type BatchMedianRequest = OperationArgs<"start_batch_population_medians">;

export interface ResolvedBatchMedians {
	request: BatchMedianRequest;
	recipeHash: string;
	totalEventVisits: number;
	samples: Array<{
		sampleIndex: number;
		sampleId: string;
		label?: string;
		resolved: ResolvedPopulationMedians;
	}>;
}

export interface BatchMedianResult {
	coordinateSpace: "stored-f32";
	populationId: string | null;
	channels: readonly string[];
	sampleCount: number;
	channelCount: number;
	rowCount: number;
	samples: Array<{
		sampleIndex: number;
		sampleId: string;
		label?: string;
		startEvent: number;
		eventCount: number;
		count: number;
		ranks: PopulationMedianResult["ranks"];
		diagnostics: PopulationMedianResult["diagnostics"];
		gateNumericalPolicy: string | null;
		recipeHash: string;
	}>;
	rows: Array<{
		sampleIndex: number;
		channelIndex: number;
		lower: number;
		upper: number;
	}>;
}

function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

/** Backend errors retain their actual message/code/details, not transport-redacted fields. */
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

/** Metadata-only admission: snapshot all caller-owned arrays before the first await. */
export async function resolveBatchMedians(
	input: BatchMedianRequest,
	getSample: (id: string) => Promise<{ id: string; metadata: Omit<FcsFile, "data"> }>,
	signal?: AbortSignal,
): Promise<ResolvedBatchMedians> {
	signal?.throwIfAborted();
	if (Buffer.byteLength(canonical(input)) > 64 * 1024)
		throw new AnalysisError(
			"BATCH_REQUEST_TOO_LARGE",
			"Batch population median recipe exceeds 64 KiB",
		);
	const request = freeze(
		validateOperation(
			"start_batch_population_medians",
			structuredClone(input),
		) as BatchMedianRequest,
	);
	if (request.samples.length * request.channels.length > 512)
		throw new AnalysisError(
			"BATCH_ROW_LIMIT",
			"Batch population medians permit at most 512 sample/channel rows",
		);
	if (new Set(request.samples.map(({ sampleId }) => sampleId)).size !== request.samples.length)
		throw new AnalysisError("INVALID_BATCH_RECIPE", "Batch samples must have distinct sample IDs");
	const samples: ResolvedBatchMedians["samples"] = [];
	let totalEventVisits = 0;
	// Resolve serially to bound transient source metadata and stop at the first failure.
	for (const [sampleIndex, spec] of request.samples.entries()) {
		try {
			signal?.throwIfAborted();
			const source = await getSample(spec.sampleId);
			signal?.throwIfAborted();
			if (source.id !== spec.sampleId)
				throw new AnalysisError(
					"BATCH_SAMPLE_ID_MISMATCH",
					"Metadata lookup returned a different sample identity",
				);
			const resolved = resolvePopulationMedians(
				{
					sampleId: spec.sampleId,
					coordinateSpace: request.coordinateSpace,
					populationId: request.populationId,
					channels: request.channels,
					gates: request.gates,
					...(spec.startEvent === undefined ? {} : { startEvent: spec.startEvent }),
					...(spec.eventCount === undefined ? {} : { eventCount: spec.eventCount }),
				},
				source.metadata,
			);
			if (
				!Number.isSafeInteger(resolved.totalEventVisits) ||
				resolved.totalEventVisits < 0 ||
				resolved.totalEventVisits > Number.MAX_SAFE_INTEGER - totalEventVisits
			)
				throw new AnalysisError(
					"INVALID_BATCH_RANGE",
					"Total batch event visits exceed safe integers",
				);
			totalEventVisits += resolved.totalEventVisits;
			samples.push({
				sampleIndex,
				sampleId: spec.sampleId,
				...(spec.label === undefined ? {} : { label: spec.label }),
				resolved,
			});
		} catch (error) {
			signal?.throwIfAborted();
			if (error instanceof Error && error.name === "AbortError") throw error;
			// Metadata resolution has not executed any samples, even if earlier bindings succeeded.
			throw sampleFailure(error, sampleIndex, spec.sampleId, 0, "resolve");
		}
	}
	signal?.throwIfAborted();
	const recipeHash = digest({
		profile: "batch-stored-f32-population-median-ranks-v1",
		request,
		sources: samples.map(({ sampleIndex, sampleId, resolved }) => ({
			sampleIndex,
			sampleId,
			metadataHash: resolved.metadataHash,
			recipeHash: resolved.recipeHash,
			startEvent: resolved.startEvent,
			eventCount: resolved.eventCount,
			totalEventVisits: resolved.totalEventVisits,
			gateRecipeHash: resolved.gateBinding?.recipeHash ?? null,
		})),
	});
	return freeze({ request, recipeHash, totalEventVisits, samples });
}

/** Validate summary metadata only. Endpoints/support come from the reviewed GPU backend. */
function validateSummary(
	result: PopulationMedianResult,
	binding: ResolvedPopulationMedians,
): string {
	const expected = binding.request;
	if (!result || typeof result !== "object")
		throw new AnalysisError(
			"BATCH_RESULT_SHAPE_MISMATCH",
			"Population result must be a summary object",
		);
	if (
		result.coordinateSpace !== expected.coordinateSpace ||
		result.populationId !== expected.populationId ||
		!Array.isArray(result.channels) ||
		result.channels.length !== expected.channels.length ||
		expected.channels.some((channel, index) => channel !== result.channels[index])
	)
		throw new AnalysisError(
			"BATCH_CHANNEL_MISMATCH",
			"Population result does not match the requested coordinate space, population and channel order",
		);
	if (
		!Array.isArray(result.lower) ||
		!Array.isArray(result.upper) ||
		result.lower.length !== expected.channels.length ||
		result.upper.length !== expected.channels.length ||
		expected.channels.some(
			(_, index) =>
				!Number.isFinite(result.lower[index]) ||
				!Number.isFinite(result.upper[index]) ||
				(result.lower[index] as number) > (result.upper[index] as number),
		) ||
		!Number.isSafeInteger(result.count) ||
		result.count < 1 ||
		result.count > binding.eventCount ||
		!result.ranks ||
		result.ranks.indexBase !== 0 ||
		result.ranks.lower !== Math.floor((result.count - 1) / 2) ||
		result.ranks.upper !== Math.floor(result.count / 2) ||
		!result.diagnostics ||
		result.diagnostics.sourceRows !== binding.eventCount
	)
		throw new AnalysisError(
			"BATCH_RESULT_SHAPE_MISMATCH",
			"Population result has invalid endpoint, support or rank metadata",
		);
	if (
		result.gateNumericalPolicy !== (binding.gateBinding?.numericalPolicy ?? null) ||
		result.diagnostics.algorithm !== "gpu-radix256-exact-rank-v1" ||
		result.diagnostics.passCount !== 4 ||
		result.diagnostics.precision !== "exact-f32-rank-endpoints" ||
		result.diagnostics.scope !== "selected-population-not-vendor-parity" ||
		result.diagnostics.zeroPolicy !== "canonical-positive-zero" ||
		result.diagnostics.subnormalPolicy !== "preserve-integer-bit-order"
	)
		throw new AnalysisError(
			"BATCH_POLICY_MISMATCH",
			"Population result does not match the supported rank and bound gate numerical policies",
		);
	// Source row counts may differ. Scientific algorithm/precision policies must not.
	const { sourceRows: _sourceRows, ...policy } = result.diagnostics;
	return canonical({ ...policy, gateNumericalPolicy: result.gateNumericalPolicy });
}

/** Caller owns the GPU lease. No nested jobs, pooled populations or averaged endpoints. */
export async function runBatchMedians(
	k: Kernels,
	store: ArtifactStore,
	resolved: ResolvedBatchMedians,
	maxBinding: number,
	chunkBytes: number,
	signal: AbortSignal,
	progress: (
		delta: number,
		detail: {
			sampleIndex: number;
			sampleId: string;
			pass: number;
			populationId: string | null;
			sampleProcessedVisits: number;
		},
	) => void,
): Promise<BatchMedianResult> {
	signal.throwIfAborted();
	const samples: BatchMedianResult["samples"] = [],
		rows: BatchMedianResult["rows"] = [];
	let policy: string | undefined;
	for (const binding of resolved.samples) {
		const { sampleIndex, sampleId } = binding;
		try {
			signal.throwIfAborted();
			let sampleProcessedVisits = 0;
			const result = await runPopulationMedians(
				k,
				store,
				binding.resolved,
				maxBinding,
				chunkBytes,
				signal,
				(delta, pass) => {
					sampleProcessedVisits += delta;
					progress(delta, {
						sampleIndex,
						sampleId,
						pass,
						populationId: resolved.request.populationId,
						sampleProcessedVisits,
					});
				},
			);
			signal.throwIfAborted();
			const samplePolicy = validateSummary(result, binding.resolved);
			if (policy !== undefined && policy !== samplePolicy)
				throw new AnalysisError(
					"BATCH_POLICY_MISMATCH",
					"Batch sources produced incompatible median numerical policies",
				);
			policy = samplePolicy;
			for (let channelIndex = 0; channelIndex < resolved.request.channels.length; channelIndex++)
				rows.push({
					sampleIndex,
					channelIndex,
					lower: result.lower[channelIndex] as number,
					upper: result.upper[channelIndex] as number,
				});
			samples.push({
				sampleIndex,
				sampleId,
				...(binding.label === undefined ? {} : { label: binding.label }),
				startEvent: binding.resolved.startEvent,
				eventCount: binding.resolved.eventCount,
				count: result.count,
				ranks: { ...result.ranks },
				diagnostics: { ...result.diagnostics },
				gateNumericalPolicy: result.gateNumericalPolicy,
				recipeHash: binding.resolved.recipeHash,
			});
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof Error && error.name === "AbortError") throw error;
			// Nothing escapes until every source succeeds; discard all locally collected rows.
			throw sampleFailure(error, sampleIndex, sampleId, samples.length, "run");
		}
	}
	signal.throwIfAborted();
	if (policy === undefined)
		throw new AnalysisError("INVALID_BATCH_RECIPE", "A batch must contain at least one sample");
	return {
		coordinateSpace: "stored-f32",
		populationId: resolved.request.populationId,
		channels: [...resolved.request.channels],
		sampleCount: samples.length,
		channelCount: resolved.request.channels.length,
		rowCount: rows.length,
		samples,
		rows,
	};
}
