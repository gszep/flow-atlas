import { biexTable, interpolate } from "@flow-atlas/transforms";
import { afterAll, describe, expect, it } from "vitest";
import { createStorage, readback, upload, windows } from "../src/buffers.js";
import { evaluateGate } from "../src/gate.js";
import { Kernels } from "../src/kernels.js";
import { transformColumn, uploadTable } from "../src/transform.js";
import { getDevice, releaseDevice } from "./setup.js";

afterAll(() => releaseDevice());

describe("windows", () => {
	it("aligns to 256 bytes and respects max", () => {
		const w = windows(1_000_000, 4, 128 * 2 ** 20);
		expect(w.length).toBe(1);
		const w2 = windows(1000, 4, 1024);
		expect(w2.every((x) => (x.start * 4) % 256 === 0)).toBe(true);
		expect(w2.reduce((a, x) => a + x.count, 0)).toBe(1000);
		expect(Math.max(...w2.map((x) => x.count * 4))).toBeLessThanOrEqual(1024);
	});
});

describe("kernels", () => {
	it("device", async () => {
		const d = await getDevice();
		console.log("GPU:", d.description, d.limits);
		expect(d.limits.maxStorageBufferBindingSize).toBeGreaterThanOrEqual(128 * 2 ** 20);
	});

	it("transform matches TS reference (biex)", async () => {
		const { device } = await getDevice();
		const k = new Kernels(device);
		const t = biexTable({ width: -100, pos: 4.418539922 });
		const n = 100_003;
		const input = new Float32Array(n);
		for (let i = 0; i < n; i++) input[i] = -5000 + (i / n) * 300000 * ((i % 7) + 1) * 0.15;
		input[5] = Number.NaN;
		const inBuf = upload(device, input);
		const outBuf = createStorage(device, n * 4);
		transformColumn(k, uploadTable(device, t), inBuf, outBuf, n, 1 << 20); // small windows on purpose
		const out = await readback(device, outBuf, Float32Array);
		let maxErr = 0;
		for (let i = 0; i < n; i++) {
			const ref = interpolate(t, input[i] as number);
			if (Number.isNaN(ref)) {
				expect(out[i]).toBeNaN();
				continue;
			}
			maxErr = Math.max(maxErr, Math.abs((out[i] as number) - ref));
		}
		expect(maxErr).toBeLessThan(2e-3); // f32 table vs f64 reference, output in 0..4096
	});

	it("polygon and rectangle gates with parent and count", async () => {
		const { device, limits } = await getDevice();
		const k = new Kernels(device);
		const n = 10_000;
		const xs = new Float32Array(n);
		const ys = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			xs[i] = (i % 100) / 100;
			ys[i] = Math.floor(i / 100) / 100;
		}
		const x = upload(device, xs);
		const y = upload(device, ys);
		// triangle (0,0)-(1,0)-(0,1): x+y<1
		const tri = await evaluateGate(
			k,
			{
				x,
				y,
				xOffset: 0,
				yOffset: 0,
				count: n,
				parent: null,
				geometry: {
					type: "polygon",
					vertices: [
						[0, 0],
						[1, 0],
						[0, 1],
					],
				},
			},
			limits.maxStorageBufferBindingSize,
		);
		let ref = 0;
		for (let i = 0; i < n; i++) if ((xs[i] as number) + (ys[i] as number) < 1) ref++;
		expect(Math.abs(tri.count - ref)).toBeLessThanOrEqual(100); // boundary ties
		const rect = await evaluateGate(
			k,
			{
				x,
				y,
				xOffset: 0,
				yOffset: 0,
				count: n,
				parent: tri.mask,
				geometry: {
					type: "rectangle",
					min: [0.5, Number.NEGATIVE_INFINITY],
					max: [Number.POSITIVE_INFINITY, 0.2],
				},
			},
			limits.maxStorageBufferBindingSize,
		);
		let ref2 = 0;
		for (let i = 0; i < n; i++) {
			const a = xs[i] as number;
			const b = ys[i] as number;
			if (a + b < 1 && a >= 0.5 && b <= 0.2) ref2++;
		}
		expect(Math.abs(rect.count - ref2)).toBeLessThanOrEqual(30);
		const m = await readback(device, rect.mask, Uint32Array);
		expect(m.reduce((s, v) => s + v, 0)).toBe(rect.count);
	});
});
