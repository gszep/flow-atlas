import { createStorage, readback } from "./buffers.js";
import type { Kernels } from "./kernels.js";

export interface AcquisitionChannel {
	name: string;
	range: number;
	amplification: readonly [number, number];
	gain: number;
}
export interface AcquisitionOptions {
	timeChannel?: string;
	timeStep?: number;
}
export interface AcquisitionOperation {
	readonly name: string;
	readonly operation:
		| "identity"
		| "divide-gain"
		| "log-linearize-divide-gain"
		| "multiply-timestep";
	readonly range: number;
	readonly decades: number;
	readonly log0: number;
	readonly log0Normalized: boolean;
	readonly gain: number;
	readonly gainIgnored: boolean;
}
export interface AcquisitionMetadata {
	readonly profile: "stored-to-acquisition-linear-f32-v1";
	readonly precision: "f32";
	readonly numericalPolicy: "reject-nonfinite-and-nonzero-subnormal-input-intermediate-output";
	readonly identityPolicy: "bit-preserving";
	/** Conservative exp2 domain; rejects near-overflow exponents rather than relying on saturation. */
	readonly logExponent2Limits: readonly [-126, 127.99998];
	readonly timeChannel: string | null;
	readonly timeResolution: "explicit-exact" | "case-insensitive-exact-Time" | "absent";
	readonly timeStep: number;
	readonly channels: readonly Readonly<AcquisitionOperation>[];
}
export interface AcquisitionPlan {
	readonly channelCount: number;
	readonly timeChannel: string | null;
	readonly metadata: Readonly<AcquisitionMetadata>;
	/** Reject new calls immediately; defer buffer release until in-flight calls finish. */
	destroy(): void;
}
export interface AcquisitionDiagnostics {
	readonly source: "gpu-computation";
	readonly numericalErrors: number;
	readonly windowStartEvent: number;
	readonly windowEventCount: number;
	readonly scope: "failing-channel-values-in-first-rejected-window";
}
export class AcquisitionNumericalError extends Error {
	override name = "AcquisitionNumericalError";
	constructor(readonly diagnostics: Readonly<AcquisitionDiagnostics>) {
		super("Acquisition input or intermediate/result is nonfinite or underflows normal f32");
	}
}
interface State {
	device: GPUDevice;
	parameters: GPUBuffer;
	active: number;
	destroyed: boolean;
}
const states = new WeakMap<AcquisitionPlan, State>();
function dispose(s: State): void {
	if (s.destroyed && s.active === 0) s.parameters.destroy();
}
function limitFor(k: Kernels, maxBinding: number): number {
	if (!Number.isSafeInteger(maxBinding) || maxBinding < 16)
		throw new Error("Acquisition binding limit must be an integer >=16 bytes");
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
function f32(value: number, label: string, zero = false): number {
	const packed = Math.fround(value);
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		!Number.isFinite(packed) ||
		(value === 0 ? !zero : value < 0 || packed < 2 ** -126)
	)
		throw new Error(`${label} must be positive normal finite f32${zero ? " or zero" : ""}`);
	return packed;
}

/** Explicit conversion only: no automatic application, display transform, or compensation.
 * Metadata is snapshotted and packed to f32. 1..4096 unique nonempty exact channel names.
 * maxBinding here bounds persistent metadata; pass the actual device limit, not an event budget.
 */
