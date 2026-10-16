import { createStorage, readback, uniform } from "./buffers.js";
import type { Kernels } from "./kernels.js";

export interface CompensationMatrix {
	channels: readonly string[];
	/** Row-major square spill: recorded row y = true row x * S. */
	matrix: ArrayLike<number>;
}
export interface CompensationDiagnostics {
	readonly source: "gpu-computation";
	readonly status: number;
	readonly numericalErrors: number;
	readonly conditionInfinity: number;
	/** max(||S inv(S)-I||inf, ||inv(S) S-I||inf). */
	readonly residualInfinity: number;
	readonly conditionLimit: 10000;
	readonly residualLimit: 0.001;
}
export class CompensationNumericalError extends Error {
	override name = "CompensationNumericalError";
	constructor(
		message: string,
		readonly diagnostics: Readonly<CompensationDiagnostics>,
	) {
		super(message);
	}
}
export interface CompensationPlan {
	readonly channelCount: number;
	readonly channelIndices: readonly number[];
	readonly diagnostics: Readonly<CompensationDiagnostics>;
	/** Idempotent. Rejects new calls immediately; in-flight calls retain their buffers. */
	destroy(): void;
}
interface State {
	device: GPUDevice;
	inverse: GPUBuffer;
	indices: GPUBuffer;
	destroyed: boolean;
	active: number;
}
const states = new WeakMap<CompensationPlan, State>();
function dispose(s: State): void {
	if (s.destroyed && s.active === 0) {
		s.inverse.destroy();
		s.indices.destroy();
	}
}
function limitFor(k: Kernels, maxBinding: number): number {
	if (!Number.isSafeInteger(maxBinding) || maxBinding < 16)
		throw new Error("Compensation binding limit must be an integer >=16 bytes");
	return (
		Math.floor(
			Math.min(
				maxBinding,
				128 * 2 ** 20,
				k.device.limits.maxStorageBufferBindingSize,
				k.device.limits.maxBufferSize,
			) / 4,
		) * 4
	);
}
function namesValid(names: readonly string[]): boolean {
	return (
		names.length > 0 &&
		Array.from(names).every((n) => typeof n === "string" && n.length > 0) &&
		new Set(names).size === names.length
	);
}
function run(k: Kernels, name: string, buffers: GPUBuffer[], groups: number): void {
	const pipeline = k.get(name);
	const bg = k.device.createBindGroup({
		layout: pipeline.getBindGroupLayout(0),
		entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })),
	});
	const encoder = k.device.createCommandEncoder();
	const pass = encoder.beginComputePass();
	pass.setPipeline(pipeline);
	pass.setBindGroup(0, bg);
	pass.dispatchWorkgroups(groups);
	pass.end();
	k.device.queue.submit([encoder.finish()]);
}

/** Explicit conventional compensation only; no detector heuristics or spectral/OLS interpretation.
 * Up to 128 channels. Rejects nonnormal/nonfinite f32 coefficients, unsafe GPU inverses.
 * Matrix buffers must each fit maxBinding (n*n*4 bytes); event windows contain complete rows.
 */
