import type { EmbedOptions } from "./workspace.js";

export interface WallPhases {
	input: number;
	parseTransformsGating: number;
	featurePreparation: number;
	somTraining: number;
	mapEmbedProjection: number;
	displayPreparation: number;
	total: number;
}
export function embeddingSettings(options: EmbedOptions, eventCount: number) {
	if (!Number.isSafeInteger(eventCount) || eventCount < 1)
		throw new Error("Invalid computation event count");
	const trainMax = options.trainMax ?? 500000;
	// Mirror the existing codebook mean/SD row selection in computeEmbedding;
	// switching SOM training modes does not change this initialization step.
	const initializationStride = Math.max(1, Math.floor(eventCount / 200000));
	return {
		algorithm: "SOM + EmbedSOM",
		grid: { x: options.xdim ?? 20, y: options.ydim ?? 20 },
		epochs: options.epochs ?? 20,
		initializationStats: "strided",
		initializationStatsStride: initializationStride,
		initializationStatsRows: Math.floor(eventCount / initializationStride),
		training: {
			scope: "per-SOM-training-epoch",
			mode: trainMax >= eventCount ? "all-events" : "bounded",
			trainMax,
			stride: Math.max(1, Math.ceil(eventCount / trainMax)),
			actualSelectedCount: null,
			selection:
				"Existing window-local strided sampler; selected count is not instrumented, and window boundaries reset sampling.",
		},
		seeds: {
			imputation: options.seed ?? 1,
			initialization: options.seed ?? 42,
			training: options.seed ?? 42,
		},
	};
}
export interface ComputationRecord {
	schemaVersion: 1;
	completedAt: string;
	profile: string;
	source: {
		kind: "local" | "synthetic" | "publication";
		inputFileCount: number;
		sampleCount: number;
		publication?: unknown;
	};
	settings: ReturnType<typeof embeddingSettings>;
	projectedEventCount: number;
	renderedEventCount: number;
	featureCount: number;
	features: string[];
	renderScope: string;
	gpu: {
		adapterDescription: string | null;
		effectiveStorageWindowBytes: number;
		deviceMaxStorageBindingBytes: number;
		deviceMaxBufferBytes: number;
	};
	wallMs: WallPhases;
	timingScope: string;
	gpuTimestampMeasurement: false;
	resources: {
		gpuMemoryBytes: null;
		gpuUtilizationPercent: null;
		browserMemoryBytes: null;
		cpuUtilizationPercent: null;
		scope: string;
	};
}
type RecordNode = { textContent: string | null };
type PanelNode = { hidden: boolean };
export function clearComputationRecord(node: RecordNode, panel: PanelNode): void {
	node.textContent = "";
	panel.hidden = true;
}
export function publishComputationRecord(
	record: ComputationRecord,
	node: RecordNode,
	panel: PanelNode,
): void {
	clearComputationRecord(node, panel);
	const { total, ...phases } = record.wallMs;
	if (
		Object.values(record.wallMs).some((value) => !Number.isFinite(value) || value < 0) ||
		Object.values(phases).reduce((sum, value) => sum + value, 0) > total + 1
	)
		throw new Error("Inconsistent wall-clock computation timings");
	if (
		record.gpuTimestampMeasurement !== false ||
		record.projectedEventCount !== record.renderedEventCount ||
		record.featureCount !== record.features.length ||
		record.gpu.effectiveStorageWindowBytes > 128 * 2 ** 20 ||
		record.gpu.effectiveStorageWindowBytes > record.gpu.deviceMaxStorageBindingBytes
	)
		throw new Error("Inconsistent computation metadata");
	node.textContent = JSON.stringify(record);
	panel.hidden = false;
}