export async function prepareAcquisition(
	k: Kernels,
	channels: readonly AcquisitionChannel[],
	options: AcquisitionOptions,
	maxBinding: number,
): Promise<AcquisitionPlan> {
	if (channels.length < 1 || channels.length > 4096)
		throw new Error("Acquisition supports 1..4096 channels");
	const names = channels.map((c) => c.name);
	if (names.some((n) => typeof n !== "string" || !n.length) || new Set(names).size !== names.length)
		throw new Error("Acquisition channel names must be nonempty and unique");
	const candidates = names
		.map((n, i) =>
			options.timeChannel !== undefined
				? n === options.timeChannel
					? i
					: -1
				: n.toLowerCase() === "time"
					? i
					: -1,
		)
		.filter((i) => i >= 0);
	if (candidates.length > 1 || (options.timeChannel !== undefined && candidates.length !== 1))
		throw new Error("Acquisition Time channel must resolve uniquely by exact name");
	const timeIndex = candidates[0] ?? -1;
	const timeStep = f32(options.timeStep === undefined ? 1 : options.timeStep, "timeStep");
	if (timeIndex < 0 && options.timeStep !== undefined && options.timeStep !== 1)
		throw new Error("Non-unit timeStep requires a Time channel");
	const limit = limitFor(k, maxBinding);
	// Eight words per channel: mode, decades, log0, range, gain, timestep, padding.
	if (channels.length * 32 > limit) throw new Error("Acquisition metadata exceeds binding limit");
	const packed = new Float32Array(channels.length * 8);
	const words = new Uint32Array(packed.buffer);
	const operations = channels.map((c, i): Readonly<AcquisitionOperation> => {
		if (c.amplification.length !== 2) throw new Error("Amplification requires two values");
		const decades = f32(c.amplification[0], "decades", true);
		const originalLog0 = f32(c.amplification[1], "log0", true);
		const range = f32(c.range, "range");
		const gain = f32(c.gain, "gain");
		if (decades === 0 && originalLog0 !== 0) throw new Error("Linear amplification must be (0,0)");
		if (i === timeIndex && decades !== 0) throw new Error("Time channel must be linear");
		const log0Normalized = decades > 0 && originalLog0 === 0;
		const log0 = log0Normalized ? 1 : originalLog0;
		const mode = i === timeIndex ? (timeStep === 1 ? 0 : 3) : decades > 0 ? 2 : gain === 1 ? 0 : 1;
		packed.set([0, decades, log0, range, gain, timeStep, 0, 0], i * 8);
		words[i * 8] = mode;
		return Object.freeze({
			name: c.name,
			operation:
				mode === 0
					? "identity"
					: mode === 1
						? "divide-gain"
						: mode === 2
							? "log-linearize-divide-gain"
							: "multiply-timestep",
			range,
			decades,
			log0,
			log0Normalized,
			gain,
			gainIgnored: i === timeIndex,
		});
	});
	const timeChannel = names[timeIndex] ?? null;
	const metadata: AcquisitionMetadata = Object.freeze({
		profile: "stored-to-acquisition-linear-f32-v1",
		precision: "f32",
		numericalPolicy: "reject-nonfinite-and-nonzero-subnormal-input-intermediate-output",
		identityPolicy: "bit-preserving",
		logExponent2Limits: Object.freeze([-126, 127.99998] as const),
		timeChannel,
		timeResolution:
			timeIndex < 0
				? "absent"
				: options.timeChannel !== undefined
					? "explicit-exact"
					: "case-insensitive-exact-Time",
		timeStep,
		channels: Object.freeze(operations),
	});
	const parameters = createStorage(k.device, packed.byteLength);
	try {
		k.device.queue.writeBuffer(parameters, 0, packed);
		const state: State = { device: k.device, parameters, active: 0, destroyed: false };
		const plan: AcquisitionPlan = Object.freeze({
			channelCount: channels.length,
			timeChannel,
			metadata,
			destroy() {
				if (!state.destroyed) {
					state.destroyed = true;
					dispose(state);
				}
			},
		});
		states.set(plan, state);
		return plan;
	} catch (error) {
		parameters.destroy();
		throw error;
	}
}

/** Borrowed row-major F32 input, fresh output. maxBinding bounds event windows only;
 * metadata retains its separately validated prepare-time binding limit. No partial output on error.
 */
export async function linearizeChunk(
	k: Kernels,
	plan: AcquisitionPlan,
	data: Float32Array,
	maxBinding: number,
): Promise<Float32Array> {
	const s = states.get(plan);
	if (!s || s.destroyed) throw new Error("Acquisition plan is invalid or destroyed");
	if (s.device !== k.device) throw new Error("Acquisition plan belongs to another GPU device");
	if (!(data instanceof Float32Array) || data.length % plan.channelCount !== 0)
		throw new Error("Acquisition input must contain complete Float32Array event rows");
	const limit = limitFor(k, maxBinding),
		stride = plan.channelCount * 4;
	const rows = Math.min(
		Math.floor(limit / stride),
		Math.floor((k.device.limits.maxComputeWorkgroupsPerDimension * 64) / plan.channelCount),
	);
	if (rows < 1) throw new Error("Acquisition complete event row exceeds binding or dispatch limit");
	const output = new Float32Array(data.length);
	s.active++;
	try {
		for (let start = 0; start < data.length; start += rows * plan.channelCount) {
			const count = Math.min(rows * plan.channelCount, data.length - start);
			const owned: GPUBuffer[] = [];
			const allocate = (size: number) => {
				const b = createStorage(k.device, size);
				owned.push(b);
				return b;
			};
			try {
				const input = allocate(count * 4),
					result = allocate(count * 4),
					errors = allocate(4);
				k.device.queue.writeBuffer(input, 0, data.buffer, data.byteOffset + start * 4, count * 4);
				const params = k.device.createBuffer({
					size: 16,
					usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
				});
				owned.push(params);
				k.device.queue.writeBuffer(params, 0, new Uint32Array([count, plan.channelCount]));
				const pipeline = k.get("acquisition");
				const bg = k.device.createBindGroup({
					layout: pipeline.getBindGroupLayout(0),
					entries: [params, input, result, s.parameters, errors].map((buffer, binding) => ({
						binding,
						resource: { buffer },
					})),
				});
				const encoder = k.device.createCommandEncoder(),
					pass = encoder.beginComputePass();
				pass.setPipeline(pipeline);
				pass.setBindGroup(0, bg);
				pass.dispatchWorkgroups(Math.ceil(count / 64));
				pass.end();
				k.device.queue.submit([encoder.finish()]);
				const numericalErrors = (await readback(k.device, errors, Uint32Array, 4))[0] as number;
				if (numericalErrors)
					throw new AcquisitionNumericalError(
						Object.freeze({
							source: "gpu-computation",
							numericalErrors,
							windowStartEvent: start / plan.channelCount,
							windowEventCount: count / plan.channelCount,
							scope: "failing-channel-values-in-first-rejected-window",
						}),
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
