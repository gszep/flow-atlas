import { createStorage, readback, type Window, windows } from "@flow-atlas/compute";
import distributionSource from "./selection-distribution.wgsl?raw";
import highlightSource from "./selection-highlight.wgsl?raw";
import membershipSource from "./selection-membership.wgsl?raw";
import unionSource from "./selection-union.wgsl?raw";
import type { LoadedWorkspace } from "./workspace.js";

export type Point = { x: number; y: number };
/** Exploratory selections in embedding/display space, never persisted raw-channel gates. */
export type LeafSelectionSpec =
	| { kind: "all" }
	| { kind: "polygon"; points: Point[] }
	| { kind: "reference"; population: number }
	| { kind: "ranges"; ranges: Array<{ channel: number; min: number | null; max: number | null }> };
type Conjunction = LeafSelectionSpec | { kind: "intersection"; selections: LeafSelectionSpec[] };
export type SelectionSpec = Conjunction | { kind: "union"; selections: Conjunction[] };
function clauses(spec: SelectionSpec): LeafSelectionSpec[][] {
	return (spec.kind === "union" ? spec.selections : [spec]).map((part) =>
		part.kind === "intersection" ? part.selections : [part],
	);
}
function fromClauses(parts: LeafSelectionSpec[][]): SelectionSpec {
	if (
		!parts.length ||
		parts.length > 8 ||
		parts.some((p) => !p.length || p.length > 8) ||
		parts.flat().reduce((n, p) => n + (p.kind === "ranges" ? p.ranges.length : 1), 0) > 32
	)
		throw new Error("Combined selection exceeds the supported predicate limit");
	const sources: Conjunction[] = parts.map((p) =>
		p.length === 1 ? (p[0] as LeafSelectionSpec) : { kind: "intersection", selections: p },
	);
	return structuredClone(
		sources.length === 1 ? (sources[0] as Conjunction) : { kind: "union", selections: sources },
	);
}
export function unionSelections(...specs: SelectionSpec[]): SelectionSpec {
	return fromClauses(specs.flatMap(clauses));
}
export function intersectSelections(...specs: SelectionSpec[]): SelectionSpec {
	if (!specs.length) throw new Error("Selection requires a source");
	let result: LeafSelectionSpec[][] = [[]];
	for (const spec of specs) {
		result = result.flatMap((a) => clauses(spec).map((b) => [...a, ...b]));
		fromClauses(result);
	}
	return fromClauses(result);
}
export interface SelectionAnalysis {
	count: number;
	total: number;
	plottableCount?: number;
	bounds?: { minX: number; maxX: number; minY: number; maxY: number } | null;
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
	if (spec.kind === "union") {
		if (
			!Array.isArray(spec.selections) ||
			spec.selections.length < 2 ||
			spec.selections.length > 8 ||
			spec.selections.some((part) => (part as SelectionSpec).kind === "union")
		)
			throw new Error("Union requires 2–8 non-union selections");
		for (const part of spec.selections) validateSelectionSpec(part, channels, populations);
		unionSelections(spec);
	} else if (spec.kind === "intersection") {
		if (
			!Array.isArray(spec.selections) ||
			spec.selections.length < 2 ||
			spec.selections.length > 8 ||
			spec.selections.some((part) => !["all", "polygon", "reference", "ranges"].includes(part.kind))
		)
			throw new Error("Intersection requires 2–8 leaf selections");
		for (const part of spec.selections) validateSelectionSpec(part, channels, populations);
		intersectSelections(spec);
	} else if (spec.kind === "all") return;
	else if (spec.kind === "polygon") {
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
	private readonly combining: Kernel;
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
		this.combining = this.kernel(unionSource, [true, false, false], [true, true, false]);
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
		drain = true,
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
		if (drain) await this.device.queue.onSubmittedWorkDone();
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
		if (
			clauses(spec)
				.flat()
				.some((part) => part.kind === "polygon") &&
			!this.workspace.embedding
		)
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
				size: 64,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			});
			owned.push(uniform);
			if (spec.kind === "union") {
				for (const part of spec.selections)
					await this.withMask(part, signal, async (child) => {
						for (const [i, chunk] of this.chunks.entries())
							await this.dispatch(
								this.combining,
								uniform,
								new Uint32Array([chunk.count, 0, 0, 0]),
								[
									this.window(child, chunk),
									this.window(mask, chunk),
									{ buffer: selected, size: 4 },
								],
								chunk.count,
								signal,
								(i + 1) % 8 === 0 || i === this.chunks.length - 1,
							);
					});
				return await use(mask, selected, uniform, own);
			}
			const selections = spec.kind === "intersection" ? spec.selections : [spec];
			const passes = selections.flatMap((selection) =>
				(selection.kind === "ranges" ? selection.ranges : [null]).map((range) => ({
					selection,
					range,
				})),
			);
			for (const [index, { selection: part, range }] of passes.entries()) {
				let bounds = [0, 0, 0, 0];
				if (part.kind === "polygon") {
					const points = new Float32Array(part.points.flatMap(({ x, y }) => [x, y]));
					const xs = points.filter((_, i) => i % 2 === 0),
						ys = points.filter((_, i) => i % 2 === 1);
					bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
					this.device.queue.writeBuffer(polygon, 0, points);
				}
				for (const chunk of this.chunks) {
					const data = new Uint32Array(16),
						floats = new Float32Array(data.buffer);
					data.set([
						chunk.count,
						this.workspace.words,
						part.kind === "reference" ? part.population : 0,
						part.kind === "polygon" ? part.points.length : 0,
						part.kind === "polygon"
							? 0
							: part.kind === "reference"
								? 1
								: part.kind === "ranges"
									? 2
									: 3,
						index > 0 ? 1 : 0,
						index === passes.length - 1 ? 1 : 0,
						(range?.min != null ? 1 : 0) | (range?.max != null ? 2 : 0),
					]);
					floats[8] = range?.min ?? 0;
					floats[9] = range?.max ?? 0;
					floats.set(bounds, 10);
					await this.dispatch(
						this.membership,
						uniform,
						data,
						[
							part.kind === "polygon"
								? this.window(this.workspace.embedding as GPUBuffer, chunk, 8)
								: { buffer: dummy, size: 8 },
							part.kind === "reference"
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
							for (const [chunkIndex, chunk] of this.chunks.entries()) {
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
									(chunkIndex + 1) % 8 === 0 || chunkIndex === this.chunks.length - 1,
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
				let bounds: SelectionAnalysis["bounds"] = null;
				let plottableCount = 0;
				if (count && this.workspace.embedding) {
					const axes: Array<[number, number] | null> = [];
					for (const axis of [0, 1]) {
						this.device.queue.writeBuffer(summary, 0, new Uint32Array([0xffffffff, 0, 0]));
						for (const [i, chunk] of this.chunks.entries())
							await this.dispatch(
								this.distribution,
								uniform,
								new Uint32Array([chunk.count, 0, 2, axis]),
								[
									this.window(this.workspace.embedding, chunk, 8),
									this.window(mask, chunk),
									{ buffer: summary, size: SUMMARY_BYTES },
								],
								chunk.count,
								options.signal,
								(i + 1) % 8 === 0 || i === this.chunks.length - 1,
							);
						const result = await readback(this.device, summary, Uint32Array, 12);
						if (axis === 0) plottableCount = result[2] as number;
						axes.push(
							result[2]
								? [decodeOrdered(result[0] as number), decodeOrdered(result[1] as number)]
								: null,
						);
					}
					if (axes[0] && axes[1])
						bounds = { minX: axes[0][0], maxX: axes[0][1], minY: axes[1][0], maxY: axes[1][1] };
				}
				abort(options.signal);
				return { count, total: this.workspace.n, channels, bounds, plottableCount };
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
	/** Rebuild a display overlay from immutable base colors. Last matching layer wins. */
	compose(
		layers: Array<{ source: SelectionSpec; color: number }>,
		sourceColors: GPUBuffer,
		targetColors: GPUBuffer,
		signal?: AbortSignal,
	): Promise<void> {
		if (
			sourceColors === targetColors ||
			sourceColors.size < this.workspace.n * 4 ||
			targetColors.size < this.workspace.n * 4 ||
			layers.length > 33 ||
			layers.some((l) => !Number.isInteger(l.color) || l.color < 0 || l.color > 0xffffff)
		)
			return Promise.reject(new Error("Invalid display layers"));
		const snapshot = structuredClone(layers);
		return this.exclusive(async () => {
			const uniform = this.device.createBuffer({
				size: 16,
				usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
			});
			const dummy = createStorage(this.device, 4);
			try {
				for (const [i, chunk] of this.chunks.entries())
					await this.dispatch(
						this.highlighting,
						uniform,
						new Uint32Array([chunk.count, 0, 1, 0]),
						[
							{ buffer: dummy, size: 4 },
							this.window(sourceColors, chunk),
							this.window(targetColors, chunk),
						],
						chunk.count,
						signal,
						(i + 1) % 8 === 0 || i === this.chunks.length - 1,
					);
				for (const layer of snapshot)
					await this.withMask(layer.source, signal, async (mask) => {
						for (const [i, chunk] of this.chunks.entries())
							await this.dispatch(
								this.highlighting,
								uniform,
								new Uint32Array([chunk.count, layer.color, 2, 0]),
								[
									this.window(mask, chunk),
									this.window(sourceColors, chunk),
									this.window(targetColors, chunk),
								],
								chunk.count,
								signal,
								(i + 1) % 8 === 0 || i === this.chunks.length - 1,
							);
					});
			} finally {
				await this.device.queue.onSubmittedWorkDone().catch(() => {});
				uniform.destroy();
				dummy.destroy();
			}
		});
	}
}
