import { createStorage, readback, type Window, windows } from "@flow-atlas/compute";
import distributionSource from "./selection-distribution.wgsl?raw";
import highlightSource from "./selection-highlight.wgsl?raw";
import membershipSource from "./selection-membership.wgsl?raw";
import type { LoadedWorkspace } from "./workspace.js";

export type Point = { x: number; y: number };
/** Exploratory selections in embedding/display space, never persisted raw-channel gates. */
export type SelectionSpec =
	| { kind: "polygon"; points: Point[] }
	| { kind: "reference"; population: number }
	| { kind: "ranges"; ranges: Array<{ channel: number; min: number | null; max: number | null }> };
export interface SelectionAnalysis {
	count: number;
	total: number;
	channels: Array<{
		index: number;
		name: string;
		finiteCount: number;
		missingCount: number;
		min: number | null;
		max: number | null;
		median: number | null;
		bins: number[];
		domain: "display-transformed";
		approximateMedian: true;
	}>;
}
type Workspace = Pick<
	LoadedWorkspace,
	"n" | "channels" | "channelBuffers" | "embedding" | "labels" | "words" | "populations"
>;
type Binding = { buffer: GPUBuffer; size: number; offset?: number };
type Kernel = { pipeline: GPUComputePipeline; layout: GPUBindGroupLayout; dynamic: boolean[] };
const BINS = 128;
const SUMMARY_BYTES = (3 + BINS) * 4;

const finiteF32 = (value: number) => Number.isFinite(value) && Number.isFinite(Math.fround(value));
const abort = (signal?: AbortSignal) => signal?.throwIfAborted();

/** Validate metadata only. Membership is evaluated exclusively on the GPU using stored F32 values. */
export function validateSelectionSpec(spec: SelectionSpec, channels: number, populations: number) {
	if (spec.kind === "polygon") {
		if (
			spec.points.length < 3 ||
			spec.points.length > 128 ||
			spec.points.some(({ x, y }) => !finiteF32(x) || !finiteF32(y))
		)
			throw new Error("Polygon requires 3–128 finite F32 embedding-space points");
	} else if (spec.kind === "reference") {
		if (!Number.isInteger(spec.population) || spec.population < 0 || spec.population >= populations)
			throw new Error("Unknown reference population");
	} else if (spec.kind === "ranges") {
		if (
			spec.ranges.length < 1 ||
			spec.ranges.length > 8 ||
			new Set(spec.ranges.map((range) => range.channel)).size !== spec.ranges.length ||
			spec.ranges.some(
				({ channel, min, max }) =>
					!Number.isInteger(channel) ||
					channel < 0 ||
					channel >= channels ||
					(min !== null && !finiteF32(min)) ||
					(max !== null && !finiteF32(max)) ||
					(min !== null && max !== null && min > max),
			)
		)
			throw new Error("Ranges require 1–8 unique channels with ordered finite inclusive bounds");
	} else throw new Error("Unknown selection kind");
}

function decodeOrdered(value: number) {
	return new Float32Array(
		new Uint32Array([value & 0x80000000 ? value ^ 0x80000000 : ~value]).buffer,
	)[0] as number;
}

