import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	AcquisitionNumericalError,
	type AcquisitionPlan,
	acquireDevice,
	type CompensationDiagnostics,
	CompensationNumericalError,
	type CompensationPlan,
	ControlEstimationError,
	compensateChunk,
	KERNEL_SOURCES,
	Kernels,
	linearizeChunk,
	prepareAcquisition,
	prepareCompensation,
	prepareSpectralUnmixing,
	SpectralNumericalError,
	type SpectralPlan,
	unmixChunk,
} from "@flow-atlas/compute";
import { type FcsFile, openFcs, writeFcs } from "@flow-atlas/fcs";
import { ArtifactStore, canonical, digest, fileSource, writeAll } from "./artifact-store.js";
import {
	AnalysisError,
	type AnalysisService,
	boundedJson,
	operationSchemas,
	validateOperation,
} from "./contracts.js";
import {
	type ControlResult,
	type PopulationResult,
	type ResolvedControls,
	resolveControls,
	runControlEstimation,
} from "./control-estimation.js";
import {
	type InputContext,
	inputContext,
	type ProcessingRequest,
	parseTimeStep,
	processingMetadata,
	resolveContext,
	type SpectralDefinition,
} from "./processing.js";

type Metadata = Omit<FcsFile, "data">;
declare const __FLOW_ATLAS_BUILD_ID__: string;
const buildId =
	typeof __FLOW_ATLAS_BUILD_ID__ === "string" ? __FLOW_ATLAS_BUILD_ID__ : "unbundled-development";
interface Sample {
	id: string;
	name: string;
	path: string;
	size: number;
	metadata: Metadata;
	identity: string;
}
interface Compensation {
	id: string;
	sampleId: string;
	channels: string[];
	matrix: number[];
	diagnostics: CompensationDiagnostics;
	context: InputContext;
	estimation?: { jobId: string; recipeHash: string; profile: string; receiptPath: string };
}
interface ExportRequest extends ProcessingRequest {
	sampleId: string;
	compensationId?: string | undefined;
	unmixingId?: string | undefined;
	channels?: string[] | undefined;
	renameChannels?: Record<string, string> | undefined;
	keywords?: Record<string, string> | undefined;
	startEvent?: number | undefined;
	eventCount?: number | undefined;
	outputName?: string | undefined;
}
interface Job {
	kind?: "fcs-export" | "control-estimation";
	id: string;
	state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
	phase: string;
	processedEvents: number;
	totalEvents: number;
	createdAt: string;
	enqueuedAt: number;
	completedAt?: string;
	request: ExportRequest;
	plannedCompensation?: Compensation;
	plannedUnmixing?: SpectralDefinition;
	inputContext: InputContext;
	estimation?: ResolvedControls;
	controlEvidence?: PopulationResult[];
	controlCandidate?: Pick<ControlResult, "channels" | "matrix" | "estimationDiagnostics">;
	progressDetail?: { populationId: string; pass: number };
	abort: AbortController;
	error?: { code: string; message: string; details?: unknown };
	result?: {
		path: string;
		sha256: string;
		bytes: number;
		receiptPath: string;
		compensationId?: string;
	};
	receipt?: Record<string, unknown>;
	warnings?: Array<{ code: string; message: string; details?: unknown }>;
}
interface GpuContext {
	device: GPUDevice;
	kernels: Kernels;
	maxBinding: number;
	description: string;
	loss?: string;
}
interface ProcessingSelection {
	context: InputContext;
	metadata: Metadata;
	compensation?: Compensation;
	unmixing?: SpectralDefinition;
}
interface PreparedPipeline {
	acquisition?: AcquisitionPlan;
	compensation?: CompensationPlan;
	spectral?: SpectralPlan;
	apply(data: Float32Array): Promise<Float32Array>;
	destroy(): void;
}
export interface AnalysisOptions {
	root: string;
	/** Maximum decoded chunk bytes. At most 64 MiB, allowing 64-bit input decoding within 128 MiB. */
	maxChunkBytes?: number;
}

function failure(error: unknown): { code: string; message: string; details?: unknown } {
	if (error instanceof Error && error.name === "AbortError")
		return { code: "CANCELLED", message: "Operation cancelled" };
	if (
		error instanceof CompensationNumericalError ||
		error instanceof AcquisitionNumericalError ||
		error instanceof SpectralNumericalError ||
		error instanceof ControlEstimationError
	)
		return {
			code: error instanceof ControlEstimationError ? error.code : "NUMERICAL_REJECTION",
			message: error.message,
			details: JSON.parse(
				JSON.stringify(error.diagnostics, (_key, value: unknown) =>
					typeof value === "number" && !Number.isFinite(value) ? String(value) : value,
				),
			) as unknown,
		};
	if (error instanceof Error) {
		const code = "code" in error && typeof error.code === "string" ? error.code : "ANALYSIS_ERROR";
		return {
			code,
			message: error.message,
			...("details" in error ? { details: error.details } : {}),
		};
	}
	return { code: "ANALYSIS_ERROR", message: String(error) };
}

function linear(channels: Metadata["channels"]): void {
	const invalid = channels.filter(
		(c) => c.amplification[0] !== 0 || c.amplification[1] !== 0 || c.gain !== 1,
	);
	if (invalid.length)
		throw new AnalysisError(
			"ACQUISITION_SCALE_UNSUPPORTED",
			"Stored-space processing requires linear unit-gain channel values; explicitly select inputSpace=linearized for acquisition scaling",
			{ channels: invalid.map((c) => c.name) },
		);
}

/** Shared agent operation backend. Neither HTTP nor MCP owns scientific or file-processing logic. */
export async function createAnalysisService(options: AnalysisOptions): Promise<AnalysisService> {
	const bytes = options.maxChunkBytes ?? 4 * 2 ** 20;
	if (!Number.isSafeInteger(bytes) || bytes < 1024 || bytes > 64 * 2 ** 20)
		throw new AnalysisError("INVALID_CHUNK_SIZE", "Chunk size must be 1 KiB–64 MiB");
	return new FcsAnalysis(await ArtifactStore.create(options.root), bytes);
}

class FcsAnalysis implements AnalysisService {
	private readonly samples = new Map<string, Sample>();
	private readonly catalog = new Map<string, Record<string, unknown>>();
	private readonly compensations = new Map<string, Compensation>();
	private readonly unmixings = new Map<string, SpectralDefinition>();
	private readonly jobs = new Map<string, Job>();
	private readonly queue: Job[] = [];
	private readonly active = new Set<Promise<unknown>>();
	private readonly shutdown = new AbortController();
	private readonly instanceId = randomUUID();
	private running: Promise<void> | null = null;
	private pendingJobs = 0;
	private reservedCompensations = 0;
	private gpuPromise: Promise<GpuContext> | null = null;
	private gpuOwner: unknown = null;
	private gpuTail: Promise<void> = Promise.resolve();
	private closed = false;
	private closing: Promise<void> | null = null;

	constructor(
		private readonly store: ArtifactStore,
		private readonly chunkBytes: number,
	) {}

	async invoke(name: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
		if (this.closed) throw new AnalysisError("CLOSED", "Analysis service is closed");
		if (this.active.size >= 16) throw new AnalysisError("BUSY", "Too many concurrent requests");
		const combined = signal
			? AbortSignal.any([signal, this.shutdown.signal])
			: this.shutdown.signal;
		combined.throwIfAborted();
		const operation = this.dispatch(name, validateOperation(name, input), combined);
		this.active.add(operation);
		try {
			return structuredClone(await operation);
		} catch (error) {
			if (error instanceof AnalysisError) throw error;
			const detail = failure(error);
			throw new AnalysisError(detail.code, detail.message, detail.details);
		} finally {
			this.active.delete(operation);
		}
	}

