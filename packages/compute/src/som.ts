/**
 * Batch SOM (GigaSOM.jl semantics) + EmbedSOM on the GPU. The per-epoch codebook update
 * (400×400 kernel matrix times the accumulated sums) is done on the CPU: it is tiny.
 */
import {
	bind,
	createStorage,
	dispatchSize,
	readback,
	uniform,
	upload,
	windows,
} from "./buffers.js";
import type { Kernels } from "./kernels.js";

export interface FeatureMatrix {
	buffer: GPUBuffer; // n × d f32, event-major
	n: number;
	d: number;
}

export interface SomParams {
	xdim?: number;
	ydim?: number;
	epochs?: number;
	rStart?: number;
	rFinal?: number;
	/** expRadius steepness (GigaSOM default -5). */
	steepness?: number;
	seed?: number;
	/** Max events used per epoch (strided subsample). */
	trainMax?: number;
}

export interface Som {
	xdim: number;
	ydim: number;
	d: number;
	/** ncodes × d, row-major. */
	codes: Float32Array;
	/** ncodes × 2 grid coordinates. */
	grid: Float32Array;
}

/** mulberry32 PRNG. */
export function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randn(r: () => number): number {
	let u = 0;
	let v = 0;
	while (u === 0) u = r();
	while (v === 0) v = r();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function gridRectangular(xdim: number, ydim: number): Float32Array {
	const g = new Float32Array(xdim * ydim * 2);
	for (let iy = 0; iy < ydim; iy++) {
		for (let ix = 0; ix < xdim; ix++) {
			const i = ix + iy * xdim;
			g[i * 2] = ix;
			g[i * 2 + 1] = iy;
		}
	}
	return g;
}

export function initSom(
	d: number,
	means: ArrayLike<number>,
	sds: ArrayLike<number>,
	xdim: number,
	ydim: number,
	seed: number,
): Som {
	const n = xdim * ydim;
	const codes = new Float32Array(n * d);
	const r = rng(seed);
	for (let c = 0; c < d; c++) {
		for (let j = 0; j < n; j++)
			codes[j * d + c] = randn(r) * (sds[c] as number) + (means[c] as number);
	}
	return { xdim, ydim, d, codes, grid: gridRectangular(xdim, ydim) };
}

/** GigaSOM expRadius(steepness) schedule. */
export function radiusAt(
	epoch: number,
	epochs: number,
	rStart: number,
	rFinal: number,
	steepness: number,
): number {
	const denom = epochs > 1 ? epochs - 1 : epochs;
	const t = (epoch - 1) / denom;
	const adjust = rFinal * (1 - 1.1 ** -steepness);
	const r0 = rStart - adjust;
	const r1 = rFinal - adjust;
	return adjust + r0 * (r1 / r0) ** t;
}

/** Chebyshev grid distance matrix → gaussian kernel weights at radius r (unnormalised). */
function kernelMatrix(grid: Float32Array, ncodes: number, r: number): Float32Array {
	const w = new Float32Array(ncodes * ncodes);
	const inv = -1 / (2 * r * r);
	for (let i = 0; i < ncodes; i++) {
		const xi = grid[i * 2] as number;
		const yi = grid[i * 2 + 1] as number;
		for (let j = 0; j < ncodes; j++) {
			const dx = Math.abs(xi - (grid[j * 2] as number));
			const dy = Math.abs(yi - (grid[j * 2 + 1] as number));
			const dist = Math.max(dx, dy);
			w[i * ncodes + j] = Math.exp(dist * dist * inv);
		}
	}
	return w;
}

export interface TrainProgress {
	epoch: number;
	epochs: number;
	radius: number;
}

export async function trainSom(
	k: Kernels,
	features: FeatureMatrix,
	som: Som,
	maxBinding: number,
	p: SomParams = {},
	onProgress?: (t: TrainProgress) => void,
): Promise<Som> {
	const { device } = k;
	const { n, d } = features;
	const ncodes = som.xdim * som.ydim;
	const epochs = p.epochs ?? 20;
	const rStart = p.rStart ?? (som.xdim + som.ydim) / 2;
	const rFinal = p.rFinal ?? 0.1;
	const steepness = p.steepness ?? -5;
	const trainMax = p.trainMax ?? 500_000;
	const stride = Math.max(1, Math.ceil(n / trainMax));

	const pipeline = k.get("som_accumulate");
	const codesBuf = upload(device, som.codes, "som.codes");
	const num = createStorage(device, ncodes * d * 4, undefined, "som.num");
	const den = createStorage(device, ncodes * 4, undefined, "som.den");
	const zeroNum = new Uint32Array(ncodes * d);
	const zeroDen = new Uint32Array(ncodes);
	const codes = Float32Array.from(som.codes);

	for (let epoch = 1; epoch <= epochs; epoch++) {
		device.queue.writeBuffer(num, 0, zeroNum);
		device.queue.writeBuffer(den, 0, zeroDen);
		device.queue.writeBuffer(codesBuf, 0, codes);
		const enc = device.createCommandEncoder({ label: "som_accumulate" });
		for (const w of windows(n, d * 4, maxBinding)) {
			const params = uniform(device, new Uint32Array([w.count, d, ncodes, stride]));
			const bg = device.createBindGroup({
				layout: pipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: params } },
					{ binding: 1, resource: bind(features.buffer, w, d * 4) },
					{ binding: 2, resource: { buffer: codesBuf } },
					{ binding: 3, resource: { buffer: num } },
					{ binding: 4, resource: { buffer: den } },
				],
			});
			const pass = enc.beginComputePass();
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, bg);
			pass.dispatchWorkgroups(dispatchSize(Math.ceil(w.count / stride)));
			pass.end();
		}
		device.queue.submit([enc.finish()]);
		const [sumNum, sumDen] = await Promise.all([
			readback(device, num, Float32Array),
			readback(device, den, Uint32Array),
		]);
		const r = radiusAt(epoch, epochs, rStart, rFinal, steepness);
		const W = kernelMatrix(som.grid, ncodes, r);
		// codes = (W·num) ./ (W·den)
		for (let i = 0; i < ncodes; i++) {
			let dsum = 0;
			const acc = new Float64Array(d);
			for (let j = 0; j < ncodes; j++) {
				const w = W[i * ncodes + j] as number;
				const dj = sumDen[j] as number;
				if (dj === 0) continue;
				dsum += w * dj;
				for (let c = 0; c < d; c++) acc[c] = (acc[c] as number) + w * (sumNum[j * d + c] as number);
			}
			if (dsum > 0) for (let c = 0; c < d; c++) codes[i * d + c] = (acc[c] as number) / dsum;
		}
		onProgress?.({ epoch, epochs, radius: r });
	}
	codesBuf.destroy();
	num.destroy();
	den.destroy();
	return { ...som, codes };
}