/** One invocation at a time; no masks or event copies are retained between selections. */
export class SelectionEngine {
	private readonly membership: Kernel;
	private readonly distribution: Kernel;
	private readonly highlighting: Kernel;
	private readonly chunks: Window[];
	private pending: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly device: GPUDevice,
		private readonly workspace: Workspace,
		maxBinding: number,
	) {
		const { n, words, populations, channels, channelBuffers } = workspace;
		const bound = Math.min(maxBinding, device.limits.maxStorageBufferBindingSize, 128 * 1024 ** 2);
		const stride = Math.max(8, words * 4);
		if (
			!Number.isSafeInteger(n) ||
			n < 0 ||
			n > 0xffffffff ||
			!Number.isSafeInteger(words) ||
			words < 1 ||
			words * 32 < populations.length ||
			channels.length !== channelBuffers.length ||
			!Number.isFinite(bound) ||
			bound < Math.max(1024, stride * 64) ||
			n * 4 > device.limits.maxBufferSize ||
			device.limits.minStorageBufferOffsetAlignment > 256
		)
			throw new Error("Invalid selection workspace dimensions or binding limit");
		this.chunks = windows(n, stride, Math.min(bound, stride * 65536));
		this.membership = this.kernel(
			membershipSource,
			[true, true, true, false, true, false],
			[true, true, true, true, false, false],
		);
		this.distribution = this.kernel(distributionSource, [true, true, false], [true, true, false]);
		this.highlighting = this.kernel(highlightSource, [true, true, false], [true, true, true]);
	}

	private kernel(code: string, readOnly: boolean[], dynamic: boolean[]): Kernel {
		const layout = this.device.createBindGroupLayout({
			entries: [
				{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
				...readOnly.map(
					(read, index): GPUBindGroupLayoutEntry => ({
						binding: index + 1,
						visibility: GPUShaderStage.COMPUTE,
						buffer: {
							type: read ? "read-only-storage" : "storage",
							hasDynamicOffset: dynamic[index] ?? false,
						},
					}),
				),
			],
		});
		return {
			layout,
			dynamic,
			pipeline: this.device.createComputePipeline({
				layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
				compute: { module: this.device.createShaderModule({ code }), entryPoint: "main" },
			}),
		};
	}

	private async dispatch(
		kernel: Kernel,
		uniform: GPUBuffer,
		data: Uint32Array,
		bindings: Binding[],
		count: number,
		signal?: AbortSignal,
	) {
		abort(signal);
		this.device.queue.writeBuffer(uniform, 0, data.buffer, data.byteOffset, data.byteLength);
		const group = this.device.createBindGroup({
			layout: kernel.layout,
			entries: [
				{ binding: 0, resource: { buffer: uniform } },
				...bindings.map((binding, index) => ({
					binding: index + 1,
					resource: {
						buffer: binding.buffer,
						size: binding.size,
						offset: kernel.dynamic[index] ? 0 : (binding.offset ?? 0),
					},
				})),
			],
		});
		const encoder = this.device.createCommandEncoder();
		const pass = encoder.beginComputePass();
		pass.setPipeline(kernel.pipeline);
		pass.setBindGroup(
			0,
			group,
			bindings.flatMap((binding, index) => (kernel.dynamic[index] ? [binding.offset ?? 0] : [])),
		);
		pass.dispatchWorkgroups(Math.ceil(count / 256));
		pass.end();
		this.device.queue.submit([encoder.finish()]);
		await this.device.queue.onSubmittedWorkDone();
		abort(signal);
	}

	private exclusive<T>(run: () => Promise<T>): Promise<T> {
		const result = this.pending.then(run);
		this.pending = result.catch(() => {});
		return result;
	}

	private async withMask<T>(
		spec: SelectionSpec,
		signal: AbortSignal | undefined,
		use: (
			mask: GPUBuffer,
			selected: GPUBuffer,
			uniform: GPUBuffer,
			own: (size: number) => GPUBuffer,
		) => Promise<T>,
	): Promise<T> {
		abort(signal);
		validateSelectionSpec(spec, this.workspace.channels.length, this.workspace.populations.length);
		if (spec.kind === "polygon" && !this.workspace.embedding)
			throw new Error("Embedding is unavailable");
		const owned: GPUBuffer[] = [];
		const own = (size: number) => {
			const buffer = createStorage(this.device, size);
			owned.push(buffer);
			return buffer;
		};
		try {
			const mask = own(this.workspace.n * 4),
				selected = own(4),
				dummy = own(8),
				polygon = own(1024);
			const uniform = this.device.createBuffer({
				size: 48,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			});
			owned.push(uniform);
			if (spec.kind === "polygon")
				this.device.queue.writeBuffer(
					polygon,
					0,
					new Float32Array(spec.points.flatMap(({ x, y }) => [x, y])),
				);
			const ranges = spec.kind === "ranges" ? spec.ranges : [null];
			for (const [index, range] of ranges.entries()) {
				for (const chunk of this.chunks) {
					const data = new Uint32Array(12),
						floats = new Float32Array(data.buffer);
					data.set([
						chunk.count,
						this.workspace.words,
						spec.kind === "reference" ? spec.population : 0,
						spec.kind === "polygon" ? spec.points.length : 0,
						spec.kind === "polygon" ? 0 : spec.kind === "reference" ? 1 : 2,
						index > 0 ? 1 : 0,
						index === ranges.length - 1 ? 1 : 0,
						(range?.min != null ? 1 : 0) | (range?.max != null ? 2 : 0),
					]);
					floats[8] = range?.min ?? 0;
					floats[9] = range?.max ?? 0;
					await this.dispatch(
						this.membership,
						uniform,
						data,
						[
							spec.kind === "polygon"
								? this.window(this.workspace.embedding as GPUBuffer, chunk, 8)
								: { buffer: dummy, size: 8 },
							spec.kind === "reference"
								? this.window(this.workspace.labels, chunk, this.workspace.words * 4)
								: { buffer: dummy, size: 4 },
							range
								? this.window(this.workspace.channelBuffers[range.channel] as GPUBuffer, chunk)
								: { buffer: dummy, size: 4 },
							this.window(mask, chunk),
							{ buffer: polygon, size: 1024 },
							{ buffer: selected, size: 4 },
						],
						chunk.count,
						signal,
					);
				}
			}
			return await use(mask, selected, uniform, own);
		} finally {
			// Includes cancellation and failed readbacks; never destroy buffers still in queued work.
			await this.device.queue.onSubmittedWorkDone().catch(() => {});
			for (const buffer of owned) buffer.destroy();
		}
	}

	private window(buffer: GPUBuffer, chunk: Window, stride = 4): Binding {
		return { buffer, offset: chunk.start * stride, size: chunk.count * stride };
	}

	analyze(spec: SelectionSpec, options: { signal?: AbortSignal } = {}): Promise<SelectionAnalysis> {
		// Copy small selection metadata so a queued operation cannot observe caller mutation.
		const snapshot = structuredClone(spec);
		return this.exclusive(() =>
			this.withMask(snapshot, options.signal, async (mask, selected, uniform, own) => {
				const count = (await readback(this.device, selected, Uint32Array, 4))[0] as number;
				const channels: SelectionAnalysis["channels"] = [];
				const summary = own(SUMMARY_BYTES);
				for (const [index, name] of this.workspace.channels.entries()) {
					abort(options.signal);
					const initial = new Uint32Array(3 + BINS);
					initial[0] = 0xffffffff;
					this.device.queue.writeBuffer(summary, 0, initial);
					if (count > 0)
						for (const histogram of [0, 1])
							for (const chunk of this.chunks) {
								await this.dispatch(
									this.distribution,
									uniform,
									new Uint32Array([chunk.count, histogram, 0, 0]),
									[
										this.window(this.workspace.channelBuffers[index] as GPUBuffer, chunk),
										this.window(mask, chunk),
										{ buffer: summary, size: SUMMARY_BYTES },
									],
									chunk.count,
									options.signal,
								);
							}
					const values = await readback(this.device, summary, Uint32Array, SUMMARY_BYTES);
					const finiteCount = values[2] as number,
						bins = Array.from(values.subarray(3));
					const min = finiteCount ? decodeOrdered(values[0] as number) : null;
					const max = finiteCount ? decodeOrdered(values[1] as number) : null;
					let median: number | null = null;
					if (min !== null && max !== null) {
						const ranks = [Math.floor((finiteCount - 1) / 2), Math.floor(finiteCount / 2)];
						const estimates = ranks.map((rank) => {
							let cumulative = 0;
							for (const [bin, frequency] of bins.entries()) {
								cumulative += frequency;
								if (cumulative > rank) return min + ((max - min) * (bin + 0.5)) / BINS;
							}
							return max;
						});
						median = ((estimates[0] as number) + (estimates[1] as number)) / 2;
					}
					channels.push({
						index,
						name,
						finiteCount,
						missingCount: count - finiteCount,
						min,
						max,
						median,
						bins,
						domain: "display-transformed",
						approximateMedian: true,
					});
				}
				abort(options.signal);
				return { count, total: this.workspace.n, channels };
			}),
		);
	}

	/** Caller owns target; source is never modified. Cancelled targets can be partial: do not publish them. */
	highlight(
		spec: SelectionSpec,
		sourceColors: GPUBuffer,
		targetColors: GPUBuffer,
		signal?: AbortSignal,
		selectedColor = 0x0033aaff,
	): Promise<void> {
		if (!Number.isInteger(selectedColor) || selectedColor < 0 || selectedColor > 0xffffff)
			return Promise.reject(new Error("Invalid highlight color"));
		if (sourceColors === targetColors)
			return Promise.reject(new Error("Highlight requires a distinct target buffer"));
		if (sourceColors.size < this.workspace.n * 4 || targetColors.size < this.workspace.n * 4)
			return Promise.reject(new Error("Color buffer is too small"));
		const snapshot = structuredClone(spec);
		return this.exclusive(() =>
			this.withMask(snapshot, signal, async (mask, _selected, uniform) => {
				for (const chunk of this.chunks)
					await this.dispatch(
						this.highlighting,
						uniform,
						new Uint32Array([chunk.count, selectedColor, 0, 0]),
						[
							this.window(mask, chunk),
							this.window(sourceColors, chunk),
							this.window(targetColors, chunk),
						],
						chunk.count,
						signal,
					);
			}),
		);
	}
}