	private async dispatch(name: string, input: unknown, signal: AbortSignal): Promise<unknown> {
		switch (name) {
			case "list_capabilities":
				operationSchemas.list_capabilities.parse(input);
				return {
					version: "flow-atlas-fcs-v3",
					buildId,
					inputFormats: ["FCS2.0", "FCS3.0", "FCS3.1"],
					outputFormat: "FCS3.1-F32-LE",
					decodedPrecision: "float32",
					compute: "WebGPU; no CPU fallback",
					compensation: "square conventional spillover; measured = true × spill",
					controlEstimation: {
						profile: "conventional-median-difference-primary-f32-v1",
						selection: "AND of inclusive exact-F32 ranges",
						passesPerPopulation: 4,
						minEvents: "required caller policy",
						scope: "explicit populations, not AutoSpill or biological QC",
					},
					acquisition: {
						inputSpaces: ["stored", "linearized"],
						explicitOnly: true,
						profile: "stored-to-acquisition-linear-f32-v1",
						gain: "divide ordinary channels by gain",
						log: "log0 * 10^(decades * stored / range) / gain; positive decades with zero log0 normalize log0 to one",
						time: "explicit exact parameter or unique case-insensitive Time; multiply by override/$TIMESTEP/default-one; ignore Time gain; nonlinear Time rejects",
					},
					spectral: {
						algorithm: "column-pivoted-householder-qr-f32",
						model: "measured = abundances × reference",
						originalColumns: "preserved in the selected input space",
						outputs: "appended fluorochromes and optional L2 residual",
					},
					limits: {
						maxControlDetectors: 32,
						chunkBytes: this.chunkBytes,
						maxCompensatedChannels: 128,
						maxSpectralDetectors: 128,
						maxSpectralFluorochromes: 128,
						maxAcquisitionChannels: 4096,
						maxActiveRequests: 16,
						maxQueuedJobs: 16,
						maxSamples: 4096,
						maxCachedSamples: 32,
						maxCompensations: 128,
						maxUnmixingDefinitions: 128,
						previewEvents: 100,
						previewChannels: 32,
					},
					unsupported: [
						"weighted spectral WLS/WOLS and SpectralFX",
						"nonlinear Time acquisition",
						"lossless float64/integer export",
						"multiple datasets",
						"AutoSpill and automatic control gate inference",
					],
					recovery:
						"Receipts survive restart; jobs do not automatically resume. Re-import the same source to recover its content-hash sample ID.",
				};
			case "import_fcs": {
				const args = operationSchemas.import_fcs.parse(input);
				const snapshot = await this.store.snapshot(args.path, signal);
				const sample = await this.loadSample(snapshot.sha256, snapshot.basename, signal);
				return this.summary(sample);
			}
			case "list_samples": {
				const args = operationSchemas.list_samples.parse(input);
				const offset = args.offset ?? 0,
					limit = args.limit ?? 20;
				return {
					total: this.catalog.size,
					offset,
					items: [...this.catalog.values()].slice(offset, offset + limit),
				};
			}
			case "inspect_fcs": {
				const args = operationSchemas.inspect_fcs.parse(input);
				const sample = await this.sample(args.sampleId, signal);
				const offset = args.channelOffset ?? 0,
					limit = args.channelLimit ?? 50;
				const keywordOffset = args.keywordOffset ?? 0;
				const keys = Object.keys(sample.metadata.keywords)
					.filter((key) => key.startsWith((args.keywordPrefix ?? "").toUpperCase()))
					.sort();
				return {
					...this.summary(sample),
					channelOffset: offset,
					channels: structuredClone(sample.metadata.channels.slice(offset, offset + limit)),
					keywordOffset,
					keywordTotal: keys.length,
					keywords: keys
						.slice(keywordOffset, keywordOffset + (args.keywordLimit ?? 20))
						.map((key) => {
							const value = sample.metadata.keywords[key] as string;
							return {
								key,
								value: value.slice(0, 1024),
								truncated: value.length > 1024,
								characters: value.length,
							};
						}),
					dataType: sample.metadata.keywords.$DATATYPE,
					decodedPrecision: "float32",
					spillover: sample.metadata.spill
						? { channels: sample.metadata.spill.channels, source: sample.metadata.spill.source }
						: null,
				};
			}
			case "get_spillover": {
				const args = operationSchemas.get_spillover.parse(input);
				const spill = (await this.sample(args.sampleId, signal)).metadata.spill;
				if (!spill)
					throw new AnalysisError(
						"NO_SPILLOVER",
						"The source has no embedded spillover matrix; provide an explicit matrix",
					);
				if (spill.channels.length > 128)
					throw new AnalysisError(
						"MATRIX_TOO_LARGE",
						"Embedded matrix exceeds the 128-channel response limit",
					);
				return {
					channels: [...spill.channels],
					matrix: Array.from(spill.matrix),
					source: spill.source,
					convention: "measured = true × spill",
				};
			}
			case "register_compensation": {
				const args = operationSchemas.register_compensation.parse(input);
				const sample = await this.sample(args.sampleId, signal);
				const context = inputContext(sample.metadata, args);
				const spill = args.spillover ?? sample.metadata.spill;
				if (!spill)
					throw new AnalysisError(
						"NO_SPILLOVER",
						"Provide an explicit matrix or import embedded spillover metadata",
					);
				if (
					spill.channels.length < 1 ||
					spill.channels.length > 128 ||
					spill.matrix.length !== spill.channels.length ** 2
				)
					throw new AnalysisError(
						"UNSUPPORTED_MATRIX_SHAPE",
						"Conventional compensation requires a square 1–128-channel matrix; spectral OLS/WLS are separate capabilities",
					);
				if (
					new Set(spill.channels).size !== spill.channels.length ||
					spill.channels.some((name) => !name)
				)
					throw new AnalysisError(
						"INVALID_MATRIX_CHANNELS",
						"Matrix channel names must be nonempty and unique",
					);
				const participating = spill.channels.map((name) => {
					const matches = sample.metadata.channels.filter((c) => c.name === name);
					if (matches.length !== 1)
						throw new AnalysisError(
							"INVALID_CHANNEL",
							`Compensation channel is missing or ambiguous: ${name}`,
						);
					return matches[0] as Metadata["channels"][number];
				});
				if (context.inputSpace === "stored") linear(participating);
				const matrix = Array.from(spill.matrix),
					channels = [...spill.channels];
				const id = digest({
					sampleId: sample.id,
					channels,
					matrix,
					algorithm: "gpu-conventional-v1",
					...(context.inputSpace === "linearized" ? { context } : {}),
				});
				const existing = this.compensations.get(id);
				if (existing) return this.compensationSummary(existing);
				if (this.compensations.size + this.reservedCompensations >= 128)
					throw new AnalysisError("MATRIX_LIMIT", "Session compensation limit reached");
				await this.validateAcquisition(sample, context, signal);
				const diagnostics = await this.withGpu(async (gpu) => {
					const plan = await prepareCompensation(
						gpu.kernels,
						sample.metadata.channels.map((c) => c.name),
						{ channels, matrix },
						gpu.maxBinding,
					);
					try {
						return structuredClone(plan.diagnostics);
					} finally {
						plan.destroy();
					}
				}, signal);
				signal.throwIfAborted();
				const record = { id, sampleId: sample.id, channels, matrix, diagnostics, context };
				if (
					!this.compensations.has(id) &&
					this.compensations.size + this.reservedCompensations >= 128
				)
					throw new AnalysisError("MATRIX_LIMIT", "Session compensation limit reached");
				this.compensations.set(id, record);
				return this.compensationSummary(record);
			}
			case "register_unmixing": {
				const args = operationSchemas.register_unmixing.parse(input);
				const sample = await this.sample(args.sampleId, signal);
				const context = inputContext(sample.metadata, args);
				if (
					args.fluorochromes.length > args.detectors.length ||
					args.matrix.length !== args.fluorochromes.length * args.detectors.length
				)
					throw new AnalysisError(
						"UNSUPPORTED_MATRIX_SHAPE",
						"Spectral OLS requires a fluorochrome-by-detector matrix with at least as many detectors as outputs",
					);
				if (args.outputRanges && args.outputRanges.length !== args.fluorochromes.length)
					throw new AnalysisError(
						"INVALID_OUTPUT_METADATA",
						"One nominal output range is required per fluorochrome",
					);
				if (args.residualRange !== undefined && args.residualChannel === undefined)
					throw new AnalysisError(
						"INVALID_OUTPUT_METADATA",
						"Residual range requires a named residual output",
					);
				if (
					[...args.fluorochromes, ...(args.residualChannel ? [args.residualChannel] : [])].some(
						(name) => name.toLowerCase() === "time",
					)
				)
					throw new AnalysisError(
						"INVALID_OUTPUT_METADATA",
						"Derived outputs must use names distinct from the Time acquisition axis",
					);
				const detectorIndices = this.indices(sample, args.detectors);
				if (context.inputSpace === "stored")
					linear(
						detectorIndices.map((i) => sample.metadata.channels[i] as Metadata["channels"][number]),
					);
				const definition = {
					sampleId: sample.id,
					detectors: [...args.detectors],
					fluorochromes: [...args.fluorochromes],
					matrix: [...args.matrix],
					...(args.residualChannel === undefined ? {} : { residualChannel: args.residualChannel }),
					outputRanges: args.outputRanges ?? args.fluorochromes.map(() => 262144),
					residualRange: args.residualRange ?? 262144,
					context,
				};
				const id = digest({ ...definition, algorithm: "spectral-ols-qr-f32-v1" });
				const existing = this.unmixings.get(id);
				if (existing) return this.unmixingSummary(existing);
				if (this.unmixings.size >= 128)
					throw new AnalysisError("MATRIX_LIMIT", "Session unmixing-definition limit reached");
				await this.validateAcquisition(sample, context, signal);
				const diagnostics = await this.withGpu(async (gpu) => {
					const plan = await prepareSpectralUnmixing(
						gpu.kernels,
						sample.metadata.channels.map((c) => c.name),
						definition,
						gpu.maxBinding,
					);
					try {
						return structuredClone(plan.diagnostics);
					} finally {
						plan.destroy();
					}
				}, signal);
				signal.throwIfAborted();
				if (!this.unmixings.has(id) && this.unmixings.size >= 128)
					throw new AnalysisError("MATRIX_LIMIT", "Session unmixing-definition limit reached");
				const record: SpectralDefinition = { ...definition, id, diagnostics };
				this.unmixings.set(id, record);
				return this.unmixingSummary(record);
			}
			case "preview_fcs": {
				const args = operationSchemas.preview_fcs.parse(input);
				const sample = await this.sample(args.sampleId, signal);
				const processing = this.processing(sample, args);
				const view = { ...sample, metadata: processing.metadata };
				const names = args.channels ?? view.metadata.channels.slice(0, 16).map((c) => c.name);
				const selected = this.indices(view, names);
				const offset = args.offset ?? 0;
				if (offset > sample.metadata.eventCount)
					throw new AnalysisError("INVALID_RANGE", "Preview starts past the sample");
				const count = Math.min(args.limit ?? 10, sample.metadata.eventCount - offset);
				const handle = await fileSource(sample.path, this.store.root);
				let pipeline: PreparedPipeline | undefined;
				try {
					if (handle.identity !== sample.identity)
						throw new AnalysisError(
							"INTEGRITY_ERROR",
							"Input artifact changed since metadata was read; re-import a verified source",
						);
					const reader = await openFcs(handle.source, { signal });
					pipeline = await this.pipeline(sample, processing, signal);
					const rows: Array<Array<number | null>> = [];
					for await (const chunk of reader.chunks({
						startEvent: offset,
						eventCount: count,
						chunkEvents: Math.min(
							Math.max(1, count),
							this.chunkEvents(sample, view.metadata.channels.length),
						),
						signal,
					})) {
						const values = await this.processChunk(pipeline, chunk.data, chunk.start, chunk.count);
						for (let row = 0; row < chunk.count; row++)
							rows.push(
								selected.map((i) => {
									const v = values[row * view.metadata.channels.length + i] as number;
									return Number.isFinite(v) ? v : null;
								}),
							);
					}
					await handle.assertUnchanged();
					return {
						sampleId: sample.id,
						offset,
						channels: names,
						rows,
						compensationId: processing.compensation?.id ?? null,
						unmixingId: processing.unmixing?.id ?? null,
						inputContext: processing.context,
						acquisition: this.acquisitionEvidence(pipeline.acquisition),
						columnRoles: names.map((name) => this.columnRole(processing, name)),
						sourceSpace:
							processing.context.inputSpace === "stored"
								? "stored numeric values decoded to float32; no acquisition gain, logarithmic or time conversion"
								: "acquisition-linear numeric values; explicit gain/log/time preprocessing",
						nonfiniteEncoding: "JSON null represents a nonfinite raw value",
					};
				} finally {
					pipeline?.destroy();
					await handle.close();
				}
			}
			case "start_control_estimation": {
				const request = operationSchemas.start_control_estimation.parse(input);
				const resolved = await resolveControls(request, (id) => this.sample(id, signal));
				signal.throwIfAborted();
				if (this.queue.length + this.pendingJobs >= 16)
					throw new AnalysisError("QUEUE_FULL", "Analysis queue is full");
				this.pendingJobs++;
				const job: Job = {
					kind: "control-estimation",
					id: randomUUID(),
					state: "queued",
					phase: "queued",
					processedEvents: 0,
					totalEvents: resolved.totalEventVisits,
					createdAt: new Date().toISOString(),
					enqueuedAt: performance.now(),
					request: { sampleId: request.sampleId, ...resolved.context },
					inputContext: resolved.context,
					estimation: resolved,
					controlEvidence: [],
					abort: new AbortController(),
				};
				try {
					await this.store.saveRun(job.id, { ...this.jobRecord(job), estimation: resolved });
					signal.throwIfAborted();
					this.jobs.set(job.id, job);
					this.queue.push(job);
					queueMicrotask(() => this.pump());
					return this.jobRecord(job);
				} catch (error) {
					await rm(join(this.store.runs, `${job.id}.json`), { force: true });
					throw error;
				} finally {
					this.pendingJobs--;
				}
			}
			case "start_fcs_export": {
				const request = operationSchemas.start_fcs_export.parse(input);
				const sample = await this.sample(request.sampleId, signal);
				const processing = this.processing(sample, request);
				const plannedCompensation = processing.compensation,
					plannedUnmixing = processing.unmixing;
				this.exportMetadata(sample, request, processing);
				if (this.queue.length + this.pendingJobs >= 16)
					throw new AnalysisError("QUEUE_FULL", "Export queue is full");
				this.pendingJobs++;
				const job: Job = {
					id: randomUUID(),
					state: "queued",
					phase: "queued",
					processedEvents: 0,
					totalEvents: request.eventCount ?? sample.metadata.eventCount - (request.startEvent ?? 0),
					createdAt: new Date().toISOString(),
					enqueuedAt: performance.now(),
					request: structuredClone(request),
					inputContext: structuredClone(processing.context),
					abort: new AbortController(),
					...(plannedCompensation
						? { plannedCompensation: structuredClone(plannedCompensation) }
						: {}),
					...(plannedUnmixing ? { plannedUnmixing: structuredClone(plannedUnmixing) } : {}),
				};
				try {
					await this.store.saveRun(job.id, {
						...this.jobRecord(job),
						plannedCompensation: job.plannedCompensation,
						plannedUnmixing: job.plannedUnmixing,
					});
					signal.throwIfAborted();
					this.jobs.set(job.id, job);
					this.queue.push(job);
					queueMicrotask(() => this.pump());
					return this.jobRecord(job);
				} catch (error) {
					await rm(join(this.store.runs, `${job.id}.json`), { force: true });
					throw error;
				} finally {
					this.pendingJobs--;
				}
			}
			case "get_job": {
				const args = operationSchemas.get_job.parse(input);
				const job = this.jobs.get(args.jobId);
				if (job) return this.jobRecord(job);
				const record = await this.persistedRun(args.jobId);
				const {
					receipt: _receipt,
					plannedCompensation: _planned,
					plannedUnmixing: _unmixing,
					estimation: _estimation,
					...status
				} = record;
				return {
					...status,
					live: false,
					message: "Persisted observation only; this host does not own a live job with this ID",
				};
			}
			case "cancel_job": {
				const args = operationSchemas.cancel_job.parse(input);
				const job = this.jobs.get(args.jobId);
				if (!job) throw new AnalysisError("JOB_NOT_ACTIVE", "This host does not own that job");
				const accepted =
					(job.state === "queued" || job.state === "running") &&
					job.phase !== "committing" &&
					job.phase !== "cleaning-up";
				if (accepted) {
					job.abort.abort();
					const queued = this.queue.indexOf(job);
					if (queued >= 0) {
						this.queue.splice(queued, 1);
						await this.executeJob(job);
					}
				}
				return { jobId: job.id, accepted, state: job.state };
			}
			case "get_receipt": {
				const args = operationSchemas.get_receipt.parse(input);
				const job = this.jobs.get(args.jobId);
				if (job && (job.state === "queued" || job.state === "running" || !job.receipt))
					throw new AnalysisError(
						"JOB_NOT_COMPLETE",
						"Receipt is available after the job finishes",
					);
				if (job) return job.receipt;
				const record = await this.persistedRun(args.jobId);
				if (!record.receipt)
					throw new AnalysisError(
						"JOB_NOT_COMPLETE",
						"No terminal receipt was recorded; jobs are not automatically resumed after restart",
					);
				return record.receipt;
			}
			default:
				throw new AnalysisError("UNKNOWN_OPERATION", `Unknown operation: ${name}`);
		}
	}

