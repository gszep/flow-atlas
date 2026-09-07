import {
	bind,
	bindAligned,
	createStorage,
	dispatchSize,
	readback,
	uniform,
	upload,
	windows,
} from "./buffers.js";
import type { Kernels } from "./kernels.js";

export interface GateInput {
	/** Transformed x/y columns for the events of this sample (contiguous ranges of `count`). */
	x: GPUBuffer;
	y: GPUBuffer;
	xOffset: number; // element offset into x
	yOffset: number;
	count: number;
	/** Parent 0/1 mask (element offset 0), or null for root gates. */
	parent: GPUBuffer | null;
	geometry:
		| { type: "polygon"; vertices: [number, number][] }
		| { type: "rectangle"; min: [number, number]; max: [number, number] };
}

export interface GateResult {
	mask: GPUBuffer; // u32 per event, 0/1
	count: number;
}

const FINITE = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/** Evaluate a gate on the GPU; returns the mask buffer and the member count. */
export async function evaluateGate(
	k: Kernels,
	g: GateInput,
	maxBinding: number,
): Promise<GateResult> {
	const { device } = k;
	const pipeline = k.get("gate");
	const mask = createStorage(device, g.count * 4, undefined, "gate.mask");
	const counter = createStorage(device, 4, undefined, "gate.counter");
	device.queue.writeBuffer(counter, 0, new Uint32Array([0]));

	let verts: Float32Array;
	let rect = new Float32Array(4);
	if (g.geometry.type === "polygon") {
		verts = new Float32Array(g.geometry.vertices.flat());
	} else {
		verts = new Float32Array(2); // dummy, unused
		const BIG = 3.4e38;
		rect = new Float32Array([
			FINITE(g.geometry.min[0], -BIG),
			FINITE(g.geometry.max[0], BIG),
			FINITE(g.geometry.min[1], -BIG),
			FINITE(g.geometry.max[1], BIG),
		]);
	}
	const vertBuf = upload(device, verts, "gate.verts");
	const nverts = g.geometry.type === "polygon" ? g.geometry.vertices.length : 0;
	const parentBuf = g.parent ?? createStorage(device, 4, undefined, "gate.noparent");

	const enc = device.createCommandEncoder({ label: "gate" });
	for (const w of windows(g.count, 4, maxBinding)) {
		const xb = bindAligned(g.x, g.xOffset + w.start, w.count, 4);
		const yb = bindAligned(g.y, g.yOffset + w.start, w.count, 4);
		const p = new ArrayBuffer(48);
		const u = new Uint32Array(p, 0, 4);
		const f = new Float32Array(p, 16, 4);
		u.set([w.count, nverts, g.parent ? 1 : 0, 0]);
		f.set(rect);
		new Uint32Array(p, 32, 4).set([xb.base, yb.base, 0, 0]);
		const params = uniform(device, new Uint32Array(p));
		const bg = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: params } },
				{ binding: 1, resource: xb.binding },
				{ binding: 2, resource: yb.binding },
				{
					binding: 3,
					resource: g.parent ? bind(parentBuf, w, 4) : { buffer: parentBuf },
				},
				{ binding: 4, resource: { buffer: vertBuf } },
				{ binding: 5, resource: bind(mask, w, 4) },
				{ binding: 6, resource: { buffer: counter } },
			],
		});
		const pass = enc.beginComputePass();
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bg);
		pass.dispatchWorkgroups(dispatchSize(w.count));
		pass.end();
	}
	device.queue.submit([enc.finish()]);
	const c = await readback(device, counter, Uint32Array, 4);
	vertBuf.destroy();
	counter.destroy();
	if (!g.parent) parentBuf.destroy();
	return { mask, count: c[0] as number };
}

/** OR a 0/1 mask into bit `bit` of the label words for events [offset, offset+count). */
export function setLabelBit(
	k: Kernels,
	mask: GPUBuffer,
	labels: GPUBuffer,
	offset: number,
	count: number,
	words: number,
	bit: number,
	maxBinding: number,
): void {
	const { device } = k;
	const pipeline = k.get("setbit");
	const enc = device.createCommandEncoder({ label: "setbit" });
	for (const w of windows(count, 4 * words, maxBinding)) {
		const lb = bindAligned(labels, offset + w.start, w.count, 4 * words);
		const params = uniform(
			device,
			new Uint32Array([w.count, words, Math.floor(bit / 32), bit % 32, lb.base, 0, 0, 0]),
		);
		const bg = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: params } },
				{ binding: 1, resource: bind(mask, w, 4) },
				{ binding: 2, resource: lb.binding },
			],
		});
		const pass = enc.beginComputePass();
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bg);
		pass.dispatchWorkgroups(dispatchSize(w.count));
		pass.end();
	}
	device.queue.submit([enc.finish()]);
}
