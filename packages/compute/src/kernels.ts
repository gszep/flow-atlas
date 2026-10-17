import acquisitionSrc from "./kernels/acquisition.wgsl?raw";
import booleanSrc from "./kernels/boolean.wgsl?raw";
import compensationSrc from "./kernels/compensation.wgsl?raw";
import compensationInverseSrc from "./kernels/compensation_inverse.wgsl?raw";
import embedsomSrc from "./kernels/embedsom.wgsl?raw";
import gateSrc from "./kernels/gate.wgsl?raw";
import gatherSrc from "./kernels/gather.wgsl?raw";
import setbitSrc from "./kernels/setbit.wgsl?raw";
import somAccumulateSrc from "./kernels/som_accumulate.wgsl?raw";
import somMapSrc from "./kernels/som_map.wgsl?raw";
import transformSrc from "./kernels/transform.wgsl?raw";

export const KERNEL_SOURCES = {
	acquisition: acquisitionSrc,
	compensation: compensationSrc,
	compensation_inverse: compensationInverseSrc,
	boolean: booleanSrc,
	transform: transformSrc,
	gate: gateSrc,
	setbit: setbitSrc,
	gather: gatherSrc,
	som_accumulate: somAccumulateSrc,
	som_map: somMapSrc,
	embedsom: embedsomSrc,
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
