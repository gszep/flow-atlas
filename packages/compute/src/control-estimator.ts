import { createStorage, readback } from "./buffers.js";
import type { Kernels } from "./kernels.js";

export interface MedianEndpoints {
	count: number;
	lower: readonly number[];
	upper: readonly number[];
}
export interface ControlMedians {
	primaryDetector: string;
	positive: MedianEndpoints;
	negative: MedianEndpoints;
}
export interface ControlEstimationOptions {
	minEvents?: number;
	minPrimarySeparation?: number;
}
export type ControlEstimationStatus =
	| "accepted"
	| "insufficient-events"
	| "unsafe-primary-difference"
	| "insufficient-primary-separation"
	| "invalid-coefficient";
export interface ControlEstimationDiagnostic {
	readonly primaryDetector: string;
	readonly positiveCount: number;
	readonly negativeCount: number;
	readonly status: ControlEstimationStatus;
	readonly primarySeparation: number | null;
	readonly primarySeparationStatus: "available" | "unavailable";
	/** Null if normalization was not attempted. Counts include the diagonal. */
	readonly invalidCoefficientCount: number | null;
	/** Negative valid coefficients only; null if normalization was not attempted. */
	readonly negativeCoefficientCount: number | null;
}
export interface ControlEstimationDiagnostics {
	readonly source: "gpu-computation";
	readonly profile: "conventional-median-difference-primary-f32-v1";
	readonly precision: "f32";
	readonly numericalPolicy: "normal-or-zero-conservative-intermediates";
	readonly intermediateMagnitudeLimit: number;
	readonly minEvents: number;
	readonly minPrimarySeparation: number;
	readonly controls: readonly Readonly<ControlEstimationDiagnostic>[];
}
export interface EstimatedControlMatrix {
	readonly channels: readonly string[];
	/** Row i is the control for channels[i]; columns use the same order. */
	readonly matrix: Float32Array;
	readonly diagnostics: Readonly<ControlEstimationDiagnostics>;
}
export class ControlEstimationError extends Error {
	override name = "ControlEstimationError";
	readonly code = "CONTROL_ESTIMATION_REJECTED";
	constructor(readonly diagnostics: Readonly<ControlEstimationDiagnostics>) {
		super("GPU control estimation rejected support, primary separation, or unsafe arithmetic");
	}
}

function count(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff)
		throw new Error(`${label} must be an integer in 1..4294967295`);
	return value;
}
function f32(value: number, label: string): number {
	const packed = Math.fround(value);
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		!Number.isFinite(packed) ||
		(value !== 0 && Math.abs(packed) < 2 ** -126)
	)
		throw new Error(`${label} must be finite normal f32 or zero`);
	return packed;
}

/** Explicit conventional profile, not FlowJo/AutoSpill parity or biological QC.
 * Each endpoint is packed to f32; odd counts require repeated endpoints. Counts
 * are independent positive u32 values. All metadata is copied before the first await.
 * GPU computes ((positive.lower-negative.lower)+(positive.upper-negative.upper))/2,
 * then divides by that control's strictly positive primary difference. Defaults:
 * minEvents=1 and minPrimarySeparation=0; separation must be strictly above the threshold.
 * Negative coefficients are preserved. No rank/conditioning test: use prepareCompensation
 * before publishing. Conservative GPU arithmetic rejects subnormal/overflow risk and
 * intermediate difference/sum or coefficient magnitudes above 2^126 (no rescaling fallback).
 * maxBinding bounds every buffer, including the 16*N*N-byte endpoint binding (256 KiB max).
 * Result owns its matrix; channels and the complete JSON diagnostics tree are frozen.
 */
