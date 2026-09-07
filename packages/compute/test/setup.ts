/** Node-side WebGPU via Dawn. Prefers the software adapter when FLOW_ATLAS_GPU=software. */
import { acquireDevice, type DeviceInfo } from "../src/device.js";

let cached: Promise<DeviceInfo> | null = null;
// Keep a reference to the Dawn instance while tests run; dropping it lets the process exit.
let gpuRef: unknown = null;
export const hasGpuRef = (): boolean => gpuRef !== null;

export function getDevice(): Promise<DeviceInfo> {
	if (!cached) {
		cached = (async () => {
			const { create, globals } = await import("webgpu");
			Object.assign(globalThis, globals);
			const args: string[] = [];
			if (process.env.FLOW_ATLAS_GPU === "software") args.push("adapter=llvmpipe");
			const gpu = create(args);
			gpuRef = gpu;
			return acquireDevice(gpu as unknown as GPU);
		})();
	}
	return cached;
}

export function releaseDevice(): void {
	gpuRef = null;
	cached = null;
}