export function mapToSom(
	k: Kernels,
	features: FeatureMatrix,
	som: Som,
	maxBinding: number,
): GPUBuffer {
	const { device } = k;
	const { n, d } = features;
	const ncodes = som.xdim * som.ydim;
	const pipeline = k.get("som_map");
	const codesBuf = upload(device, som.codes, "som.codes");
	const bmu = createStorage(device, n * 4, undefined, "som.bmu");
	const enc = device.createCommandEncoder({ label: "som_map" });
	for (const w of windows(n, d * 4, maxBinding)) {
		const params = uniform(device, new Uint32Array([w.count, d, ncodes, 0]));
		const bg = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: params } },
				{ binding: 1, resource: bind(features.buffer, w, d * 4) },
				{ binding: 2, resource: { buffer: codesBuf } },
				{ binding: 3, resource: bind(bmu, w, 4) },
			],
		});
		const pass = enc.beginComputePass();
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bg);
		pass.dispatchWorkgroups(dispatchSize(w.count));
		pass.end();
	}
	device.queue.submit([enc.finish()]);
	return bmu;
}

export interface EmbedParams {
	k?: number;
	adjust?: number;
	smooth?: number;
	m?: number;
}

/** EmbedSOM → n × vec2f buffer (grid coordinates). */
export function embedSom(
	k: Kernels,
	features: FeatureMatrix,
	som: Som,
	maxBinding: number,
	p: EmbedParams = {},
): GPUBuffer {
	const { device } = k;
	const { n, d } = features;
	const ncodes = som.xdim * som.ydim;
	let kk = p.k ?? Math.floor(1 + Math.sqrt(ncodes));
	if (kk > ncodes) kk = ncodes;
	if (kk > 31) kk = 31;
	const boost = Math.exp(-(p.smooth ?? 0) - 1);
	const pipeline = k.get("embedsom");
	const codesBuf = upload(device, som.codes, "som.codes");
	const gridBuf = upload(device, som.grid, "som.grid");
	const out = createStorage(device, n * 8, undefined, "embedding");
	const enc = device.createCommandEncoder({ label: "embedsom" });
	for (const w of windows(n, d * 4, maxBinding)) {
		const pb = new ArrayBuffer(32);
		new Uint32Array(pb, 0, 4).set([w.count, d, ncodes, kk]);
		new Float32Array(pb, 16, 4).set([p.adjust ?? 1, boost, p.m ?? 10, 0]);
		const params = uniform(device, new Uint32Array(pb));
		const bg = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: params } },
				{ binding: 1, resource: bind(features.buffer, w, d * 4) },
				{ binding: 2, resource: { buffer: codesBuf } },
				{ binding: 3, resource: { buffer: gridBuf } },
				{ binding: 4, resource: bind(out, w, 8) },
			],
		});
		const pass = enc.beginComputePass();
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bg);
		pass.dispatchWorkgroups(Math.ceil(w.count / 64));
		pass.end();
	}
	device.queue.submit([enc.finish()]);
	return out;
}

