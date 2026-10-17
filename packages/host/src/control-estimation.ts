import {
	type AcquisitionPlan,
	type CompensationDiagnostics,
	type ControlEstimationDiagnostics,
	EmptyMedianSelectionError,
	estimateControlMatrix,
	type Kernels,
	linearizeChunk,
	MedianNumericalError,
	type MedianSummary,
	prepareAcquisition,
	prepareCompensation,
	type RangeSelection,
	summarizeMedians,
} from "@flow-atlas/compute";
import { type FcsFile, openFcs } from "@flow-atlas/fcs";
import { type ArtifactStore, canonical, digest, fileSource } from "./artifact-store.js";
import { AnalysisError, type OperationArgs } from "./contracts.js";
import { type InputContext, inputContext } from "./processing.js";

export type ControlRequest = OperationArgs<"start_control_estimation">;
export interface ControlSample {
	id: string;
	metadata: Omit<FcsFile, "data">;
}
export interface PopulationBinding {
	id: string;
	sampleId: string;
	startEvent: number;
	eventCount: number;
	selection: RangeSelection[];
	context: InputContext;
	definedBy: { controlIndex: number; role: "positive" | "negative" };
}
export interface ResolvedControls {
	request: ControlRequest;
	context: InputContext;
	populations: PopulationBinding[];
	controls: Array<{ primaryDetector: string; positiveId: string; negativeId: string }>;
	compatibility: Array<{
		field: string;
		status: "consistent-reported-values" | "unreported";
		value?: string;
		valueHash?: string;
		reportedSources: number;
		missingSources: number;
	}>;
	totalEventVisits: number;
	recipeHash: string;
}
export interface PopulationResult {
	populationId: string;
	sampleId: string;
	context: InputContext;
	definedBy: PopulationBinding["definedBy"];
	startEvent: number;
	eventCount: number;
	count: number;
	lower: readonly number[];
	upper: readonly number[];
	diagnostics: MedianSummary["diagnostics"];
	acquisition: {
		profile: string;
		parameterHash: string;
		timeChannel: string | null;
		timeStep: number;
	} | null;
}
export interface ControlResult {
	channels: string[];
	matrix: number[];
	estimationDiagnostics: ControlEstimationDiagnostics;
	applicationDiagnostics: CompensationDiagnostics;
	populations: PopulationResult[];
}

function indices(sample: ControlSample, names: readonly string[]): number[] {
	return names.map((name) => {
		const found = sample.metadata.channels.flatMap((channel, index) =>
			channel.name === name ? [index] : [],
		);
		if (found.length !== 1)
			throw new AnalysisError(
				"INVALID_CONTROL_CHANNEL",
				`Control channel is missing or ambiguous: ${name}`,
			);
		return found[0] as number;
	});
}
function eligible(sample: ControlSample, channels: readonly string[], context: InputContext): void {
	if (context.acquisition?.timeChannel && channels.includes(context.acquisition.timeChannel))
		throw new AnalysisError(
			"INVALID_CONTROL_CHANNEL",
			"A temporal acquisition parameter cannot be a compensation detector",
		);
	const selected = indices(sample, channels);
	if (
		context.inputSpace === "stored" &&
		selected.some((index) => {
			const channel = sample.metadata.channels[index];
			return channel?.gain !== 1 || channel.amplification.some((value) => value !== 0);
		})
	) {
		throw new AnalysisError(
			"ACQUISITION_SCALE_UNSUPPORTED",
			"Stored-space control detectors must be linear and unit-gain; choose explicit linearization otherwise",
		);
	}
}

