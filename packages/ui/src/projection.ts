import {
	createStorage,
	embedSom,
	type FeatureMatrix,
	type Kernels,
	readback,
	type Som,
	windows,
} from "@flow-atlas/compute";

export const PROJECTION_BATCH_EVENTS = 65536;
export function projectionChunks(count: number, dimensions: number, maxBinding: number) {
	if (
		!Number.isSafeInteger(count) ||
		count < 1 ||
		!Number.isSafeInteger(dimensions) ||
		dimensions < 1 ||
		maxBinding < dimensions * 4 * 64
	)
		throw new Error("Invalid projection dimensions or binding limit");
	return windows(
		count,
		dimensions * 4,
		Math.min(maxBinding, dimensions * 4 * PROJECTION_BATCH_EVENTS),
	);
}

/** Pointwise GPU projection in drained batches: no events are removed or reordered. */
export async function projectAllEvents(
	kernels: Kernels,
	features: FeatureMatrix,
	som: Som,
	maxBinding: number,
	progress: (message: string) => void,
) {
	const { device } = kernels,
		{ n, d } = features;
	const embedding = createStorage(device, n * 8, undefined, "all.embedding");
	let complete = false;
	try {
		for (const window of projectionChunks(n, d, maxBinding)) {
			const owned = new Set<GPUBuffer>();
			const scopedDevice = new Proxy(device, {
				get(target, property) {
					if (property === "createBuffer")
						return (descriptor: GPUBufferDescriptor) => {
							const buffer = target.createBuffer(descriptor);
							owned.add(buffer);
							return buffer;
						};
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const scopedKernels = new Proxy(kernels, {
				get(target, property) {
					if (property === "device") return scopedDevice;
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			try {
				const input = createStorage(scopedDevice, window.count * d * 4);
				const copyIn = device.createCommandEncoder();
				copyIn.copyBufferToBuffer(
					features.buffer,
					window.start * d * 4,
					input,
					0,
					window.count * d * 4,
				);
				device.queue.submit([copyIn.finish()]);
				const chunk = { buffer: input, n: window.count, d };
				const chunkEmbedding = embedSom(scopedKernels, chunk, som, maxBinding);
				const copyOut = device.createCommandEncoder();
				copyOut.copyBufferToBuffer(
					chunkEmbedding,
					0,
					embedding,
					window.start * 8,
					window.count * 8,
				);
				device.queue.submit([copyOut.finish()]);
				await device.queue.onSubmittedWorkDone();
				if (window.start === 0 && window.count >= 256) {
					const temp = [...(await readback(device, chunkEmbedding, Float32Array, 64))];
					const aggregate = [...(await readback(device, embedding, Float32Array, 64))];
					const tiny = embedSom(scopedKernels, { ...chunk, n: 256 }, som, maxBinding);
					const reference = [...(await readback(device, tiny, Float32Array, 64))];
					const valid =
						temp.every(
							(value, index) =>
								Number.isFinite(value) &&
								Math.abs(value - (reference[index] as number)) < 1e-4 &&
								value === aggregate[index],
						) && new Set(temp).size > 2;
					if (!valid) throw new Error("Projection first-chunk comparison failed");
				}
			} finally {
				await device.queue.onSubmittedWorkDone().catch(() => {});
				for (const buffer of owned) buffer.destroy();
			}
			progress(`Projecting all events… ${Math.round(((window.start + window.count) / n) * 100)}%`);
		}
		complete = true;
		return { embedding };
	} finally {
		if (!complete) {
			embedding.destroy();
		}
	}
}
