import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readback, upload } from "../src/buffers.js";
import { Kernels } from "../src/kernels.js";
import { embedSomReference } from "../src/reference.js";
import {
	embedSom,
	gatherFeatures,
	initSom,
	mapToSom,
	radiusAt,
	rng,
	trainSom,
} from "../src/som.js";
import { getDevice, releaseDevice } from "./setup.js";

afterAll(() => releaseDevice());

describe("radius schedule (GigaSOM expRadius(-5), 20 epochs, 20→0.1)", () => {
	it("starts at rStart and ends at rFinal", () => {
		expect(radiusAt(1, 20, 20, 0.1, -5)).toBeCloseTo(20, 9);
		expect(radiusAt(20, 20, 20, 0.1, -5)).toBeCloseTo(0.1, 9);
		expect(radiusAt(10, 20, 20, 0.1, -5)).toBeLessThan(radiusAt(9, 20, 20, 0.1, -5));
	});
});

describe("SOM + EmbedSOM on synthetic clusters", () => {
	beforeAll(async () => {
		await getDevice();
	}, 30_000);
	it("gather imputes NaN, SOM separates clusters, embedding matches reference", async () => {
		const { device, limits } = await getDevice();
		const k = new Kernels(device);
		const n = 30_000;
		const d = 5;
		const r = rng(7);
		const centers = [
			[0, 0, 0, 0, 0],
			[8, 0, 0, 0, 0],
			[0, 8, 0, 0, 0],
		];
		const label = new Uint8Array(n);
		const cols: Float32Array[] = Array.from({ length: d }, () => new Float32Array(n));
		for (let i = 0; i < n; i++) {
			const c = i % 3;
			label[i] = c;
			for (let q = 0; q < d; q++) {
				(cols[q] as Float32Array)[i] = ((centers[c] as number[])[q] as number) + (r() - 0.5) * 2;
			}
		}
		// Column 4 is "missing" for the last third of events → imputed.
		const missingStart = 20_000;
		for (let i = missingStart; i < n; i++) (cols[4] as Float32Array)[i] = Number.NaN;

		const features = gatherFeatures(
			k,
			cols.map((c, q) => ({
				buffer: upload(device, c),
				present: q === 4 ? [{ start: 0, count: missingStart }] : [{ start: 0, count: n }],
			})),
			n,
			limits.maxStorageBufferBindingSize,
		);
		const feat = await readback(device, features.buffer, Float32Array);
		let nan = 0;
		for (const v of feat) if (Number.isNaN(v)) nan++;
		expect(nan).toBe(0);
		expect(feat[3 * d + 2]).toBeCloseTo((cols[2] as Float32Array)[3] as number, 6);

		const means = new Float64Array(d);
		const sds = new Float64Array(d);
		for (let q = 0; q < d; q++) {
			let s = 0;
			let s2 = 0;
			for (let i = 0; i < n; i++) {
				const v = feat[i * d + q] as number;
				s += v;
				s2 += v * v;
			}
			means[q] = s / n;
			sds[q] = Math.sqrt(s2 / n - means[q] ** 2);
		}
		let som = initSom(d, means, sds, 10, 10, 42);
		som = await trainSom(k, features, som, limits.maxStorageBufferBindingSize, { epochs: 10 });
		for (const v of som.codes) expect(Number.isFinite(v)).toBe(true);

		// Map: each cluster should dominate a disjoint set of codes.
		const bmu = await readback(
			device,
			mapToSom(k, features, som, limits.maxStorageBufferBindingSize),
			Uint32Array,
		);
		const owner = new Map<number, number[]>();
		for (let i = 0; i < n; i++) {
			const b = bmu[i] as number;
			const o = owner.get(b) ?? [0, 0, 0];
			(o[label[i] as number] as number)++;
			owner.set(b, o);
		}
		let purity = 0;
		for (const o of owner.values()) purity += Math.max(...o);
		expect(purity / n).toBeGreaterThan(0.98);

		// Embed: GPU vs reference for a few events; clusters separated in 2-D.
		const emb = await readback(
			device,
			embedSom(k, features, som, limits.maxStorageBufferBindingSize),
			Float32Array,
		);
		const kk = Math.floor(1 + Math.sqrt(100));
		for (const i of [0, 1, 2, 12345, n - 1]) {
			const x = Array.from(feat.subarray(i * d, (i + 1) * d));
			const [rx, ry] = embedSomReference(som, x, kk);
			expect(emb[i * 2]).toBeCloseTo(rx, 2);
			expect(emb[i * 2 + 1]).toBeCloseTo(ry, 2);
		}
		const cx = [0, 0, 0];
		const cy = [0, 0, 0];
		const cn = [0, 0, 0];
		for (let i = 0; i < n; i++) {
			const c = label[i] as number;
			cx[c] = (cx[c] as number) + (emb[i * 2] as number);
			cy[c] = (cy[c] as number) + (emb[i * 2 + 1] as number);
			cn[c] = (cn[c] as number) + 1;
		}
		const centroids = cx.map((v, c) => [
			v / (cn[c] as number),
			(cy[c] as number) / (cn[c] as number),
		]);
		let spread = 0;
		for (let i = 0; i < n; i++) {
			const c = label[i] as number;
			const [mx, my] = centroids[c] as number[];
			spread += Math.hypot(
				(emb[i * 2] as number) - (mx as number),
				(emb[i * 2 + 1] as number) - (my as number),
			);
		}
		spread /= n;
		const sep = Math.min(
			Math.hypot(
				((centroids[0] as number[])[0] as number) - ((centroids[1] as number[])[0] as number),
				((centroids[0] as number[])[1] as number) - ((centroids[1] as number[])[1] as number),
			),
			Math.hypot(
				((centroids[0] as number[])[0] as number) - ((centroids[2] as number[])[0] as number),
				((centroids[0] as number[])[1] as number) - ((centroids[2] as number[])[1] as number),
			),
			Math.hypot(
				((centroids[1] as number[])[0] as number) - ((centroids[2] as number[])[0] as number),
				((centroids[1] as number[])[1] as number) - ((centroids[2] as number[])[1] as number),
			),
		);
		console.log(
			`embedding: mean within-cluster spread ${spread.toFixed(2)}, min centroid separation ${sep.toFixed(2)}`,
		);
		expect(sep).toBeGreaterThan(2 * spread);
	}, 60_000);
});
