import gateSrc from "./kernels/gate.wgsl?raw";
import setbitSrc from "./kernels/setbit.wgsl?raw";
import transformSrc from "./kernels/transform.wgsl?raw";

export const KERNEL_SOURCES = {
	transform: transformSrc,
	gate: gateSrc,
	setbit: setbitSrc,
} as const;

export type KernelName = keyof typeof KERNEL_SOURCES;

/** Lazily compiled compute pipelines, one per device. */
export class Kernels {
	private readonly pipelines = new Map<string, GPUComputePipeline>();
	constructor(
		readonly device: GPUDevice,
		private readonly sources: Record<string, string> = KERNEL_SOURCES,
	) {}

	get(name: string): GPUComputePipeline {
		let p = this.pipelines.get(name);
		if (!p) {
			const code = this.sources[name];
			if (!code) throw new Error(`unknown kernel ${name}`);
			const module = this.device.createShaderModule({ code, label: name });
			p = this.device.createComputePipeline({
				label: name,
				layout: "auto",
				compute: { module, entryPoint: "main" },
			});
			this.pipelines.set(name, p);
		}
		return p;
	}

	register(name: string, code: string): void {
		this.sources[name] = code;
		this.pipelines.delete(name);
	}
}