	private summary(sample: Sample) {
		return {
			sampleId: sample.id,
			sha256: sample.id,
			basename: sample.name,
			bytes: sample.size,
			version: sample.metadata.version,
			eventCount: sample.metadata.eventCount,
			channelCount: sample.metadata.channels.length,
			hasSpillover: !!sample.metadata.spill,
			source: this.store.relative(sample.path),
		};
	}
	private async loadSample(id: string, name = `${id}.fcs`, signal?: AbortSignal): Promise<Sample> {
		if (!this.catalog.has(id) && this.catalog.size >= 4096)
			throw new AnalysisError("SAMPLE_LIMIT", "Session sample catalog limit reached");
		const path = this.store.inputPath(id);
		const handle = await fileSource(path, this.store.root);
		try {
			await handle.verify(id, signal);
			const reader = await openFcs(handle.source, signal ? { signal } : {});
			const metadata = reader.metadata;
			if (Buffer.byteLength(JSON.stringify(metadata.keywords)) > 1024 * 1024)
				throw new AnalysisError("METADATA_TOO_LARGE", "Session metadata exceeds 1 MiB per sample");
			await handle.assertUnchanged();
			const sample = {
				id,
				name,
				path,
				size: handle.source.size,
				metadata,
				identity: handle.identity,
			};
			if (!this.catalog.has(id) && this.catalog.size >= 4096)
				throw new AnalysisError("SAMPLE_LIMIT", "Session sample catalog limit reached");
			this.samples.set(id, sample);
			this.catalog.set(id, this.summary(sample));
			while (this.samples.size > 32)
				this.samples.delete(this.samples.keys().next().value as string);
			return sample;
		} finally {
			await handle.close();
		}
	}
	private async sample(id: string, signal?: AbortSignal): Promise<Sample> {
		const found = this.samples.get(id);
		if (found) {
			this.samples.delete(id);
			this.samples.set(id, found);
			return found;
		}
		const name = this.catalog.get(id)?.basename;
		return this.loadSample(id, typeof name === "string" ? name : `${id}.fcs`, signal);
	}
	private indices(sample: Sample, names: string[]): number[] {
		if (new Set(names).size !== names.length)
			throw new AnalysisError("INVALID_CHANNEL", "Selected channel names must be unique");
		return names.map((name) => {
			const matches = sample.metadata.channels.flatMap((c, i) => (c.name === name ? [i] : []));
			if (matches.length !== 1)
				throw new AnalysisError("INVALID_CHANNEL", `Channel is missing or ambiguous: ${name}`);
			return matches[0] as number;
		});
	}
	private compensation(sample: Sample, id?: string): Compensation | undefined {
		if (id === undefined) return undefined;
		const comp = this.compensations.get(id);
		if (!comp || comp.sampleId !== sample.id)
			throw new AnalysisError(
				"INVALID_COMPENSATION",
				"Compensation must be registered for this exact input sample",
			);
		return comp;
	}
	private compensationSummary(comp: Compensation) {
		return {
			id: comp.id,
			sampleId: comp.sampleId,
			channels: [...comp.channels],
			matrixHash: digest(comp.matrix),
			diagnostics: structuredClone(comp.diagnostics),
			context: structuredClone(comp.context),
			estimation: comp.estimation ?? null,
		};
	}
	private unmixing(sample: Sample, id?: string): SpectralDefinition | undefined {
		if (id === undefined) return undefined;
		const definition = this.unmixings.get(id);
		if (!definition || definition.sampleId !== sample.id)
			throw new AnalysisError(
				"INVALID_UNMIXING",
				"Unmixing must be registered for this exact input sample",
			);
		return definition;
	}
	private unmixingSummary(definition: SpectralDefinition) {
		return {
			id: definition.id,
			sampleId: definition.sampleId,
			detectors: definition.detectors,
			fluorochromes: definition.fluorochromes,
			residualChannel: definition.residualChannel,
			outputRanges: definition.outputRanges,
			residualRange: definition.residualRange,
			matrixHash: digest(definition.matrix),
			context: definition.context,
			diagnostics: definition.diagnostics,
		};
	}
	private processing(sample: Sample, request: ExportRequest): ProcessingSelection {
		if (request.compensationId !== undefined && request.unmixingId !== undefined)
			throw new AnalysisError(
				"CONFLICTING_PROCESSING",
				"Choose conventional compensation or spectral OLS, not both",
			);
		const compensation = this.compensation(sample, request.compensationId);
		const unmixing = this.unmixing(sample, request.unmixingId);
		const context = resolveContext(
			sample.metadata,
			request,
			compensation?.context ?? unmixing?.context,
		);
		return {
			context,
			metadata: processingMetadata(sample.metadata, context, unmixing),
			...(compensation ? { compensation } : {}),
			...(unmixing ? { unmixing } : {}),
		};
	}
	private async acquisitionPlan(
		sample: Sample,
		context: InputContext,
		signal: AbortSignal,
	): Promise<AcquisitionPlan | undefined> {
		if (context.inputSpace === "stored") return undefined;
		return this.withGpu(
			(gpu) =>
				prepareAcquisition(
					gpu.kernels,
					sample.metadata.channels,
					context.acquisition ?? {},
					gpu.maxBinding,
				),
			signal,
		);
	}
	private async validateAcquisition(
		sample: Sample,
		context: InputContext,
		signal: AbortSignal,
	): Promise<void> {
		const plan = await this.acquisitionPlan(sample, context, signal);
		plan?.destroy();
	}
	private async pipeline(
		sample: Sample,
		processing: ProcessingSelection,
		signal: AbortSignal,
	): Promise<PreparedPipeline> {
		let acquisition: AcquisitionPlan | undefined,
			compensation: CompensationPlan | undefined,
			spectral: SpectralPlan | undefined;
		const destroy = () => {
			acquisition?.destroy();
			compensation?.destroy();
			spectral?.destroy();
		};
		const stage = async (name: string, action: () => Promise<Float32Array>) => {
			try {
				return await action();
			} catch (error) {
				if (
					error instanceof AcquisitionNumericalError ||
					error instanceof CompensationNumericalError ||
					error instanceof SpectralNumericalError
				) {
					const detail = failure(error);
					throw new AnalysisError(detail.code, detail.message, {
						...(detail.details as Record<string, unknown>),
						stage: name,
					});
				}
				throw error;
			}
		};
		try {
			acquisition = await this.acquisitionPlan(sample, processing.context, signal);
			if (processing.compensation)
				compensation = await this.plan(sample, processing.compensation, signal);
			if (processing.unmixing)
				spectral = await this.withGpu(
					(gpu) =>
						prepareSpectralUnmixing(
							gpu.kernels,
							sample.metadata.channels.map((c) => c.name),
							processing.unmixing as SpectralDefinition,
							gpu.maxBinding,
						),
					signal,
				);
			if (
				spectral &&
				canonical(spectral.outputChannelNames) !==
					canonical(processing.metadata.channels.map((channel) => channel.name))
			)
				throw new AnalysisError(
					"OUTPUT_LAYOUT_MISMATCH",
					"Spectral plan and export channel metadata disagree",
				);
			return {
				...(acquisition ? { acquisition } : {}),
				...(compensation ? { compensation } : {}),
				...(spectral ? { spectral } : {}),
				destroy,
				apply: async (data) => {
					let result = data;
					if (acquisition)
						result = await stage("acquisition", () =>
							this.withGpu(
								(gpu) =>
									linearizeChunk(
										gpu.kernels,
										acquisition as AcquisitionPlan,
										result,
										gpu.maxBinding,
									),
								signal,
							),
						);
					if (compensation)
						result = await stage("compensation", () =>
							this.apply(compensation as CompensationPlan, result, signal),
						);
					if (spectral)
						result = await stage("spectral-ols", () =>
							this.withGpu(
								(gpu) => unmixChunk(gpu.kernels, spectral as SpectralPlan, result, gpu.maxBinding),
								signal,
							),
						);
					return result;
				},
			};
		} catch (error) {
			destroy();
			throw error;
		}
	}
	private acquisitionEvidence(plan?: AcquisitionPlan) {
		if (!plan) return null;
		const { channels, ...metadata } = plan.metadata;
		return {
			...metadata,
			channelCount: channels.length,
			parameterHash: digest(plan.metadata),
			changedChannelCount: channels.filter((channel) => channel.operation !== "identity").length,
			log0NormalizedChannelCount: channels.filter((channel) => channel.log0Normalized).length,
			timeGainPolicy: plan.timeChannel === null ? "not-applicable" : "ignored",
		};
	}
	private async processChunk(
		pipeline: PreparedPipeline,
		data: Float32Array,
		sourceStartEvent: number,
		sourceEventCount: number,
	): Promise<Float32Array> {
		try {
			return await pipeline.apply(data);
		} catch (error) {
			if (error instanceof AnalysisError && error.code === "NUMERICAL_REJECTION")
				throw new AnalysisError(error.code, error.message, {
					...(error.details as Record<string, unknown>),
					sourceChunkStartEvent: sourceStartEvent,
					sourceChunkEventCount: sourceEventCount,
				});
			throw error;
		}
	}
	private columnRole(processing: ProcessingSelection, name: string): string {
		return processing.unmixing?.fluorochromes.includes(name)
			? "unmixed"
			: processing.unmixing?.residualChannel === name
				? "residual-l2"
				: processing.compensation?.channels.includes(name)
					? "compensated"
					: processing.context.inputSpace;
	}
	private chunkEvents(
		sample: Sample,
		outputChannelCount = sample.metadata.channels.length,
	): number {
		const decoded = sample.metadata.channels.length * 4;
		const largestStride = Math.max(decoded, outputChannelCount * 4);
		const encoded = sample.metadata.channels.reduce((sum, channel) => sum + channel.bits / 8, 0);
		const count = Math.floor(
			Math.min(this.chunkBytes / largestStride, (128 * 2 ** 20) / (decoded + encoded)),
		);
		if (count < 1)
			throw new AnalysisError("ROW_TOO_LARGE", "One event exceeds the configured chunk budget");
		return count;
	}
	private exportMetadata(
		sample: Sample,
		request: ExportRequest,
		processing = this.processing(sample, request),
	): Metadata {
		const start = request.startEvent ?? 0,
			count = request.eventCount ?? sample.metadata.eventCount - start;
		if (
			start > sample.metadata.eventCount ||
			count < 0 ||
			start + count > sample.metadata.eventCount
		)
			throw new AnalysisError("INVALID_RANGE", "Export range exceeds the sample");
		if (
			request.outputName !== undefined &&
			(!/^[^/\\]{1,120}\.fcs$/i.test(request.outputName) ||
				Array.from(request.outputName).some(
					(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
				) ||
				request.outputName === ".fcs" ||
				Buffer.byteLength(request.outputName) > 240)
		)
			throw new AnalysisError("INVALID_OUTPUT_NAME", "Output name must be a simple .fcs filename");
		const view = { ...sample, metadata: processing.metadata };
		const names = request.channels ?? view.metadata.channels.map((c) => c.name);
		const selected = this.indices(view, names);
		if (Object.keys(request.renameChannels ?? {}).some((name) => !names.includes(name)))
			throw new AnalysisError("INVALID_CHANNEL", "Rename keys must refer to selected channels");
		const renamed = (name: string): string =>
			request.renameChannels && Object.hasOwn(request.renameChannels, name)
				? (request.renameChannels[name] as string)
				: name;
		const channels = selected.map((i) => {
			const c = view.metadata.channels[i] as Metadata["channels"][number];
			if (i >= sample.metadata.channels.length && renamed(c.name).toLowerCase() === "time")
				throw new AnalysisError(
					"INVALID_OUTPUT_METADATA",
					"Derived outputs must not be renamed to the Time acquisition axis",
				);
			if (
				processing.context.inputSpace === "stored" &&
				(c.name.toLowerCase() === "time") !== (renamed(c.name).toLowerCase() === "time") &&
				["$TIMESTEP", "TIMESTEP"].some(
					(key) =>
						sample.metadata.keywords[key] !== undefined &&
						parseTimeStep(sample.metadata.keywords[key] as string) !== 1,
				)
			)
				throw new AnalysisError(
					"INVALID_OUTPUT_METADATA",
					"Linearize time values before changing a Time axis identity with non-unit TIMESTEP",
				);
			return { ...c, name: renamed(c.name) };
		});
		if (
			channels.some((c) => !c.name) ||
			new Set(channels.map((c) => c.name)).size !== channels.length
		)
			throw new AnalysisError(
				"INVALID_CHANNEL",
				"Output channel names must be nonempty and unique",
			);
		linear(channels);
		if (Buffer.byteLength(JSON.stringify(request.keywords ?? {})) > 64 * 1024)
			throw new AnalysisError("METADATA_TOO_LARGE", "Keyword changes exceed 64 KiB");
		for (const key of Object.keys(request.keywords ?? {})) {
			if (
				/^\$(?:BEGIN|END|BYTEORD|DATATYPE|MODE$|NEXTDATA|PAR$|TOT$|FIL$|P\d)|^\$?SPILL(?:OVER)?$/i.test(
					key,
				) ||
				/^FLOWATLAS_/i.test(key) ||
				(processing.context.inputSpace === "linearized" &&
					["$TIMESTEP", "TIMESTEP"].includes(key.toUpperCase()))
			)
				throw new AnalysisError(
					"MANAGED_KEYWORD",
					`Structural keyword is managed by the writer: ${key}`,
				);
		}
		const keywords = {
			...view.metadata.keywords,
			...Object.fromEntries(
				Object.entries(request.keywords ?? {}).map(([k, v]) => [k.toUpperCase(), v]),
			),
		};
		const timeEdits = Object.entries(request.keywords ?? {}).filter(([key]) =>
			["$TIMESTEP", "TIMESTEP"].includes(key.toUpperCase()),
		);
		if (timeEdits.length) {
			const steps = timeEdits.map(([, value]) => parseTimeStep(value));
			if (steps.some((value) => !Number.isFinite(value) || value <= 0 || value !== steps[0]))
				throw new AnalysisError(
					"INVALID_OUTPUT_METADATA",
					"TIMESTEP edits must specify one consistent positive number",
				);
			delete keywords.TIMESTEP;
			keywords.$TIMESTEP = String(steps[0]);
		}
		keywords.$FIL = request.outputName ?? `${sample.id.slice(0, 12)}.analysis.fcs`;
		keywords.FLOWATLAS_SOURCE_SHA256 = sample.id;
		const output: Metadata = { version: "FCS3.1", channels, keywords, eventCount: count };
		const comp = processing.compensation;
		if (comp) {
			keywords.FLOWATLAS_COMPENSATION_ID = comp.id;
			keywords.FLOWATLAS_COMPENSATED = "true";
		} else if (processing.unmixing) {
			keywords.FLOWATLAS_UNMIXING_ID = processing.unmixing.id;
			const originals = selected.some((index) => index < sample.metadata.channels.length);
			const derived = selected.some((index) => index >= sample.metadata.channels.length);
			keywords.FLOWATLAS_OUTPUT_LAYOUT =
				originals && derived
					? "original-plus-derived"
					: originals
						? "original-only"
						: "derived-only";
		} else if (sample.metadata.spill) {
			const spill = sample.metadata.spill;
			const kept = spill.channels.filter((name) => names.includes(name));
			if (kept.length && kept.length !== spill.channels.length)
				throw new AnalysisError(
					"INCOMPLETE_SPILLOVER",
					"Raw export cannot retain a partial spillover panel; compensate before dropping matrix channels",
				);
			if (kept.length) output.spill = { ...spill, channels: spill.channels.map(renamed) };
		}
		return output;
	}

	private async withGpu<T>(fn: (gpu: GpuContext) => Promise<T>, signal: AbortSignal): Promise<T> {
		const previous = this.gpuTail;
		let release: () => void = () => {};
		this.gpuTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			signal.throwIfAborted();
			this.gpuPromise ??= (async () => {
				const { create, globals } = await import("webgpu");
				Object.assign(globalThis, globals);
				const gpu = create(process.env.FLOW_ATLAS_GPU === "software" ? ["adapter=llvmpipe"] : []);
				this.gpuOwner = gpu;
				const info = await acquireDevice(gpu as unknown as GPU);
				const context: GpuContext = {
					device: info.device,
					kernels: new Kernels(info.device),
					maxBinding: Math.min(128 * 2 ** 20, info.limits.maxStorageBufferBindingSize),
					description: info.description,
				};
				void info.device.lost.then((loss) => {
					context.loss = loss.message || loss.reason;
				});
				return context;
			})();
			let gpu: GpuContext;
			try {
				gpu = await this.gpuPromise;
			} catch (error) {
				throw new AnalysisError("GPU_UNAVAILABLE", "WebGPU initialization failed", failure(error));
			}
			if (gpu.loss !== undefined) throw new AnalysisError("DEVICE_LOST", gpu.loss);
			try {
				return await fn(gpu);
			} catch (error) {
				if (gpu.loss !== undefined) throw new AnalysisError("DEVICE_LOST", gpu.loss);
				throw error;
			}
		} finally {
			release();
		}
	}
	private plan(sample: Sample, comp: Compensation, signal: AbortSignal): Promise<CompensationPlan> {
		return this.withGpu(
			(gpu) =>
				prepareCompensation(
					gpu.kernels,
					sample.metadata.channels.map((c) => c.name),
					comp,
					gpu.maxBinding,
				),
			signal,
		);
	}
	private apply(
		plan: CompensationPlan,
		data: Float32Array,
		signal: AbortSignal,
	): Promise<Float32Array> {
		return this.withGpu(
			// The event array is already chunk-bounded; persistent matrix buffers use the device limit.
			(gpu) => compensateChunk(gpu.kernels, plan, data, gpu.maxBinding),
			signal,
		);
	}
	private jobRecord(job: Job) {
		return {
			jobId: job.id,
			kind: job.kind ?? "fcs-export",
			progressUnit: job.estimation ? "event-visits" : "events",
			progressDetail: job.progressDetail,
			hostInstanceId: this.instanceId,
			live: true,
			state: job.state,
			phase: job.phase,
			processedEvents: job.processedEvents,
			totalEvents: job.totalEvents,
			createdAt: job.createdAt,
			completedAt: job.completedAt,
			request: job.estimation?.request ?? job.request,
			inputContext: job.inputContext,
			error: job.error,
			warnings: job.warnings,
			result: job.state === "succeeded" ? job.result : undefined,
		};
	}
	private async persistedRun(id: string): Promise<Record<string, unknown>> {
		const receipt = await this.store.readPublishedReceipt(id);
		if (
			receipt &&
			typeof receipt === "object" &&
			!Array.isArray(receipt) &&
			"jobId" in receipt &&
			receipt.jobId === id &&
			"state" in receipt &&
			receipt.state === "succeeded"
		) {
			const value = receipt as Record<string, unknown>;
			return {
				jobId: id,
				kind: value.operation === "control-estimation" ? "control-estimation" : "fcs-export",
				progressUnit: value.operation === "control-estimation" ? "event-visits" : "events",
				state: "succeeded",
				phase: "complete",
				result: value.output,
				request: value.recipe,
				inputContext: value.inputContext,
				processedEvents: value.eventCount ?? value.eventVisits,
				totalEvents: value.eventCount ?? value.eventVisits,
				receipt,
			};
		}
		const record = await this.store.readRun(id);
		if (
			!record ||
			typeof record !== "object" ||
			Array.isArray(record) ||
			!("jobId" in record) ||
			record.jobId !== id
		)
			throw new AnalysisError("INVALID_RECEIPT", "Invalid persisted job record");
		return record as Record<string, unknown>;
	}
	private pump(): void {
		if (this.running || this.closed) return;
		const job = this.queue.shift();
		if (!job) return;
		this.running = this.executeJob(job)
			.catch((error: unknown) => {
				if (job.state === "succeeded") {
					job.warnings ??= [];
					job.warnings.push(failure(error));
				} else {
					job.state = "failed";
					job.phase = "failed";
					job.error = failure(error);
				}
			})
			.finally(() => {
				this.running = null;
				this.pump();
			});
	}
	private async executeControlJob(job: Job): Promise<void> {
		const resolved = job.estimation as ResolvedControls;
		const signal = job.abort.signal;
		const staging = join(this.store.temporary, job.id),
			destination = join(this.store.outputs, job.id);
		const started = performance.now(),
			queueMs = started - job.enqueuedAt;
		let outcome: "succeeded" | "failed" | "cancelled" = "failed";
		let reserved = false;
		try {
			signal.throwIfAborted();
			job.state = "running";
			job.phase = "control-medians";
			await this.store.saveRun(job.id, { ...this.jobRecord(job), estimation: resolved });
			const target = await this.sample(resolved.request.sampleId, signal);
			if (
				canonical(inputContext(target.metadata, resolved.request)) !== canonical(resolved.context)
			)
				throw new AnalysisError(
					"PROCESSING_CONTEXT_MISMATCH",
					"Target context changed after control job admission",
				);
			await this.validateAcquisition(target, resolved.context, signal);
			const result = await this.withGpu(
				(gpu) =>
					runControlEstimation(
						gpu.kernels,
						this.store,
						resolved,
						target,
						gpu.maxBinding,
						this.chunkBytes,
						signal,
						(count, detail) => {
							job.processedEvents += count;
							job.progressDetail = detail;
						},
						(summary) => {
							job.controlEvidence?.push(summary);
						},
						(candidate) => {
							job.controlCandidate = candidate;
							job.phase = "validating-matrix";
						},
					),
				signal,
			);
			signal.throwIfAborted();
			const profile = result.estimationDiagnostics.profile;
			const id = digest({
				sampleId: target.id,
				channels: result.channels,
				matrix: result.matrix,
				algorithm: "gpu-conventional-v1",
				context: resolved.context,
				estimation: { profile, recipeHash: resolved.recipeHash },
			});
			const existing = this.compensations.get(id);
			if (!existing) {
				if (this.compensations.size + this.reservedCompensations >= 128)
					throw new AnalysisError("MATRIX_LIMIT", "No registry capacity for the estimated matrix");
				this.reservedCompensations++;
				reserved = true;
			}
			const receiptPath = this.store.relative(join(destination, "receipt.json"));
			const definition: Compensation = existing ?? {
				id,
				sampleId: target.id,
				channels: result.channels,
				matrix: result.matrix,
				diagnostics: result.applicationDiagnostics,
				context: resolved.context,
				estimation: { jobId: job.id, recipeHash: resolved.recipeHash, profile, receiptPath },
			};
			const matrixArtifact = {
				schemaVersion: 1,
				compensationId: id,
				sampleId: target.id,
				channels: result.channels,
				matrix: result.matrix,
				context: resolved.context,
				estimation: { profile, recipeHash: resolved.recipeHash, jobId: job.id },
				diagnostics: result.applicationDiagnostics,
			};
			const encoded = Buffer.from(`${boundedJson(matrixArtifact)}\n`);
			job.result = {
				path: this.store.relative(join(destination, "matrix.json")),
				sha256: createHash("sha256").update(encoded).digest("hex"),
				bytes: encoded.byteLength,
				receiptPath,
				compensationId: id,
			};
			const receipt = {
				schemaVersion: 1,
				operation: "control-estimation",
				jobId: job.id,
				state: "succeeded",
				hostInstanceId: this.instanceId,
				buildId,
				input: { sha256: target.id, role: "application-target-metadata" },
				inputContext: resolved.context,
				recipe: resolved.request,
				recipeHash: resolved.recipeHash,
				channels: result.channels,
				controls: resolved.controls,
				populations: result.populations,
				compatibility: resolved.compatibility,
				estimatedMatrix: matrixArtifact,
				estimationDiagnostics: result.estimationDiagnostics,
				output: job.result,
				progressUnit: "event-visits",
				eventVisits: job.processedEvents,
				distinctPopulationCount: result.populations.length,
				qcScope:
					"Reported metadata, support, primary separation and numerical conditioning; not biological validity or inferred-gate approval",
				precision: "exact F32 median ranks; F32 paired-difference and normalization arithmetic",
				gpu: { shaderHash: digest(KERNEL_SOURCES), adapter: (await this.gpuPromise)?.description },
				nodeVersion: process.version,
				platform: process.platform,
				maxChunkBytes: this.chunkBytes,
				timing: { queueMs, computationBeforePublicationMs: performance.now() - started },
			};
			const receiptBytes = Buffer.from(`${boundedJson(receipt, 256 * 1024)}\n`);
			await mkdir(staging, { mode: 0o700 });
			for (const [name, bytes] of [
				["matrix.json", encoded],
				["receipt.json", receiptBytes],
			] as const) {
				const handle = await open(join(staging, name), "wx", 0o600);
				try {
					await writeAll(handle, bytes);
					await handle.sync();
				} finally {
					await handle.close();
				}
			}
			signal.throwIfAborted();
			job.phase = "committing";
			await rename(staging, destination);
			this.compensations.set(id, definition);
			outcome = "succeeded";
			job.receipt = receipt;
		} catch (error) {
			outcome = signal.aborted ? "cancelled" : "failed";
			job.phase = "cleaning-up";
			job.error = failure(error);
			delete job.result;
			job.receipt = {
				schemaVersion: 1,
				operation: "control-estimation",
				jobId: job.id,
				state: outcome,
				hostInstanceId: this.instanceId,
				buildId,
				recipe: resolved.request,
				recipeHash: resolved.recipeHash,
				inputContext: resolved.context,
				populations: job.controlEvidence,
				candidate: job.controlCandidate,
				compatibility: resolved.compatibility,
				error: job.error,
				progressUnit: "event-visits",
				eventVisits: job.processedEvents,
			};
			try {
				boundedJson(job.receipt, 256 * 1024);
			} catch {
				job.receipt = {
					schemaVersion: 1,
					operation: "control-estimation",
					jobId: job.id,
					state: outcome,
					hostInstanceId: this.instanceId,
					buildId,
					recipe: resolved.request,
					recipeHash: resolved.recipeHash,
					error: job.error,
					eventVisits: job.processedEvents,
					evidenceOmitted: "Population endpoints and candidate exceed the MCP receipt budget",
					completedPopulationCount: job.controlEvidence?.length ?? 0,
				};
			}
		} finally {
			if (reserved) this.reservedCompensations--;
			try {
				await rm(staging, { recursive: true, force: true });
			} catch (error) {
				job.warnings ??= [];
				job.warnings.push(failure(error));
			}
			job.completedAt = new Date().toISOString();
			const phase = outcome === "succeeded" ? "complete" : outcome;
			try {
				await this.store.saveRun(job.id, {
					...this.jobRecord(job),
					state: outcome,
					phase,
					result: job.result,
					receipt: job.receipt,
				});
			} catch (error) {
				job.warnings ??= [];
				job.warnings.push(failure(error));
			}
			job.state = outcome;
			job.phase = phase;
			for (const [id, old] of this.jobs) {
				if (this.jobs.size <= 128) break;
				if (["succeeded", "failed", "cancelled"].includes(old.state)) this.jobs.delete(id);
			}
		}
	}

