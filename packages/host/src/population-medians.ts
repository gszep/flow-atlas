import {
	EmptyMedianSelectionError,
	type Kernels,
	type MedianChunk,
	MedianNumericalError,
	type MedianSummary,
	summarizeMedians,
} from "@flow-atlas/compute";
import { type FcsFile, openFcs } from "@flow-atlas/fcs";
import { type ArtifactStore, canonical, digest, fileSource } from "./artifact-store.js";
import { AnalysisError, type OperationArgs, validateOperation } from "./contracts.js";
import { evaluateGateChunk, type ResolvedGateCounts, resolveGateCounts } from "./gate-counts.js";

export type PopulationMedianRequest = OperationArgs<"start_population_medians">;
export interface ResolvedPopulationMedians {
	request: PopulationMedianRequest;
	recipeHash: string;
	metadataHash: string;
	startEvent: number;
	eventCount: number;
	totalEventVisits: number;
	gateBinding: ResolvedGateCounts | null;
}
export interface PopulationMedianResult {
	populationId: string | null;
	coordinateSpace: "stored-f32";
	channels: readonly string[];
	count: number;
	lower: readonly number[];
	upper: readonly number[];
	ranks: { indexBase: 0; lower: number; upper: number };
	diagnostics: MedianSummary["diagnostics"];
	gateNumericalPolicy: string | null;
}
function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
export function resolvePopulationMedians(
	input: PopulationMedianRequest,
	metadata: Omit<FcsFile, "data">,
): ResolvedPopulationMedians {
	if (Buffer.byteLength(canonical(input)) > 64 * 1024)
		throw new AnalysisError(
			"POPULATION_REQUEST_TOO_LARGE",
			"Population median recipe exceeds 64 KiB",
		);
	const request = validateOperation(
		"start_population_medians",
		structuredClone(input),
	) as PopulationMedianRequest;
	const names = metadata.channels.map((channel) => channel.name);
	if (
		!names.length ||
		names.length > 4096 ||
		new Set(names).size !== names.length ||
		new Set(request.channels).size !== request.channels.length ||
		request.channels.some((name) => !names.includes(name))
	)
		throw new AnalysisError(
			"INVALID_POPULATION_CHANNEL",
			"Median targets require unique exact channels in a source with at most 4096 unique parameters",
		);
	const startEvent = request.startEvent ?? 0,
		eventCount = request.eventCount ?? metadata.eventCount - startEvent;
	if (
		!Number.isSafeInteger(metadata.eventCount) ||
		!Number.isSafeInteger(startEvent) ||
		!Number.isSafeInteger(eventCount) ||
		startEvent < 0 ||
		eventCount < 0 ||
		eventCount > 0xffffffff ||
		startEvent > metadata.eventCount ||
		eventCount > metadata.eventCount - startEvent
	)
		throw new AnalysisError(
			"INVALID_POPULATION_RANGE",
			"Median ranges must lie within the file and contain at most 4294967295 source rows",
		);
	let gateBinding: ResolvedGateCounts | null = null;
	if (request.populationId === null) {
		if (request.gates.length)
			throw new AnalysisError(
				"INVALID_POPULATION_RECIPE",
				"The selected root uses an empty gate recipe",
			);
	} else {
		if (!request.gates.some((gate) => gate.id === request.populationId))
			throw new AnalysisError(
				"INVALID_POPULATION_RECIPE",
				"Selected population is missing from the gate recipe",
			);
		gateBinding = resolveGateCounts(
			{
				sampleId: request.sampleId,
				coordinateSpace: request.coordinateSpace,
				gates: request.gates,
				startEvent,
				eventCount,
			},
			metadata,
		);
		// Validate the complete supplied recipe, but do not dispatch unrelated gates
		// four times. Reverse topological order visits each consumer before its deps.
		const needed = new Set([request.populationId]);
		for (const index of [...gateBinding.order].reverse()) {
			const gate = gateBinding.request.gates[index];
			if (!gate || !needed.has(gate.id)) continue;
			if (gate.parentId !== null) needed.add(gate.parentId);
			if (gate.geometry.type === "boolean") for (const ref of gate.geometry.refs) needed.add(ref);
		}
		if (needed.size !== gateBinding.request.gates.length)
			gateBinding = resolveGateCounts(
				{
					...gateBinding.request,
					gates: gateBinding.request.gates.filter((gate) => needed.has(gate.id)),
				},
				metadata,
			);
	}
	const metadataHash = digest(metadata);
	return freeze({
		request,
		metadataHash,
		startEvent,
		eventCount,
		totalEventVisits: eventCount * 4,
		gateBinding,
		recipeHash: digest({
			profile: "gated-population-median-ranks-f32-v1",
			request,
			metadataHash,
			startEvent,
			eventCount,
			gateRecipeHash: gateBinding?.recipeHash ?? null,
		}),
	});
}

/** One pinned source and four replay passes. Gate masks are computed on GPU,
 * read back as bounded Uint32 arrays, then consumed by the GPU rank primitive.
 * No CPU event membership, sorting or median arithmetic is used.
 */
