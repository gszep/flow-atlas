/**
 * Buffer helpers and the windowing rule: every storage binding is ≤ maxStorageBufferBindingSize and
 * 256-byte aligned, so large columns are processed in windows via bind-group offsets.
 */

export const WORKGROUP = 256;

export type TypedArray = Float32Array | Uint32Array | Int32Array;

export function createStorage(
	device: GPUDevice,
	byteLength: number,
	usage: GPUBufferUsageFlags = GPUBufferUsage.STORAGE |
		GPUBufferUsage.COPY_SRC |
		GPUBufferUsage.COPY_DST,
	label?: string,
): GPUBuffer {
	const size = Math.max(4, Math.ceil(byteLength / 4) * 4);
	const desc: GPUBufferDescriptor = { size, usage };
	if (label !== undefined) desc.label = label;
	return device.createBuffer(desc);
}

export function upload(device: GPUDevice, data: TypedArray, label?: string): GPUBuffer {
	const buf = createStorage(device, data.byteLength, undefined, label);
	device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
	return buf;
}

export function uniform(device: GPUDevice, data: TypedArray): GPUBuffer {
	const size = Math.max(16, Math.ceil(data.byteLength / 16) * 16);
	const buf = device.createBuffer({
		size,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
	return buf;
}

export async function readback<T extends TypedArray>(
	device: GPUDevice,
	src: GPUBuffer,
	ctor: new (b: ArrayBuffer) => T,
	byteLength = src.size,
	srcOffset = 0,
): Promise<T> {
	const staging = device.createBuffer({
		size: byteLength,
		usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
	});
	try {
		const enc = device.createCommandEncoder();
		enc.copyBufferToBuffer(src, srcOffset, staging, 0, byteLength);
		device.queue.submit([enc.finish()]);
		await staging.mapAsync(GPUMapMode.READ);
		const copy = staging.getMappedRange().slice(0);
		staging.unmap();
		return new ctor(copy);
	} finally {
		staging.destroy();
	}
}

export interface Window {
	/** First element of the window. */
	start: number;
	/** Number of elements. */
	count: number;
}

/**
 * Split `n` elements of `elemBytes` each into windows whose byte size ≤ `maxBytes` and whose byte
 * offset is 256-aligned. Element counts are multiples of `align` elements (except the last).
 */
export function windows(n: number, elemBytes: number, maxBytes: number): Window[] {
	// Element count whose byte size is a multiple of 256 for every 4-byte-multiple element size that
	// may be bound over the same window (e.g. a u32 mask next to a 2-word label): 64 elements always is.
	let align = 64;
	while ((align * elemBytes) % 256 !== 0) align += 64;
	const perWindow = Math.max(align, Math.floor(maxBytes / elemBytes / align) * align);
	const out: Window[] = [];
	for (let s = 0; s < n; s += perWindow) out.push({ start: s, count: Math.min(perWindow, n - s) });
	return out;
}

export const dispatchSize = (count: number): number => Math.ceil(count / WORKGROUP);

/** A binding for a window of a buffer holding `elemBytes` elements. */
export function bind(buffer: GPUBuffer, w: Window, elemBytes: number): GPUBufferBinding {
	return { buffer, offset: w.start * elemBytes, size: w.count * elemBytes };
}

/**
 * Bind elements [start, start+count) even when `start*elemBytes` is not 256-aligned: the binding is
 * aligned down and the remainder is returned as an element `base` for the kernel to add.
 */
export function bindAligned(
	buffer: GPUBuffer,
	start: number,
	count: number,
	elemBytes: number,
): { binding: GPUBufferBinding; base: number } {
	const byteStart = start * elemBytes;
	const aligned = Math.floor(byteStart / 256) * 256;
	const base = (byteStart - aligned) / elemBytes;
	return {
		binding: { buffer, offset: aligned, size: byteStart - aligned + count * elemBytes },
		base,
	};
}
