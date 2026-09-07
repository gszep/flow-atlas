import type { Table } from "@flow-atlas/transforms";
import { bind, dispatchSize, uniform, upload, windows } from "./buffers.js";
import type { Kernels } from "./kernels.js";

export interface GpuTable {
	x: GPUBuffer;
	y: GPUBuffer;
	length: number;
}

export function uploadTable(device: GPUDevice, t: Table): GpuTable {
	return {
		x: upload(device, Float32Array.from(t.x), "table.x"),
		y: upload(device, Float32Array.from(t.y), "table.y"),
		length: t.x.length,
	};
}

/**
 * Apply a lookup-table transform to a column of `count` f32 values, writing to `output`
 * (may alias `input` only if the device allows; use separate buffers).
 */
export function transformColumn(
	k: Kernels,
	table: GpuTable,
	input: GPUBuffer,
	output: GPUBuffer,
	count: number,
	maxBinding: number,
): void {
	const { device } = k;
	const pipeline = k.get("transform");
	const enc = device.createCommandEncoder({ label: "transform" });
	for (const w of windows(count, 4, maxBinding)) {
		const params = uniform(device, new Uint32Array([w.count, table.length]));
		const bg = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: params } },
				{ binding: 1, resource: bind(input, w, 4) },
				{ binding: 2, resource: bind(output, w, 4) },
				{ binding: 3, resource: { buffer: table.x } },
				{ binding: 4, resource: { buffer: table.y } },
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