export async function runPopulationMedians(
	k: Kernels,
	store: ArtifactStore,
	resolved: ResolvedPopulationMedians,
	maxBinding: number,
	chunkBytes: number,
	signal: AbortSignal,
	progress: (count: number, pass: number) => void,
): Promise<PopulationMedianResult> {
	signal.throwIfAborted();
	const file = await fileSource(store.inputPath(resolved.request.sampleId), store.root);
	try {
		await file.verify(resolved.request.sampleId, signal);
		const reader = await openFcs(file.source, { signal });
		if (digest(reader.metadata) !== resolved.metadataHash)
			throw new AnalysisError(
				"POPULATION_METADATA_MISMATCH",
				"Population source metadata changed after admission",
			);
		const limit = Math.min(
			maxBinding,
			128 * 2 ** 20,
			k.device.limits.maxStorageBufferBindingSize,
			k.device.limits.maxBufferSize,
			k.device.limits.maxComputeWorkgroupsPerDimension * 256 * 4,
		);
		if (!Number.isSafeInteger(limit) || limit < 256)
			throw new AnalysisError("POPULATION_RESOURCE_LIMIT", "Invalid population binding budget");
		const binding = resolved.gateBinding,
			names = reader.metadata.channels.map((channel) => channel.name);
		if (binding)
			for (const gate of binding.request.gates)
				if (gate.geometry.type === "polygon" && gate.geometry.vertices.length * 8 > limit)
					throw new AnalysisError(
						"POPULATION_RESOURCE_LIMIT",
						"Polygon vertices exceed binding limit",
					);
		const stride = names.length * 4,
			encoded = reader.metadata.channels.reduce((sum, channel) => sum + channel.bits / 8, 0);
		// Conservative overlap allowance for reader/generator transitions. Gate masks
		// are destroyed before median upload; count the larger live phase, plus 1 MiB
		// for median histograms, vertices, uniforms and scalar readbacks.
		const gateBytes =
			2 * (stride + encoded) +
			(binding?.channelNames.length ?? 0) * 8 +
			((binding?.request.gates.length ?? 0) + 2) * 4 +
			8;
		const medianBytes = 3 * stride + 2 * encoded + 8;
		const chunkEvents = Math.floor(
			Math.min(
				chunkBytes / stride,
				(128 * 2 ** 20 - 2 ** 20) / Math.max(gateBytes, medianBytes),
				limit / 4,
			),
		);
		if (chunkEvents < 1)
			throw new AnalysisError("ROW_TOO_LARGE", "Population event exceeds chunk budget");
		const selectedCounts = [0, 0, 0, 0];
		const gateIndex =
			binding?.request.gates.findIndex((gate) => gate.id === resolved.request.populationId) ?? -1;
		const chunks = async function* (pass: number): AsyncIterable<MedianChunk> {
			for await (const chunk of reader.chunks({
				startEvent: resolved.startEvent,
				eventCount: resolved.eventCount,
				chunkEvents,
				signal,
			})) {
				signal.throwIfAborted();
				if (binding) {
					const evaluated = await evaluateGateChunk(
						k,
						binding,
						chunk.data,
						names.length,
						limit,
						signal,
						resolved.request.populationId as string,
					);
					if (!evaluated.mask || evaluated.mask.length !== chunk.count)
						throw new AnalysisError(
							"POPULATION_MASK_MISMATCH",
							"Gate membership shape differs from source rows",
						);
					selectedCounts[pass] =
						(selectedCounts[pass] as number) + (evaluated.counts[gateIndex] as number);
					yield { data: chunk.data, mask: evaluated.mask };
				} else {
					selectedCounts[pass] = (selectedCounts[pass] as number) + chunk.count;
					yield chunk.data;
				}
				progress(chunk.count, pass);
			}
			await file.assertUnchanged();
		};
		let summary: MedianSummary;
		try {
			summary = await summarizeMedians(
				k,
				names,
				resolved.request.channels,
				chunks,
				Math.min(limit, chunkBytes),
				{ signal },
			);
		} catch (error) {
			if (error instanceof EmptyMedianSelectionError) {
				if (selectedCounts[0] !== 0)
					throw new AnalysisError(
						"POPULATION_MASK_MISMATCH",
						"Median selection disagrees with the gate count",
					);
				throw new AnalysisError("EMPTY_POPULATION", "The selected population has no median ranks", {
					populationId: resolved.request.populationId,
					count: 0,
					sourceRows: resolved.eventCount,
				});
			}
			if (error instanceof MedianNumericalError)
				throw new AnalysisError("NONFINITE_POPULATION_TARGET", error.message, {
					populationId: resolved.request.populationId,
					channels: resolved.request.channels,
				});
			throw error;
		}
		if (
			summary.diagnostics.sourceRows !== resolved.eventCount ||
			selectedCounts.some((count) => count !== summary.count)
		)
			throw new AnalysisError(
				"POPULATION_MASK_MISMATCH",
				"Gate counts and median replay support disagree",
			);
		await file.assertUnchanged();
		signal.throwIfAborted();
		return {
			populationId: resolved.request.populationId,
			coordinateSpace: "stored-f32",
			channels: summary.channels,
			count: summary.count,
			lower: summary.lower,
			upper: summary.upper,
			ranks: {
				indexBase: 0,
				lower: Math.floor((summary.count - 1) / 2),
				upper: Math.floor(summary.count / 2),
			},
			diagnostics: summary.diagnostics,
			gateNumericalPolicy: binding?.numericalPolicy ?? null,
		};
	} finally {
		await file.close();
	}
}