export async function estimateControlMatrix(
	k: Kernels,
	channels: readonly string[],
	controls: readonly ControlMedians[],
	maxBinding: number,
	options: ControlEstimationOptions = {},
): Promise<EstimatedControlMatrix> {
	const names = [...channels],
		n = names.length;
	if (n < 1 || n > 128) throw new Error("Control estimation supports 1..128 detectors");
	if (names.some((s) => typeof s !== "string" || !s.length) || new Set(names).size !== n)
		throw new Error("Detector names must be nonempty and unique");
	if (controls.length !== n) throw new Error("Exactly one control per detector is required");
	const byName = new Map(controls.map((c) => [c.primaryDetector, c]));
	if (byName.size !== n || names.some((name) => !byName.has(name)))
		throw new Error("Control primary detector names must match detectors exactly and uniquely");
	const minEvents = count(options.minEvents === undefined ? 1 : options.minEvents, "minEvents");
	const minPrimarySeparation = f32(
		options.minPrimarySeparation === undefined ? 0 : options.minPrimarySeparation,
		"minPrimarySeparation",
	);
	if (minPrimarySeparation < 0) throw new Error("minPrimarySeparation must be nonnegative");
	if (!Number.isSafeInteger(maxBinding) || maxBinding < 16)
		throw new Error("Control estimation binding limit must be an integer >=16 bytes");
	const limit = Math.min(
		maxBinding,
		128 * 2 ** 20,
		k.device.limits.maxStorageBufferBindingSize,
		k.device.limits.maxBufferSize,
	);
	if (16 * n * n > limit || 24 * n > limit)
		throw new Error("Control estimation metadata exceeds binding limit");
	if (n > k.device.limits.maxComputeWorkgroupsPerDimension)
		throw new Error("Control estimation exceeds dispatch limit");
	const endpoints = new Float32Array(4 * n * n),
		support = new Uint32Array(2 * n);
	for (let i = 0; i < n; i++) {
		const c = byName.get(names[i] as string) as ControlMedians;
		for (const [side, e] of [c.positive, c.negative].entries()) {
			support[2 * i + side] = count(e.count, "Median count");
			if (e.lower.length !== n || e.upper.length !== n)
				throw new Error("Median endpoint shape must match detectors");
			for (let j = 0; j < n; j++) {
				const lo = e.lower[j] as number,
					hi = e.upper[j] as number;
				const lower = f32(lo, "Median lower endpoint"),
					upper = f32(hi, "Median upper endpoint");
				if (lo > hi) throw new Error("Median lower endpoint must be <= upper endpoint");
				if (e.count % 2 && lo !== hi)
					throw new Error("Odd median counts require repeated endpoints");
				endpoints[4 * (i * n + j) + 2 * side] = lower;
				endpoints[4 * (i * n + j) + 2 * side + 1] = upper;
			}
		}
	}
	const owned: GPUBuffer[] = [];
	const allocate = (size: number) => {
		const b = createStorage(k.device, size);
		owned.push(b);
		return b;
	};
	try {
		const input = allocate(endpoints.byteLength),
			counts = allocate(support.byteLength),
			result = allocate(4 * n * n),
			quality = allocate(24 * n),
			params = allocate(16);
		const p = new Uint32Array([n, minEvents, 0, 0]);
		new Float32Array(p.buffer)[2] = minPrimarySeparation;
		k.device.queue.writeBuffer(input, 0, endpoints);
		k.device.queue.writeBuffer(counts, 0, support);
		k.device.queue.writeBuffer(params, 0, p);
		const pipeline = k.get("control_estimator");
		const bg = k.device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [params, input, counts, result, quality].map((buffer, binding) => ({
				binding,
				resource: { buffer },
			})),
		});
		const encoder = k.device.createCommandEncoder(),
			pass = encoder.beginComputePass();
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bg);
		pass.dispatchWorkgroups(n);
		pass.end();
		k.device.queue.submit([encoder.finish()]);
		const q = await readback(k.device, quality, Uint32Array);
		const values = new Float32Array(q.buffer);
		const statuses: readonly ControlEstimationStatus[] = [
			"accepted",
			"insufficient-events",
			"unsafe-primary-difference",
			"insufficient-primary-separation",
			"invalid-coefficient",
		];
		const diagnostics: ControlEstimationDiagnostics = Object.freeze({
			source: "gpu-computation",
			profile: "conventional-median-difference-primary-f32-v1",
			precision: "f32",
			numericalPolicy: "normal-or-zero-conservative-intermediates",
			intermediateMagnitudeLimit: 2 ** 126,
			minEvents,
			minPrimarySeparation,
			controls: Object.freeze(
				names.map((primaryDetector, i): Readonly<ControlEstimationDiagnostic> => {
					const status = statuses[q[6 * i] as number];
					if (!status) throw new Error("Invalid GPU control estimation status");
					const available = q[6 * i + 2] === 1;
					const separation = values[6 * i + 1] as number;
					if (available && !Number.isFinite(separation))
						throw new Error("Invalid GPU control separation diagnostic");
					return Object.freeze({
						primaryDetector,
						positiveCount: support[2 * i] as number,
						negativeCount: support[2 * i + 1] as number,
						status,
						primarySeparation: available ? separation : null,
						primarySeparationStatus: available ? "available" : "unavailable",
						invalidCoefficientCount: q[6 * i + 5] ? (q[6 * i + 3] as number) : null,
						negativeCoefficientCount: q[6 * i + 5] ? (q[6 * i + 4] as number) : null,
					});
				}),
			),
		});
		if (diagnostics.controls.some((c) => c.status !== "accepted"))
			throw new ControlEstimationError(diagnostics);
		const matrix = await readback(k.device, result, Float32Array);
		return Object.freeze({ channels: Object.freeze(names), matrix, diagnostics });
	} finally {
		for (const b of owned) b.destroy();
	}
}