export async function prepareCompensation(
	k: Kernels,
	channelNames: readonly string[],
	spill: CompensationMatrix,
	maxBinding: number,
): Promise<CompensationPlan> {
	const n = spill.channels.length;
	if (n < 1 || n > 128) throw new Error("Compensation supports 1..128 channels");
	if (spill.matrix.length !== n * n)
		throw new Error(
			"Compensation requires a square matrix; non-square/spectral unmixing unsupported",
		);
	if (!namesValid(channelNames) || !namesValid(spill.channels))
		throw new Error("Compensation channel names must be nonempty and unique (no duplicates)");
	const indices = spill.channels.map((name) => channelNames.indexOf(name));
	if (indices.includes(-1))
		throw new Error("Compensation channel missing from exact sample channel names");
	const matrix = new Float32Array(n * n);
	for (let i = 0; i < matrix.length; i++) {
		const v = spill.matrix[i];
		if (
			typeof v !== "number" ||
			!Number.isFinite(v) ||
			!Number.isFinite(Math.fround(v)) ||
			(v !== 0 && Math.abs(Math.fround(v)) < 2 ** -126)
		)
			throw new Error("Compensation coefficients must be finite normal f32 values or zero");
		matrix[i] = v;
	}
	const limit = limitFor(k, maxBinding);
	if (matrix.byteLength > limit || channelNames.length * 4 > limit)
		throw new Error("Compensation matrix or complete event row exceeds binding limit");
	const owned: GPUBuffer[] = [];
	const allocate = (size: number): GPUBuffer => {
		const b = createStorage(k.device, size);
		owned.push(b);
		return b;
	};
	let retained = false;
	let inverse: GPUBuffer | undefined;
	let mapping: GPUBuffer | undefined;
	try {
		const params = uniform(k.device, new Uint32Array([n]));
		owned.push(params);
		const original = allocate(matrix.byteLength);
		k.device.queue.writeBuffer(original, 0, matrix);
		const work = allocate(matrix.byteLength);
		inverse = allocate(matrix.byteLength);
		const result = allocate(16);
		run(k, "compensation_inverse", [params, original, work, inverse, result], 1);
		const raw = await readback(k.device, result, Uint32Array, 16);
		const floats = new Float32Array(raw.buffer);
		const diagnostics: CompensationDiagnostics = Object.freeze({
			source: "gpu-computation",
			status: raw[0] as number,
			numericalErrors: raw[1] as number,
			conditionInfinity: floats[2] as number,
			residualInfinity: floats[3] as number,
			conditionLimit: 10000,
			residualLimit: 0.001,
		});
		if (
			diagnostics.status !== 0 ||
			!Number.isFinite(diagnostics.conditionInfinity) ||
			!Number.isFinite(diagnostics.residualInfinity) ||
			diagnostics.conditionInfinity < 0.99999 ||
			diagnostics.conditionInfinity > 10000 ||
			diagnostics.residualInfinity > 0.001
		)
			throw new CompensationNumericalError(
				"Singular or numerically unsafe compensation matrix",
				diagnostics,
			);
		mapping = allocate(n * 4);
		k.device.queue.writeBuffer(mapping, 0, new Uint32Array(indices));
		const state: State = {
			device: k.device,
			inverse,
			indices: mapping,
			active: 0,
			destroyed: false,
		};
		const plan: CompensationPlan = Object.freeze({
			channelCount: channelNames.length,
			channelIndices: Object.freeze(indices),
			diagnostics,
			destroy() {
				if (!state.destroyed) {
					state.destroyed = true;
					dispose(state);
				}
			},
		});
		states.set(plan, state);
		retained = true;
		return plan;
	} finally {
		for (const b of owned) if (!retained || (b !== inverse && b !== mapping)) b.destroy();
	}
}

/** Borrowed row-major input; fresh output. Reuses plan across calls, including concurrent calls.
 * Only one complete-row window is uploaded/read back at a time; no whole-chunk GPU allocation.
 * Nonfinite participating inputs or arithmetic overflow reject with GPU error counts.
 */
export async function compensateChunk(
	k: Kernels,
	plan: CompensationPlan,
	data: Float32Array,
	maxBinding: number,
): Promise<Float32Array> {
	const s = states.get(plan);
	if (!s || s.destroyed) throw new Error("Compensation plan is invalid or destroyed");
	if (s.device !== k.device) throw new Error("Compensation plan belongs to another GPU device");
	if (!(data instanceof Float32Array) || data.length % plan.channelCount !== 0)
		throw new Error("Compensation input must contain complete Float32Array event rows");
	const limit = limitFor(k, maxBinding);
	const stride = plan.channelCount * 4;
	if (stride > limit || s.inverse.size > limit || s.indices.size > limit)
		throw new Error("Compensation matrix or complete event row exceeds binding limit");
	const rowsPerWindow = Math.min(
		Math.floor(limit / stride),
		k.device.limits.maxComputeWorkgroupsPerDimension * 64,
	);
	const output = new Float32Array(data.length);
	s.active++;
	try {
		for (let start = 0; start < data.length; start += rowsPerWindow * plan.channelCount) {
			const count = Math.min(rowsPerWindow * plan.channelCount, data.length - start);
			const owned: GPUBuffer[] = [];
			const allocate = (size: number): GPUBuffer => {
				const b = createStorage(k.device, size);
				owned.push(b);
				return b;
			};
			try {
				const input = allocate(count * 4),
					result = allocate(count * 4),
					errors = allocate(4);
				k.device.queue.writeBuffer(input, 0, data.buffer, data.byteOffset + start * 4, count * 4);
				const params = uniform(
					k.device,
					new Uint32Array([
						count / plan.channelCount,
						plan.channelCount,
						plan.channelIndices.length,
					]),
				);
				owned.push(params);
				run(
					k,
					"compensation",
					[params, input, result, s.inverse, s.indices, errors],
					Math.ceil(count / plan.channelCount / 64),
				);
				const errorCount = (await readback(k.device, errors, Uint32Array, 4))[0] as number;
				if (errorCount)
					throw new CompensationNumericalError(
						"Nonfinite compensation input or arithmetic overflow",
						Object.freeze({ ...plan.diagnostics, status: 4, numericalErrors: errorCount }),
					);
				output.set(await readback(k.device, result, Float32Array, count * 4), start);
			} finally {
				for (const b of owned) b.destroy();
			}
		}
		return output;
	} finally {
		s.active--;
		dispose(s);
	}
}
