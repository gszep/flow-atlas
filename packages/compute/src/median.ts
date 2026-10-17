import { createStorage, readback } from "./buffers.js";
import type { Kernels } from "./kernels.js";

export interface RangeSelection {
	channel: string;
	min: number | null;
	max: number | null;
}
export interface MedianSummary {
	readonly channels: readonly string[];
	readonly count: number;
	readonly lower: readonly number[];
	readonly upper: readonly number[];
	readonly diagnostics: Readonly<{
		algorithm: "gpu-radix256-exact-rank-v1";
		passCount: 4;
		precision: "exact-f32-rank-endpoints";
		scope: "selected-population-not-vendor-parity";
		zeroPolicy: "canonical-positive-zero";
		subnormalPolicy: "preserve-integer-bit-order";
		sourceRows: number;
	}>;
}
export class EmptyMedianSelectionError extends Error {
	override name = "EmptyMedianSelectionError";
	constructor() {
		super("Median selection contains no events");
	}
}
export class MedianNumericalError extends Error {
	override name = "MedianNumericalError";
	constructor() {
		super("Selected median target contains a nonfinite F32 value");
	}
}

/** Four passes numbered 0..3 over the same immutable row-major F32 population.
 * Caller owns source hashing/immutability and borrowed chunks until iteration advances.
 * Chunk boundaries may differ. Row/selected counts and impossible ranks detect some,
 * not all, replay mutations. No full-population allocation or CPU event arithmetic.
 * maxBinding bounds event windows; fixed metadata/state/histograms are separately
 * capped by 128 MiB/device limits (histograms use at most 256 KiB).
 * Exact endpoints include subnormals, canonicalize ±0; no rounded median mean is
 * computed and no equivalence to native MedianExact double arithmetic is claimed.
 */
