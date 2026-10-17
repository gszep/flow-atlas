import { createStorage, readback, uniform } from "./buffers.js";
import type { Kernels } from "./kernels.js";

export interface SpectralMatrix {
	detectors: readonly string[];
	fluorochromes: readonly string[];
	/** Row-major F x D reference: measured[D] = abundances[F] * reference[F,D]. */
	matrix: ArrayLike<number>;
	/** Optional appended Euclidean norm of measured - fitted, in detector units. */
	residualChannel?: string;
}
export interface SpectralDiagnostics {
	readonly source: "gpu-computation";
	readonly algorithm: "column-pivoted-householder-qr-f32";
	readonly status: number;
	/** Setup: 0/1; event errors: failing rows in the first rejected window. */
	readonly numericalErrors: number;
	/** Number of accepted QR pivots; on rejection, not an SVD rank estimate. */
	readonly rank: number;
	readonly detectors: number;
	readonly fluorochromes: number;
	/** ||A||inf * ||A+||inf, A = reference.T. Not a spectral/2-norm condition.
	 * Quality metrics are authoritative on success only; zero denotes unavailable on failure. */
	readonly conditionInfinity: number;
	readonly leftInverseResidualInfinity: number;
	readonly projectorSymmetryResidualInfinity: number;
	readonly matrixScale: number;
	readonly rankRelativeTolerance: 0.000001;
	readonly conditionLimit: 10000;
	readonly residualLimit: 0.001;
}
export class SpectralNumericalError extends Error {
	override name = "SpectralNumericalError";
	constructor(
		message: string,
		readonly diagnostics: Readonly<SpectralDiagnostics>,
	) {
		super(message);
	}
}
export interface SpectralPlan {
	readonly inputChannelCount: number;
	/** Original inputs, then fluorochromes, then optional residual. Never overwrites detectors. */
	readonly outputChannelNames: readonly string[];
	readonly diagnostics: Readonly<SpectralDiagnostics>;
	/** Idempotent; rejects new calls immediately and defers cleanup until in-flight calls finish. */
	destroy(): void;
}
interface State {
	device: GPUDevice;
	inverse: GPUBuffer;
	original: GPUBuffer;
	indices: GPUBuffer;
	residual: boolean;
	destroyed: boolean;
	active: number;
}
const states = new WeakMap<SpectralPlan, State>();
function dispose(s: State): void {
	if (s.destroyed && s.active === 0) {
		s.inverse.destroy();
		s.original.destroy();
		s.indices.destroy();
	}
}
function limitFor(k: Kernels, maxBinding: number): number {
	if (!Number.isSafeInteger(maxBinding) || maxBinding < 32)
		throw new Error("Spectral binding limit must be an integer >=32 bytes");
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

/** Explicit unweighted full-rank OLS only, 1 <= F <= D <= 128. No conventional
 * compensation, WLS/WOLS or native FlowJo parity implied. CPU validates metadata only.
 * maxBinding here is the persistent matrix/device budget, NOT an event-window budget.
 * Largest setup binding is D*D*4 bytes; even tiny event budgets can reuse this plan.
 */
export async function prepareSpectralUnmixing(
	k: Kernels,
	inputChannelNames: readonly string[],
	reference: SpectralMatrix,
	maxBinding: number,
): Promise<SpectralPlan> {
	const inputChannelCount = inputChannelNames.length;
	const residual = reference.residualChannel !== undefined;
	const d = reference.detectors.length,
		f = reference.fluorochromes.length;
	if (f < 1 || d < f || d > 128)
		throw new Error("Spectral OLS requires 1 <= fluorochromes <= detectors <= 128");
	if (reference.matrix.length !== d * f) throw new Error("Spectral matrix shape must be F x D");
	if (
		!namesValid(inputChannelNames) ||
		!namesValid(reference.detectors) ||
		!namesValid(reference.fluorochromes)
	)
		throw new Error("Spectral names must be nonempty and unique (no duplicates)");
	const outputNames = [...inputChannelNames, ...reference.fluorochromes];
	if (reference.residualChannel !== undefined) outputNames.push(reference.residualChannel);
	if (!namesValid(outputNames))
		throw new Error("Spectral output names must be nonempty and unique; collisions forbidden");
	const indices = reference.detectors.map((n) => inputChannelNames.indexOf(n));
	if (indices.includes(-1))
		throw new Error("Spectral detector missing from exact input channel names");
	const matrix = new Float32Array(d * f);
	for (let i = 0; i < matrix.length; i++) {
		const v = reference.matrix[i];
		if (
			typeof v !== "number" ||
			!Number.isFinite(v) ||
			!Number.isFinite(Math.fround(v)) ||
			(v !== 0 && Math.abs(Math.fround(v)) < 2 ** -126)
		)
			throw new Error("Spectral coefficients must be finite normal f32 values or zero");
		matrix[i] = v;
	}
	const limit = limitFor(k, maxBinding);
	if (d * d * 4 > limit)
		throw new Error("Spectral matrix scratch exceeds persistent binding limit");
	const owned: GPUBuffer[] = [];
	const allocate = (size: number): GPUBuffer => {
		const b = createStorage(k.device, size);
		owned.push(b);
		return b;
	};
	let retained: Set<GPUBuffer> | undefined;
	try {
		const params = uniform(k.device, new Uint32Array([d, f]));
		owned.push(params);
		const original = allocate(matrix.byteLength);
		k.device.queue.writeBuffer(original, 0, matrix);
		const work = allocate(matrix.byteLength),
			qt = allocate(d * d * 4);
		const inverse = allocate(matrix.byteLength),
			result = allocate(32);
		run(k, "spectral_qr", [params, original, work, qt, inverse, result], 1);
		const raw = await readback(k.device, result, Uint32Array, 32);
		const floats = new Float32Array(raw.buffer);
		// Keep error diagnostics JSON-safe even when the GPU reports nonfinite arithmetic.
		const finiteDiagnostic = (i: number): number =>
			Number.isFinite(floats[i]) ? (floats[i] as number) : 0;
		const diagnostics: SpectralDiagnostics = Object.freeze({
			source: "gpu-computation",
			algorithm: "column-pivoted-householder-qr-f32",
			status: raw[0] as number,
			numericalErrors: raw[1] as number,
			rank: raw[2] as number,
			detectors: d,
			fluorochromes: f,
			conditionInfinity: finiteDiagnostic(4),
			leftInverseResidualInfinity: finiteDiagnostic(5),
			projectorSymmetryResidualInfinity: finiteDiagnostic(6),
			matrixScale: finiteDiagnostic(7),
			rankRelativeTolerance: 0.000001,
			conditionLimit: 10000,
			residualLimit: 0.001,
		});
		if (
			diagnostics.status !== 0 ||
			diagnostics.rank !== f ||
			!Array.from(floats.subarray(4)).every(Number.isFinite) ||
			diagnostics.conditionInfinity < 0.99999 ||
			diagnostics.conditionInfinity > 10000 ||
			diagnostics.leftInverseResidualInfinity > 0.001 ||
			diagnostics.projectorSymmetryResidualInfinity > 0.001
		)
			throw new SpectralNumericalError(
				"Rank-deficient or numerically unsafe spectral reference",
				diagnostics,
			);
		const mapping = allocate(d * 4);
		k.device.queue.writeBuffer(mapping, 0, new Uint32Array(indices));
		const state: State = {
			device: k.device,
			inverse,
			original,
			indices: mapping,
			residual,
			destroyed: false,
			active: 0,
		};
		const plan: SpectralPlan = Object.freeze({
			inputChannelCount,
			outputChannelNames: Object.freeze(outputNames),
			diagnostics,
			destroy() {
				if (!state.destroyed) {
					state.destroyed = true;
					dispose(state);
				}
			},
		});
		states.set(plan, state);
		retained = new Set([inverse, original, mapping]);
		return plan;
	} finally {
		for (const b of owned) if (!retained?.has(b)) b.destroy();
	}
}

/** Borrowed input must remain unchanged until completion. Fresh output preserves every input
 * word bit-for-bit and appends finite derived values (negative values are not clamped).
 * Nonfinite participating data/overflow reject the entire call, never return partial results.
 * GPU memory is window-bounded; caller owns the whole input/output CPU chunk budget.
 */
export async function unmixChunk(
	k: Kernels,
	plan: SpectralPlan,
	data: Float32Array,
	maxBinding: number,
): Promise<Float32Array> {
	const s = states.get(plan);
	if (!s || s.destroyed) throw new Error("Spectral plan is invalid or destroyed");
	if (s.device !== k.device) throw new Error("Spectral plan belongs to another GPU device");
	const inputs = plan.inputChannelCount,
		outputs = plan.outputChannelNames.length;
	if (!(data instanceof Float32Array) || data.length % inputs !== 0)
		throw new Error("Spectral input must contain complete Float32Array event rows");
	const limit = limitFor(k, maxBinding);
	if (outputs * 4 > limit)
		throw new Error("Spectral complete output event row exceeds binding limit");
	const rowsPerWindow = Math.min(
		Math.floor(limit / (outputs * 4)),
		Math.floor(limit / (inputs * 4)),
		k.device.limits.maxComputeWorkgroupsPerDimension * 64,
	);
	const rows = data.length / inputs;
	const output = new Float32Array(rows * outputs);
	// Use integer views for CPU readback placement as well as WGSL copies: NaN bits stay intact.
	const outputBits = new Uint32Array(output.buffer);
	s.active++;
	try {
		for (let start = 0; start < rows; start += rowsPerWindow) {
			const count = Math.min(rowsPerWindow, rows - start);
			const owned: GPUBuffer[] = [];
			const allocate = (size: number): GPUBuffer => {
				const b = createStorage(k.device, size);
				owned.push(b);
				return b;
			};
			try {
				const input = allocate(count * inputs * 4),
					result = allocate(count * outputs * 4),
					errors = allocate(4);
				k.device.queue.writeBuffer(
					input,
					0,
					data.buffer,
					data.byteOffset + start * inputs * 4,
					count * inputs * 4,
				);
				const params = uniform(
					k.device,
					new Uint32Array([
						count,
						inputs,
						outputs,
						plan.diagnostics.detectors,
						plan.diagnostics.fluorochromes,
						Number(s.residual),
					]),
				);
				owned.push(params);
				run(
					k,
					"spectral",
					[params, input, result, s.inverse, s.original, s.indices, errors],
					Math.ceil(count / 64),
				);
				const errorCount = (await readback(k.device, errors, Uint32Array, 4))[0] as number;
				if (errorCount)
					throw new SpectralNumericalError(
						"Nonfinite spectral input or arithmetic overflow",
						Object.freeze({ ...plan.diagnostics, status: 4, numericalErrors: errorCount }),
					);
				outputBits.set(
					await readback(k.device, result, Uint32Array, count * outputs * 4),
					start * outputs,
				);
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