/** Resolve metadata/selection bindings before queue admission; no event arithmetic here. */
export async function resolveControls(
	request: ControlRequest,
	getSample: (id: string) => Promise<ControlSample>,
): Promise<ResolvedControls> {
	const separation = Math.fround(request.minPrimarySeparation ?? 0);
	if (
		!Number.isFinite(separation) ||
		(request.minPrimarySeparation !== undefined &&
			request.minPrimarySeparation !== 0 &&
			separation < 2 ** -126)
	)
		throw new AnalysisError(
			"INVALID_CONTROL_POLICY",
			"Primary separation must round to a finite normal F32 or zero",
		);
	if (Buffer.byteLength(canonical(request)) > 64 * 1024)
		throw new AnalysisError("CONTROL_REQUEST_TOO_LARGE", "Control recipe exceeds 64 KiB");
	const channels = request.channels;
	if (
		new Set(channels).size !== channels.length ||
		request.controls.length !== channels.length ||
		new Set(request.controls.map((control) => control.primaryDetector)).size !== channels.length ||
		request.controls.some((control) => !channels.includes(control.primaryDetector))
	) {
		throw new AnalysisError(
			"INVALID_CONTROL_MAPPING",
			"Exactly one positive/negative control pair is required for each unique detector",
		);
	}
	const sourceSamples = new Map<string, Map<string, { preview: string; hash: string }>>();
	const sample = async (id: string) => {
		const loaded = await getSample(id);
		if (!sourceSamples.has(id)) {
			const observed = new Map<string, { preview: string; hash: string }>();
			const add = (field: string, value?: string) => {
				const text = value?.trim();
				if (text) observed.set(field, { preview: text.slice(0, 256), hash: digest(text) });
			};
			for (const key of ["$CYT", "$CYTSN"]) add(key, loaded.metadata.keywords[key]);
			for (const name of channels) {
				const channel = loaded.metadata.channels[indices(loaded, [name])[0] as number];
				const value = loaded.metadata.keywords[`$P${channel?.index}V`];
				add(
					`voltage:${name}`,
					value === undefined || value.trim() === ""
						? undefined
						: Number.isFinite(Number(value))
							? String(Number(value))
							: value,
				);
			}
			sourceSamples.set(id, observed);
		}
		return loaded;
	};
	const target = await sample(request.sampleId);
	const context = inputContext(target.metadata, request);
	eligible(target, channels, context);
	const populations = new Map<string, PopulationBinding>();
	const bindings: ResolvedControls["controls"] = [];
	for (let i = 0; i < request.controls.length; i++) {
		const control = request.controls[i] as ControlRequest["controls"][number];
		const ids: string[] = [];
		for (const role of ["positive", "negative"] as const) {
			const spec = control[role],
				source = await sample(spec.sampleId);
			const sourceContext = inputContext(source.metadata, {
				inputSpace: context.inputSpace,
				...(spec.acquisition === undefined ? {} : { acquisition: spec.acquisition }),
			});
			eligible(source, channels, sourceContext);
			if (
				source.metadata.channels.length > 4096 ||
				new Set(source.metadata.channels.map((c) => c.name)).size !==
					source.metadata.channels.length
			)
				throw new AnalysisError(
					"INVALID_CONTROL_CHANNEL",
					"Median sources require at most 4096 unique channel names",
				);
			const startEvent = spec.startEvent ?? 0,
				eventCount = spec.eventCount ?? source.metadata.eventCount - startEvent;
			if (
				!Number.isSafeInteger(startEvent) ||
				!Number.isSafeInteger(eventCount) ||
				startEvent < 0 ||
				eventCount < 1 ||
				eventCount > 0xffffffff ||
				startEvent + eventCount > source.metadata.eventCount
			)
				throw new AnalysisError(
					"INVALID_CONTROL_RANGE",
					"Control source ranges must contain 1..4294967295 events within the file",
				);
			const selection = (spec.selection ?? [])
				.map((range) => ({
					...range,
					min: range.min === 0 ? 0 : range.min,
					max: range.max === 0 ? 0 : range.max,
				}))
				.sort((a, b) => (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0));
			if (new Set(selection.map((r) => r.channel)).size !== selection.length)
				throw new AnalysisError(
					"INVALID_CONTROL_SELECTION",
					"Each selection channel may appear once",
				);
			indices(
				source,
				selection.map((r) => r.channel),
			);
			for (const range of selection)
				if (
					[range.min, range.max].some(
						(value) => value !== null && (!Number.isFinite(value) || Math.fround(value) !== value),
					) ||
					(range.min !== null && range.max !== null && range.min > range.max)
				)
					throw new AnalysisError(
						"INVALID_CONTROL_SELECTION",
						"Selection bounds must be exact finite F32 values or null, with min <= max",
					);
			const definition = {
				sampleId: source.id,
				startEvent,
				eventCount,
				selection,
				context: sourceContext,
			};
			const id = digest({ ...definition, channels });
			if (!populations.has(id))
				populations.set(id, { ...definition, id, definedBy: { controlIndex: i, role } });
			ids.push(id);
		}
		bindings.push({
			primaryDetector: control.primaryDetector,
			positiveId: ids[0] as string,
			negativeId: ids[1] as string,
		});
	}
	const compatibility: ResolvedControls["compatibility"] = [];
	const check = (field: string) => {
		const observed = [...sourceSamples].flatMap(([sampleId, fields]) => {
			const value = fields.get(field);
			return value ? [{ sampleId, ...value }] : [];
		});
		if (new Set(observed.map((entry) => entry.hash)).size > 1)
			throw new AnalysisError(
				"CONTROL_METADATA_MISMATCH",
				"Known instrument/control settings disagree",
				{ field, observations: observed },
			);
		const value = observed[0];
		compatibility.push({
			field,
			status: value === undefined ? "unreported" : "consistent-reported-values",
			...(value === undefined ? {} : { value: value.preview, valueHash: value.hash }),
			reportedSources: observed.length,
			missingSources: sourceSamples.size - observed.length,
		});
	};
	for (const key of ["$CYT", "$CYTSN", ...channels.map((name) => `voltage:${name}`)]) check(key);
	const populationList = [...populations.values()];
	const recipe = {
		profile: "conventional-median-difference-primary-f32-v1",
		targetSampleId: target.id,
		context,
		channels,
		controls: bindings,
		populations: populationList,
		minEvents: request.minEvents,
		minPrimarySeparation: request.minPrimarySeparation ?? 0,
	};
	return {
		request: structuredClone(request),
		context,
		populations: populationList,
		controls: bindings,
		compatibility,
		totalEventVisits: populationList.reduce((sum, p) => sum + p.eventCount * 4, 0),
		recipeHash: digest(recipe),
	};
}

