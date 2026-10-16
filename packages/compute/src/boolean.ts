import { bind, createStorage, dispatchSize, readback, uniform, windows } from "./buffers.js";
import type { GateResult } from "./gate.js";
import type { Kernels } from "./kernels.js";

export type BooleanOp = "and" | "or" | "not";

/** NOT is unary. Empty AND is true; empty OR is false, before parent restriction. */
export function validateBoolean(op: string, operands: number): asserts op is BooleanOp {
	if (op !== "and" && op !== "or" && op !== "not") {
		throw new Error(`Unknown Boolean operation: ${op}`);
	}
	if (op === "not" && operands !== 1) throw new Error("Boolean NOT requires exactly one operand");
}

/** Inputs are borrowed sample-local u32 masks at offset zero; caller owns the returned mask. */
export async function evaluateBooleanGate(
	k: Kernels,
	g: { op: BooleanOp; operands: GPUBuffer[]; parent: GPUBuffer | null; count: number },
	maxBinding: number,
): Promise<GateResult> {
	validateBoolean(g.op, g.operands.length);
	if (!Number.isSafeInteger(g.count) || g.count < 0 || g.count > 0xffffffff) {
		throw new Error("Boolean event count must be a nonnegative u32");
	}
	const { device } = k;
	const limit = Math.min(
		maxBinding,
		128 * 2 ** 20,
		device.limits.maxStorageBufferBindingSize,
		device.limits.maxComputeWorkgroupsPerDimension * 256 * 4,
	);
	if (!Number.isFinite(limit) || limit < 256)
		throw new Error("Boolean binding limit must be at least 256 bytes");
	for (const buffer of [...g.operands, ...(g.parent ? [g.parent] : [])]) {
		if (buffer.size < g.count * 4)
			throw new Error("Boolean input mask is shorter than event count");
	}
	const owned: GPUBuffer[] = [];
	const mask = createStorage(device, g.count * 4, undefined, "boolean.mask");
	try {
		if (g.count === 0) return { mask, count: 0 };
		const pipeline = k.get("boolean");
		const counter = createStorage(device, 4, undefined, "boolean.counter");
		owned.push(counter);
		const dummy = createStorage(device, 4, undefined, "boolean.dummy");
		owned.push(dummy);
		const enc = device.createCommandEncoder({ label: "boolean" });
		const folds = Math.max(1, g.operands.length);
		for (let i = 0; i < folds; i++) {
			const operand = g.operands[i];
			for (const w of windows(g.count, 4, limit)) {
				const params = uniform(
					device,
					new Uint32Array([
						w.count,
						g.op === "and" ? 0 : g.op === "or" ? 1 : 2,
						Number(i === 0),
						Number(i === folds - 1),
						Number(!!operand),
						Number(!!g.parent),
						0,
						0,
					]),
				);
				owned.push(params);
				const bg = device.createBindGroup({
					layout: pipeline.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: { buffer: params } },
						{ binding: 1, resource: operand ? bind(operand, w, 4) : { buffer: dummy } },
						{ binding: 2, resource: g.parent ? bind(g.parent, w, 4) : { buffer: dummy } },
						{ binding: 3, resource: bind(mask, w, 4) },
						{ binding: 4, resource: { buffer: counter } },
					],
				});
				const pass = enc.beginComputePass();
				pass.setPipeline(pipeline);
				pass.setBindGroup(0, bg);
				pass.dispatchWorkgroups(dispatchSize(w.count));
				pass.end();
			}
		}
		device.queue.submit([enc.finish()]);
		const result = await readback(device, counter, Uint32Array, 4);
		return { mask, count: result[0] as number };
	} catch (error) {
		mask.destroy();
		throw error;
	} finally {
		for (const buffer of owned) buffer.destroy();
	}
}
