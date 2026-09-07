/**
 * WebGPU device acquisition. In the browser this is `navigator.gpu`; in Node the caller passes a
 * `GPU` from the `webgpu` package (Dawn). Everything downstream only sees the standard `GPUDevice`.
 */

export interface DeviceInfo {
	device: GPUDevice;
	adapter: GPUAdapter;
	limits: {
		maxBufferSize: number;
		maxStorageBufferBindingSize: number;
		maxStorageBuffersPerShaderStage: number;
	};
	description: string;
}

export class NoWebGpuError extends Error {
	override name = "NoWebGpuError";
}

export async function acquireDevice(gpu?: GPU): Promise<DeviceInfo> {
	const g = gpu ?? (globalThis as { navigator?: { gpu?: GPU } }).navigator?.gpu;
	if (!g) throw new NoWebGpuError("WebGPU is not available in this environment");
	const adapter = await g.requestAdapter({ powerPreference: "high-performance" });
	if (!adapter) throw new NoWebGpuError("no WebGPU adapter found");
	const want = {
		maxBufferSize: adapter.limits.maxBufferSize,
		maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
		maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
		maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
	};
	const device = await adapter.requestDevice({
		requiredLimits: want,
		requiredFeatures: adapter.features.has("timestamp-query") ? ["timestamp-query"] : [],
	});
	const info = adapter.info;
	return {
		device,
		adapter,
		limits: {
			maxBufferSize: device.limits.maxBufferSize,
			maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
			maxStorageBuffersPerShaderStage: device.limits.maxStorageBuffersPerShaderStage,
		},
		description: [info.vendor, info.architecture, info.device, info.description]
			.filter(Boolean)
			.join(" "),
	};
}
