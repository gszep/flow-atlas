import pointsSrc from "./points.wgsl?raw";

export interface Bounds {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

export class PointRenderer {
	private readonly ctx: GPUCanvasContext;
	private readonly pipeline: GPURenderPipeline;
	private readonly viewBuf: GPUBuffer;
	private bindGroup: GPUBindGroup | null = null;
	private count = 0;
	private readonly format: GPUTextureFormat;
	zoom = 1;
	panX = 0;
	panY = 0;
	pointPx = 1.5;
	bounds: Bounds = { minX: -1, maxX: 1, minY: -1, maxY: 1 };

	constructor(
		readonly device: GPUDevice,
		readonly canvas: HTMLCanvasElement,
	) {
		this.ctx = canvas.getContext("webgpu") as GPUCanvasContext;
		this.format = navigator.gpu.getPreferredCanvasFormat();
		this.ctx.configure({ device, format: this.format, alphaMode: "premultiplied" });
		const module = device.createShaderModule({ code: pointsSrc });
		this.pipeline = device.createRenderPipeline({
			layout: "auto",
			vertex: { module, entryPoint: "vs" },
			fragment: {
				module,
				entryPoint: "fs",
				targets: [
					{
						format: this.format,
						blend: {
							color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
							alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
						},
					},
				],
			},
			primitive: { topology: "triangle-list" },
		});
		this.viewBuf = device.createBuffer({
			size: 32,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.attachInteraction();
	}

	setData(pos: GPUBuffer, color: GPUBuffer, count: number, bounds: Bounds): void {
		this.count = count;
		this.bounds = bounds;
		this.bindGroup = this.device.createBindGroup({
			layout: this.pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: this.viewBuf } },
				{ binding: 1, resource: { buffer: pos } },
				{ binding: 2, resource: { buffer: color } },
			],
		});
		this.zoom = 1;
		this.panX = 0;
		this.panY = 0;
		this.draw();
	}

	private resize(): void {
		const dpr = window.devicePixelRatio || 1;
		const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
		const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w;
			this.canvas.height = h;
		}
	}

	draw(): void {
		this.resize();
		if (!this.bindGroup) return;
		const { minX, maxX, minY, maxY } = this.bounds;
		const w = this.canvas.width;
		const h = this.canvas.height;
		const range = Math.max(maxX - minX, maxY - minY) || 1;
		// Fit the bounding square into the viewport, preserving aspect.
		const aspect = w / h;
		const sx = (1.8 / range) * this.zoom * (aspect > 1 ? 1 / aspect : 1);
		const sy = (1.8 / range) * this.zoom * (aspect > 1 ? 1 : aspect);
		const cx = (minX + maxX) / 2;
		const cy = (minY + maxY) / 2;
		const dpr = window.devicePixelRatio || 1;
		const view = new Float32Array([
			sx,
			sy,
			-cx * sx + this.panX,
			-cy * sy + this.panY,
			(this.pointPx * dpr * 2) / w,
			(this.pointPx * dpr * 2) / h,
			0,
			0,
		]);
		this.device.queue.writeBuffer(this.viewBuf, 0, view);
		const enc = this.device.createCommandEncoder();
		const pass = enc.beginRenderPass({
			colorAttachments: [
				{
					view: this.ctx.getCurrentTexture().createView(),
					clearValue: { r: 0.07, g: 0.07, b: 0.07, a: 1 },
					loadOp: "clear",
					storeOp: "store",
				},
			],
		});
		pass.setPipeline(this.pipeline);
		pass.setBindGroup(0, this.bindGroup);
		pass.draw(6, this.count);
		pass.end();
		this.device.queue.submit([enc.finish()]);
	}

	private attachInteraction(): void {
		let dragging = false;
		let lx = 0;
		let ly = 0;
		const c = this.canvas;
		c.addEventListener("pointerdown", (e) => {
			dragging = true;
			lx = e.clientX;
			ly = e.clientY;
			c.setPointerCapture(e.pointerId);
		});
		c.addEventListener("pointermove", (e) => {
			if (!dragging) return;
			this.panX += ((e.clientX - lx) / c.clientWidth) * 2;
			this.panY -= ((e.clientY - ly) / c.clientHeight) * 2;
			lx = e.clientX;
			ly = e.clientY;
			this.draw();
		});
		c.addEventListener("pointerup", () => {
			dragging = false;
		});
		c.addEventListener(
			"wheel",
			(e) => {
				e.preventDefault();
				const f = Math.exp(-e.deltaY * 0.0015);
				// zoom about cursor
				const nx = (e.offsetX / c.clientWidth) * 2 - 1;
				const ny = 1 - (e.offsetY / c.clientHeight) * 2;
				this.panX = nx - (nx - this.panX) * f;
				this.panY = ny - (ny - this.panY) * f;
				this.zoom *= f;
				this.draw();
			},
			{ passive: false },
		);
		new ResizeObserver(() => this.draw()).observe(c);
	}
}