/** Call while holding the GPU lease: preprocessing uses the same device directly, without nested leases. */
export async function runControlEstimation(
	k: Kernels,
	store: ArtifactStore,
	resolved: ResolvedControls,
	target: ControlSample,
	maxBinding: number,
	chunkBytes: number,
	signal: AbortSignal,
	progress: (count: number, detail: { populationId: string; pass: number }) => void,
	onPopulation?: (result: PopulationResult) => void,
	onCandidate?: (
		candidate: Pick<ControlResult, "channels" | "matrix" | "estimationDiagnostics">,
	) => void,
): Promise<ControlResult> {
	const sources = new Map<string, Awaited<ReturnType<typeof fileSource>>>();
	const results = new Map<string, MedianSummary>();
	const populationResults: PopulationResult[] = [];
	try {
		for (const binding of resolved.populations) {
			signal.throwIfAborted();
			let file = sources.get(binding.sampleId);
			if (!file) {
				file = await fileSource(store.inputPath(binding.sampleId), store.root);
				try {
					await file.verify(binding.sampleId, signal);
					sources.set(binding.sampleId, file);
				} catch (error) {
					await file.close();
					throw error;
				}
			}
			const reader = await openFcs(file.source, { signal });
			const metadata = reader.metadata;
			if (canonical(inputContext(metadata, binding.context)) !== canonical(binding.context))
				throw new AnalysisError(
					"PROCESSING_CONTEXT_MISMATCH",
					"Control processing metadata changed after submission",
				);
			const stride = metadata.channels.length * 4,
				encoded = metadata.channels.reduce((sum, channel) => sum + channel.bits / 8, 0);
			const chunkEvents = Math.floor(
				Math.min(chunkBytes / stride, (128 * 2 ** 20) / (stride + encoded)),
			);
			if (chunkEvents < 1)
				throw new AnalysisError("ROW_TOO_LARGE", "Control event exceeds chunk budget");
			let acquisition: AcquisitionPlan | undefined;
			try {
				if (binding.context.inputSpace === "linearized")
					acquisition = await prepareAcquisition(
						k,
						metadata.channels,
						binding.context.acquisition ?? {},
						maxBinding,
					);
				const chunks = async function* (pass: number) {
					for await (const chunk of reader.chunks({
						startEvent: binding.startEvent,
						eventCount: binding.eventCount,
						chunkEvents,
						signal,
					})) {
						const data = acquisition
							? await linearizeChunk(k, acquisition, chunk.data, maxBinding)
							: chunk.data;
						yield data;
						progress(chunk.count, { populationId: binding.id, pass });
					}
					await file.assertUnchanged();
				};
				const summary = await summarizeMedians(
					k,
					metadata.channels.map((c) => c.name),
					resolved.request.channels,
					chunks,
					Math.min(chunkBytes, maxBinding),
					{ selection: binding.selection, signal },
				);
				results.set(binding.id, summary);
				const result: PopulationResult = {
					populationId: binding.id,
					sampleId: binding.sampleId,
					context: binding.context,
					definedBy: binding.definedBy,
					startEvent: binding.startEvent,
					eventCount: binding.eventCount,
					count: summary.count,
					lower: summary.lower,
					upper: summary.upper,
					diagnostics: summary.diagnostics,
					acquisition: acquisition
						? {
								profile: acquisition.metadata.profile,
								parameterHash: digest(acquisition.metadata),
								timeChannel: acquisition.timeChannel,
								timeStep: acquisition.metadata.timeStep,
							}
						: null,
				};
				populationResults.push(result);
				onPopulation?.(result);
				if (
					[...summary.lower, ...summary.upper].some(
						(value) => value !== 0 && Math.abs(value) < 2 ** -126,
					)
				)
					throw new AnalysisError(
						"UNSAFE_CONTROL_ENDPOINT",
						"The median rank is exact, but this estimator rejects subnormal endpoints",
						{
							populationId: binding.id,
							numericalPolicy: "normal-or-zero-conservative-intermediates",
						},
					);
			} catch (error) {
				if (error instanceof EmptyMedianSelectionError || error instanceof MedianNumericalError)
					throw new AnalysisError(
						error instanceof EmptyMedianSelectionError
							? "EMPTY_CONTROL_SELECTION"
							: "NONFINITE_CONTROL_TARGET",
						error.message,
						{ populationId: binding.id, sampleId: binding.sampleId, definedBy: binding.definedBy },
					);
				throw error;
			} finally {
				acquisition?.destroy();
			}
		}
		const controls = resolved.controls.map((control) => ({
			primaryDetector: control.primaryDetector,
			positive: results.get(control.positiveId) as MedianSummary,
			negative: results.get(control.negativeId) as MedianSummary,
		}));
		const estimated = await estimateControlMatrix(
			k,
			resolved.request.channels,
			controls,
			maxBinding,
			{
				minEvents: resolved.request.minEvents,
				minPrimarySeparation: resolved.request.minPrimarySeparation ?? 0,
			},
		);
		onCandidate?.({
			channels: [...estimated.channels],
			matrix: Array.from(estimated.matrix),
			estimationDiagnostics: estimated.diagnostics,
		});
		const application = await prepareCompensation(
			k,
			target.metadata.channels.map((c) => c.name),
			estimated,
			maxBinding,
		);
		try {
			for (const source of sources.values()) await source.assertUnchanged();
			signal.throwIfAborted();
			return {
				channels: [...estimated.channels],
				matrix: Array.from(estimated.matrix),
				estimationDiagnostics: estimated.diagnostics,
				applicationDiagnostics: application.diagnostics,
				populations: populationResults,
			};
		} finally {
			application.destroy();
		}
	} finally {
		await Promise.all([...sources.values()].map((source) => source.close()));
	}
}
