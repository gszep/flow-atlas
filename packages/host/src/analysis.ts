import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	acquireDevice,
	type CompensationDiagnostics,
	CompensationNumericalError,
	type CompensationPlan,
	compensateChunk,
	KERNEL_SOURCES,
	Kernels,
	prepareCompensation,
} from "@flow-atlas/compute";
import { type FcsFile, openFcs, writeFcs } from "@flow-atlas/fcs";
import {
	ArtifactStore,
	canonical,
	digest,
	fileSource,
	hashFile,
	writeAll,
} from "./artifact-store.js";
import {
	AnalysisError,
	type AnalysisService,
	operationSchemas,
	validateOperation,
} from "./contracts.js";

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
}
interface ExportRequest {
	sampleId: string;
	compensationId?: string | undefined;
	channels?: string[] | undefined;
	renameChannels?: Record<string, string> | undefined;
	keywords?: Record<string, string> | undefined;
	startEvent?: number | undefined;
	eventCount?: number | undefined;
	outputName?: string | undefined;
}
interface Job {
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
	abort: AbortController;
	error?: { code: string; message: string; details?: unknown };
	result?: { path: string; sha256: string; bytes: number; receiptPath: string };
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
export interface AnalysisOptions {
	root: string;
	/** Maximum decoded chunk bytes. At most 64 MiB, allowing 64-bit input decoding within 128 MiB. */
	maxChunkBytes?: number;
}

function failure(error: unknown): { code: string; message: string; details?: unknown } {
	if (error instanceof Error && error.name === "AbortError")
		return { code: "CANCELLED", message: "Operation cancelled" };
	if (error instanceof CompensationNumericalError)
		return {
			code: "NUMERICAL_REJECTION",
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
			"This operation requires linear unit-gain channel values; acquisition scaling has not been implemented",
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
	private readonly jobs = new Map<string, Job>();
	private readonly queue: Job[] = [];
	private readonly active = new Set<Promise<unknown>>();
	private readonly shutdown = new AbortController();
	private readonly instanceId = randomUUID();
	private running: Promise<void> | null = null;
	private pendingJobs = 0;
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
					version: "flow-atlas-fcs-v1",
					buildId,
					inputFormats: ["FCS2.0", "FCS3.0", "FCS3.1"],
					outputFormat: "FCS3.1-F32-LE",
					decodedPrecision: "float32",
					compute: "WebGPU; no CPU fallback",
					compensation: "square conventional spillover; measured = true × spill",
					limits: {
						chunkBytes: this.chunkBytes,
						maxCompensatedChannels: 128,
						maxActiveRequests: 16,
						maxQueuedJobs: 16,
						maxSamples: 4096,
						maxCachedSamples: 32,
						maxCompensations: 128,
						previewEvents: 100,
						previewChannels: 32,
					},
					unsupported: [
						"spectral OLS/WLS",
						"logarithmic acquisition decoding",
						"non-unit acquisition gain",
						"lossless float64/integer export",
						"multiple datasets",
						"automatic compensation inference",
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
				linear(participating);
				const matrix = Array.from(spill.matrix),
					channels = [...spill.channels];
				const id = digest({
					sampleId: sample.id,
					channels,
					matrix,
					algorithm: "gpu-conventional-v1",
				});
				const existing = this.compensations.get(id);
				if (existing) return this.compensationSummary(existing);
				if (this.compensations.size >= 128)
					throw new AnalysisError("MATRIX_LIMIT", "Session compensation limit reached");
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
				const record = { id, sampleId: sample.id, channels, matrix, diagnostics };
				if (!this.compensations.has(id) && this.compensations.size >= 128)
					throw new AnalysisError("MATRIX_LIMIT", "Session compensation limit reached");
				this.compensations.set(id, record);
				return this.compensationSummary(record);
			}
			case "preview_fcs": {
				const args = operationSchemas.preview_fcs.parse(input);
				const sample = await this.sample(args.sampleId, signal);
				const names = args.channels ?? sample.metadata.channels.slice(0, 16).map((c) => c.name);
				const selected = this.indices(sample, names);
				const offset = args.offset ?? 0;
				if (offset > sample.metadata.eventCount)
					throw new AnalysisError("INVALID_RANGE", "Preview starts past the sample");
				const count = Math.min(args.limit ?? 10, sample.metadata.eventCount - offset);
				const comp = this.compensation(sample, args.compensationId);
				const handle = await fileSource(sample.path);
				let plan: CompensationPlan | undefined;
				try {
					if (handle.identity !== sample.identity)
						throw new AnalysisError(
							"INTEGRITY_ERROR",
							"Input artifact changed since metadata was read; re-import a verified source",
						);
					const reader = await openFcs(handle.source, { signal });
					if (comp) plan = await this.plan(sample, comp, signal);
					const rows: Array<Array<number | null>> = [];
					for await (const chunk of reader.chunks({
						startEvent: offset,
						eventCount: count,
						chunkEvents: Math.min(Math.max(1, count), this.chunkEvents(sample)),
						signal,
					})) {
						const values = plan ? await this.apply(plan, chunk.data, signal) : chunk.data;
						for (let row = 0; row < chunk.count; row++)
							rows.push(
								selected.map((i) => {
									const v = values[row * sample.metadata.channels.length + i] as number;
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
						compensationId: comp?.id ?? null,
						sourceSpace:
							"stored numeric values decoded to float32; no acquisition gain, logarithmic or time conversion",
						nonfiniteEncoding: "JSON null represents a nonfinite raw value",
					};
				} finally {
					plan?.destroy();
					await handle.close();
				}
			}
			case "start_fcs_export": {
				const request = operationSchemas.start_fcs_export.parse(input);
				const sample = await this.sample(request.sampleId, signal);
				const plannedCompensation = this.compensation(sample, request.compensationId);
				this.exportMetadata(sample, request);
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
					abort: new AbortController(),
					...(plannedCompensation
						? { plannedCompensation: structuredClone(plannedCompensation) }
						: {}),
				};
				try {
					await this.store.saveRun(job.id, {
						...this.jobRecord(job),
						plannedCompensation: job.plannedCompensation,
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
				const { receipt: _receipt, plannedCompensation: _planned, ...status } = record;
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
		const handle = await fileSource(path);
		try {
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
		if ((await hashFile(this.store.inputPath(id), signal)) !== id)
			throw new AnalysisError("INTEGRITY_ERROR", "Stored source no longer matches its hash");
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
		};
	}
	private chunkEvents(sample: Sample): number {
		const decoded = sample.metadata.channels.length * 4;
		const encoded = sample.metadata.channels.reduce((sum, channel) => sum + channel.bits / 8, 0);
		const count = Math.floor(
			Math.min(this.chunkBytes / decoded, (128 * 2 ** 20) / (decoded + encoded)),
		);
		if (count < 1)
			throw new AnalysisError("ROW_TOO_LARGE", "One event exceeds the configured chunk budget");
		return count;
	}
	private exportMetadata(sample: Sample, request: ExportRequest): Metadata {
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
		const names = request.channels ?? sample.metadata.channels.map((c) => c.name);
		const selected = this.indices(sample, names);
		if (Object.keys(request.renameChannels ?? {}).some((name) => !names.includes(name)))
			throw new AnalysisError("INVALID_CHANNEL", "Rename keys must refer to selected channels");
		const renamed = (name: string): string =>
			request.renameChannels && Object.hasOwn(request.renameChannels, name)
				? (request.renameChannels[name] as string)
				: name;
		const channels = selected.map((i) => {
			const c = sample.metadata.channels[i] as Metadata["channels"][number];
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
				/^FLOWATLAS_/i.test(key)
			)
				throw new AnalysisError(
					"MANAGED_KEYWORD",
					`Structural keyword is managed by the writer: ${key}`,
				);
		}
		const keywords = {
			...sample.metadata.keywords,
			...Object.fromEntries(
				Object.entries(request.keywords ?? {}).map(([k, v]) => [k.toUpperCase(), v]),
			),
		};
		keywords.$FIL = request.outputName ?? `${sample.id.slice(0, 12)}.analysis.fcs`;
		keywords.FLOWATLAS_SOURCE_SHA256 = sample.id;
		const output: Metadata = { version: "FCS3.1", channels, keywords, eventCount: count };
		const comp = this.compensation(sample, request.compensationId);
		if (comp) {
			keywords.FLOWATLAS_COMPENSATION_ID = comp.id;
			keywords.FLOWATLAS_COMPENSATED = "true";
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
			(gpu) => compensateChunk(gpu.kernels, plan, data, Math.min(this.chunkBytes, gpu.maxBinding)),
			signal,
		);
	}
	private jobRecord(job: Job) {
		return {
			jobId: job.id,
			hostInstanceId: this.instanceId,
			live: true,
			state: job.state,
			phase: job.phase,
			processedEvents: job.processedEvents,
			totalEvents: job.totalEvents,
			createdAt: job.createdAt,
			completedAt: job.completedAt,
			request: job.request,
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
				state: "succeeded",
				phase: "complete",
				result: value.output,
				request: value.recipe,
				processedEvents: value.eventCount,
				totalEvents: value.eventCount,
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
	private async executeJob(job: Job): Promise<void> {
		const signal = job.abort.signal;
		const staging = join(this.store.temporary, job.id);
		let plan: CompensationPlan | undefined;
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
			});
			const sample = await this.sample(job.request.sampleId, signal);
			source = await fileSource(sample.path);
			await source.verify(sample.id, signal);
			const comp = this.compensation(sample, job.request.compensationId);
			const metadata = this.exportMetadata(sample, job.request);
			const names = job.request.channels ?? sample.metadata.channels.map((c) => c.name);
			const indices = this.indices(sample, names),
				par = sample.metadata.channels.length;
			const chunkEvents = this.chunkEvents(sample);
			if (comp) {
				job.phase = "preparing-compensation";
				plan = await this.plan(sample, comp, signal);
			}
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
					job.phase = comp ? "compensating" : "writing";
					const data = plan ? await self.apply(plan, chunk.data, signal) : chunk.data;
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
				recipe: job.request,
				compensation: comp
					? {
							algorithm: "gpu-conventional-v1",
							channels: comp.channels,
							matrix: comp.matrix,
							diagnostics: plan?.diagnostics,
							shaderHash: digest(KERNEL_SOURCES),
							adapter: (await this.gpuPromise)?.description,
						}
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
				error: job.error,
				processedEvents: job.processedEvents,
				elapsedMs: performance.now() - started,
			};
		} finally {
			const cleanup = [
				() => plan?.destroy(),
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