export interface GatherColumn {
	buffer: GPUBuffer;
	/** Ranges of events (in the concatenated index space) where this column is present. */
	present: Array<{ start: number; count: number }>;
}

/** Build the event-major feature matrix from column buffers, imputing missing ranges. */
export function gatherFeatures(
	k: Kernels,
	columns: GatherColumn[],
	n: number,
	maxBinding: number,
	seed = 1,
): FeatureMatrix {
	const { device } = k;
	const d = columns.length;
	const pipeline = k.get("gather");
	const buffer = createStorage(device, n * d * 4, undefined, "features");
	const enc = device.createCommandEncoder({ label: "gather" });
	columns.forEach((col, c) => {
		const ranges = new Uint32Array(Math.max(2, col.present.length * 2));
		let total = 0;
		col.present.forEach((r, i) => {
			ranges[i * 2] = r.start;
			ranges[i * 2 + 1] = r.count;
			total += r.count;
		});
		const rangesBuf = upload(device, ranges);
		for (const w of windows(n, d * 4, maxBinding)) {
			const params = uniform(
				device,
				new Uint32Array([w.count, d, c, col.present.length, total, seed, 0, 0]),
			);
			const bg = device.createBindGroup({
				layout: pipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: params } },
					{ binding: 1, resource: bind(col.buffer, w, 4) },
					{ binding: 2, resource: bind(buffer, w, d * 4) },
					{ binding: 3, resource: { buffer: rangesBuf } },
					{ binding: 4, resource: { buffer: col.buffer } },
				],
			});
			const pass = enc.beginComputePass();
			pass.setPipeline(pipeline);
			pass.setBindGroup(0, bg);
			pass.dispatchWorkgroups(dispatchSize(w.count));
			pass.end();
		}
	});
	device.queue.submit([enc.finish()]);
	return { buffer, n, d };
}