	private async executeJob(job: Job): Promise<void> {
		if (job.estimation) return this.executeControlJob(job);
		const signal = job.abort.signal;
		const staging = join(this.store.temporary, job.id);
		let pipeline: PreparedPipeline | undefined;
		let source: Awaited<ReturnType<typeof fileSource>> | undefined;
		let output: Awaited<ReturnType<typeof open>> | undefined;
		const started = performance.now();
		const queueMs = started - job.enqueuedAt;
		let outcome: "succeeded" | "failed" | "cancelled" = "failed";
		try {
			signal.throwIfAborted();
			job.state = "running";
			job.phase = "verifying-input";
			await this.store.saveRun(job.id, {
				...this.jobRecord(job),
				plannedCompensation: job.plannedCompensation,
				plannedUnmixing: job.plannedUnmixing,
			});
			const sample = await this.sample(job.request.sampleId, signal);
			source = await fileSource(sample.path, this.store.root);
			await source.verify(sample.id, signal);
			const processing = this.processing(sample, job.request);
			if (canonical(processing.context) !== canonical(job.inputContext))
				throw new AnalysisError(
					"PROCESSING_CONTEXT_MISMATCH",
					"Input processing context changed after job submission",
				);
			const comp = processing.compensation,
				unmixing = processing.unmixing;
			const metadata = this.exportMetadata(sample, job.request, processing);
			const view = { ...sample, metadata: processing.metadata };
			const names = job.request.channels ?? view.metadata.channels.map((c) => c.name);
			const indices = this.indices(view, names),
				par = view.metadata.channels.length;
			const chunkEvents = this.chunkEvents(sample, par);
			job.phase = "preparing-processing";
			const prepared = await this.pipeline(sample, processing, signal);
			pipeline = prepared;
			const reader = await openFcs(source.source, { signal });
			const setupMs = performance.now() - started;
			await mkdir(staging, { mode: 0o700 });
			const outputName = metadata.keywords.$FIL as string;
			output = await open(join(staging, outputName), "wx", 0o600);
			const hash = createHash("sha256");
			let bytes = 0;
			const self = this;
			async function* events() {
				for await (const chunk of reader.chunks({
					startEvent: job.request.startEvent ?? 0,
					eventCount: metadata.eventCount,
					chunkEvents,
					signal,
				})) {
					signal.throwIfAborted();
					job.phase = unmixing
						? "unmixing"
						: comp
							? "compensating"
							: processing.context.inputSpace === "linearized"
								? "linearizing"
								: "writing";
					const data = await self.processChunk(prepared, chunk.data, chunk.start, chunk.count);
					if (indices.length === par && indices.every((v, i) => v === i)) yield data;
					else {
						const selected = new Float32Array(chunk.count * indices.length);
						for (let row = 0; row < chunk.count; row++)
							for (let col = 0; col < indices.length; col++)
								selected[row * indices.length + col] = data[
									row * par + (indices[col] as number)
								] as number;
						yield selected;
					}
					job.processedEvents += chunk.count;
				}
			}
			for await (const chunk of writeFcs(metadata, events(), {
				chunkBytes: this.chunkBytes,
				signal,
			})) {
				signal.throwIfAborted();
				await writeAll(output, chunk);
				hash.update(chunk);
				bytes += chunk.byteLength;
			}
			await output.sync();
			await output.close();
			output = undefined;
			await source.assertUnchanged();
			signal.throwIfAborted();
			const destination = join(this.store.outputs, job.id);
			job.result = {
				path: this.store.relative(join(destination, outputName)),
				sha256: hash.digest("hex"),
				bytes,
				receiptPath: this.store.relative(join(destination, "receipt.json")),
			};
			const elapsedMs = performance.now() - started;
			const receipt = {
				schemaVersion: 1,
				operation: "fcs-export",
				jobId: job.id,
				state: "succeeded",
				input: { sha256: sample.id, bytes: sample.size },
				hostInstanceId: this.instanceId,
				buildId,
				output: job.result,
				eventCount: metadata.eventCount,
				channels: metadata.channels.map((channel) => channel.name),
				columnRoles: names.map((name) => this.columnRole(processing, name)),
				recipe: job.request,
				inputContext: processing.context,
				acquisition: this.acquisitionEvidence(pipeline.acquisition),
				compensation: comp
					? {
							algorithm: "gpu-conventional-v1",
							channels: comp.channels,
							matrix: comp.matrix,
							diagnostics: pipeline.compensation?.diagnostics,
							context: comp.context,
							estimation: comp.estimation ?? null,
							shaderHash: digest(KERNEL_SOURCES),
							adapter: (await this.gpuPromise)?.description,
						}
					: null,
				unmixing: unmixing
					? {
							algorithm: "spectral-ols-qr-f32-v1",
							detectors: unmixing.detectors,
							fluorochromes: unmixing.fluorochromes,
							matrix: unmixing.matrix,
							residualChannel: unmixing.residualChannel ?? null,
							outputRanges: unmixing.outputRanges,
							residualRange: unmixing.residualRange,
							context: unmixing.context,
							diagnostics: pipeline.spectral?.diagnostics,
						}
					: null,
				gpu:
					pipeline.acquisition || pipeline.compensation || pipeline.spectral
						? { shaderHash: digest(KERNEL_SOURCES), adapter: (await this.gpuPromise)?.description }
						: null,
				outputFormat: "FCS3.1-F32-LE",
				sourceDatatype: sample.metadata.keywords.$DATATYPE,
				decodedPrecision: "float32",
				nodeVersion: process.version,
				platform: process.platform,
				architecture: process.arch,
				maxChunkBytes: this.chunkBytes,
				timing: {
					queueMs,
					setupMs,
					processingMs: elapsedMs - setupMs,
					totalBeforePublicationMs: queueMs + elapsedMs,
				},
			};
			const receiptFile = await open(join(staging, "receipt.json"), "wx", 0o600);
			try {
				await writeAll(receiptFile, Buffer.from(`${canonical(receipt)}\n`));
				await receiptFile.sync();
			} finally {
				await receiptFile.close();
			}
			signal.throwIfAborted();
			job.phase = "committing";
			await rename(staging, destination);
			outcome = "succeeded";
			job.receipt = receipt;
		} catch (error) {
			outcome = signal.aborted ? "cancelled" : "failed";
			job.phase = "cleaning-up";
			job.error = failure(error);
			delete job.result;
			job.receipt = {
				schemaVersion: 1,
				jobId: job.id,
				state: outcome,
				recipe: job.request,
				hostInstanceId: this.instanceId,
				buildId,
				compensation: job.plannedCompensation ?? null,
				unmixing: job.plannedUnmixing ?? null,
				inputContext: job.inputContext,
				acquisition: this.acquisitionEvidence(pipeline?.acquisition),
				error: job.error,
				processedEvents: job.processedEvents,
				elapsedMs: performance.now() - started,
			};
		} finally {
			const cleanup = [
				() => pipeline?.destroy(),
				() => output?.close(),
				() => source?.close(),
				() => rm(staging, { recursive: true, force: true }),
			];
			for (const release of cleanup) {
				try {
					await release();
				} catch (error) {
					job.warnings ??= [];
					job.warnings.push(failure(error));
				}
			}
			job.completedAt = new Date().toISOString();
			const phase = outcome === "succeeded" ? "complete" : outcome;
			try {
				await this.store.saveRun(job.id, {
					...this.jobRecord(job),
					state: outcome,
					phase,
					result: job.result,
					receipt: job.receipt,
				});
			} catch (error) {
				job.warnings ??= [];
				job.warnings.push(failure(error));
			}
			job.state = outcome;
			job.phase = phase;
			for (const [id, old] of this.jobs) {
				if (this.jobs.size <= 128) break;
				if (old.state === "succeeded" || old.state === "failed" || old.state === "cancelled")
					this.jobs.delete(id);
			}
		}
	}

	close(): Promise<void> {
		this.closing ??= this.shutdownService();
		return this.closing;
	}
	private async shutdownService(): Promise<void> {
		this.closed = true;
		this.shutdown.abort();
		for (const job of this.jobs.values()) if (job.phase !== "committing") job.abort.abort();
		await Promise.allSettled([...this.active]);
		await this.running;
		for (const job of this.queue.splice(0)) {
			job.abort.abort();
			await this.executeJob(job);
		}
		if (this.gpuPromise) {
			try {
				(await this.gpuPromise).device.destroy();
			} catch {
				/* Failed adapter initialization has no device. */
			}
		}
		this.gpuPromise = null;
		if (this.gpuOwner !== null) this.gpuOwner = null;
	}
}