export async function summarizeMedians(
	k: Kernels,
	channelNames: readonly string[],
	targets: readonly string[],
	chunks: (pass: number) => AsyncIterable<Float32Array>,
	maxBinding: number,
	options: { selection?: readonly RangeSelection[]; signal?: AbortSignal } = {},
): Promise<MedianSummary> {
	const names = [...channelNames],
		outputNames = [...targets];
	const validNames = (a: readonly string[]) =>
		a.every((n) => typeof n === "string" && n.length > 0) && new Set(a).size === a.length;
	if (names.length < 1 || names.length > 4096 || !validNames(names))
		throw new Error("Median input requires 1..4096 unique nonempty channel names");
	if (
		outputNames.length < 1 ||
		outputNames.length > 128 ||
		!validNames(outputNames) ||
		outputNames.some((n) => !names.includes(n))
	)
		throw new Error("Median targets require 1..128 unique exact input channel names");
	const selection = (options.selection ?? []).map((range) => ({ ...range }));
	if (selection.length > 16 || !validNames(selection.map((r) => r.channel)))
		throw new Error("Median selection requires <=16 unique channel ranges");
	const scratch = new Float32Array(1),
		bits = new Uint32Array(scratch.buffer);
	const bound = (v: number | null, lower: boolean): number => {
		if (v === null) return lower ? 0 : 0xffffffff;
		if (typeof v !== "number" || !Number.isFinite(v) || Math.fround(v) !== v)
			throw new Error("Median range bounds must be exact finite F32 values or null");
		scratch[0] = v === 0 ? 0 : v;
		const b = bits[0] as number;
		return (b & 0x80000000 ? ~b : b ^ 0x80000000) >>> 0;
	};
	const metadata = new Uint32Array(outputNames.length + selection.length * 3);
	metadata.set(outputNames.map((n) => names.indexOf(n)));
	selection.forEach((r, i) => {
		const index = names.indexOf(r.channel),
			lo = bound(r.min, true),
			hi = bound(r.max, false);
		if (index < 0 || lo > hi)
			throw new Error("Median range requires an exact input channel and min <= max");
		metadata.set([index, lo, hi], outputNames.length + i * 3);
	});
	const { device } = k,
		{ signal } = options;
	const cap = Math.min(
		128 * 2 ** 20,
		device.limits.maxStorageBufferBindingSize,
		device.limits.maxBufferSize,
	);
	if (!Number.isSafeInteger(maxBinding) || maxBinding < 4)
		throw new Error("Median maxBinding must be an integer >=4 bytes");
	const stride = names.length,
		lanes = outputNames.length * 2;
	const rows = Math.min(
		Math.floor(Math.min(maxBinding, cap) / (stride * 4)),
		device.limits.maxComputeWorkgroupsPerDimension * 64,
	);
	if (rows < 1) throw new Error("Median complete event row exceeds binding/dispatch limit");
	if (Math.max(metadata.byteLength, lanes * 256 * 4, lanes * 8, 32) > cap)
		throw new Error("Median fixed state exceeds device binding limit");
	const check = () => signal?.throwIfAborted();
	check();
	const owned: GPUBuffer[] = [];
	const allocate = (size: number, usage?: GPUBufferUsageFlags) => {
		const b = createStorage(device, size, usage);
		owned.push(b);
		return b;
	};
	let sourceRows = -1,
		selected = -1;
	try {
		const params = allocate(32, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
		const meta = allocate(metadata.byteLength),
			state = allocate(lanes * 8),
			histogram = allocate(lanes * 256 * 4),
			counts = allocate(12);
		device.queue.writeBuffer(meta, 0, metadata);
		const dispatch = (name: string, buffers: GPUBuffer[], workgroups: number) => {
			const pipeline = k.get(name);
			const group = device.createBindGroup({
				layout: pipeline.getBindGroupLayout(0),
				entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
			});
			const encoder = device.createCommandEncoder(),
				pass = encoder.beginComputePass();
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, group);
			pass.dispatchWorkgroups(workgroups);
			pass.end();
			device.queue.submit([encoder.finish()]);
		};
		for (let pass = 0; pass < 4; pass++) {
			check();
			const clear = device.createCommandEncoder();
			clear.clearBuffer(histogram);
			clear.clearBuffer(counts);
			device.queue.submit([clear.finish()]);
			let total = 0;
			for await (const chunk of chunks(pass)) {
				check();
				if (!(chunk instanceof Float32Array) || chunk.length % stride !== 0)
					throw new Error("Median input requires complete Float32Array rows");
				total += chunk.length / stride;
				if (total > 0xffffffff) throw new Error("Median source exceeds u32 event-count ceiling");
				for (let start = 0; start < chunk.length; start += rows * stride) {
					check();
					const length = Math.min(rows * stride, chunk.length - start);
					const input = createStorage(device, length * 4);
					try {
						device.queue.writeBuffer(
							input,
							0,
							chunk.buffer,
							chunk.byteOffset + start * 4,
							length * 4,
						);
						device.queue.writeBuffer(
							params,
							0,
							new Uint32Array([
								length / stride,
								stride,
								outputNames.length,
								selection.length,
								pass,
								0,
								0,
								0,
							]),
						);
						dispatch(
							"median_histogram",
							[params, input, meta, state, histogram, counts],
							Math.ceil(length / stride / 64),
						);
					} finally {
						try {
							await device.queue.onSubmittedWorkDone();
						} finally {
							input.destroy();
						}
					}
				}
			}
			check();
			const result = await readback(device, counts, Uint32Array);
			if (result[1]) throw new MedianNumericalError();
			const count = result[0] as number;
			if (pass === 0) {
				sourceRows = total;
				selected = count;
			} else if (sourceRows !== total || selected !== count)
				throw new Error("Median replay row/selected counts changed");
			if (!count) throw new EmptyMedianSelectionError();
			dispatch("median_select", [params, state, histogram, counts], Math.ceil(lanes / 64));
			if ((await readback(device, counts, Uint32Array))[2])
				throw new Error("Median replay produced an impossible rank");
		}
		const result = await readback(device, state, Uint32Array);
		check();
		const lower: number[] = [],
			upper: number[] = [];
		for (let lane = 0; lane < lanes; lane++) {
			const key = result[2 * lane] as number;
			bits[0] = (key & 0x80000000 ? key ^ 0x80000000 : ~key) >>> 0;
			(lane % 2 ? upper : lower).push(scratch[0] as number);
		}
		return Object.freeze({
			channels: Object.freeze(outputNames),
			count: selected,
			lower: Object.freeze(lower),
			upper: Object.freeze(upper),
			diagnostics: Object.freeze({
				algorithm: "gpu-radix256-exact-rank-v1",
				passCount: 4,
				precision: "exact-f32-rank-endpoints",
				scope: "selected-population-not-vendor-parity",
				zeroPolicy: "canonical-positive-zero",
				subnormalPolicy: "preserve-integer-bit-order",
				sourceRows,
			}),
		});
	} finally {
		try {
			await device.queue.onSubmittedWorkDone();
		} finally {
			for (const b of owned) b.destroy();
		}
	}
}
