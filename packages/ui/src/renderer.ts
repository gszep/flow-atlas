import pointsSrc from "./points.wgsl?raw";
import { canvasBudget, renderBatches } from "./render-budget.js";

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
	private target: GPUTexture | null = null;
	private revision = 0;
	private pending = false;
	private active: Promise<void> | null = null;
	private dataReady = false;
	private stopped = false;
	private pixelRatio = 1;
	zoom = 1;
	panX = 0;
	panY = 0;
	pointPx = 1.5;
	bounds: Bounds = { minX: -1, maxX: 1, minY: -1, maxY: 1 };

	constructor(
		readonly device: GPUDevice,
		readonly canvas: HTMLCanvasElement,
		private readonly onError: (error: unknown) => void = console.error,
		private readonly onProgress: (done: number, total: number) => void = () => {},
	) {
		this.ctx = canvas.getContext("webgpu") as GPUCanvasContext;
		this.format = navigator.gpu.getPreferredCanvasFormat();
		this.ctx.configure({
			device,
			format: this.format,
			alphaMode: "premultiplied",
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
		});
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
		void device.lost.then(() => {
			this.stopped = true;
			this.pending = false;
			this.revision++;
			this.target?.destroy();
			this.target = null;
		});
	}

	setData(pos: GPUBuffer, color: GPUBuffer, count: number, bounds: Bounds): void {
		this.revision++;
		this.pending = false;
		this.dataReady = false;
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
		// Colour preparation must finish before the first draw; do not submit millions
		// of invisible/uninitialized instances as an intermediate frame.
	}

	private resize(): void {
		const budget = canvasBudget(
			this.canvas.clientWidth,
			this.canvas.clientHeight,
			window.devicePixelRatio,
			this.device.limits.maxTextureDimension2D,
			matchMedia("(max-width: 760px), (pointer: coarse)").matches,
		);
		const w = budget.width,
			h = budget.height;
		this.pixelRatio = budget.ratio;
		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w;
			this.canvas.height = h;
			this.target?.destroy();
			this.target = null;
		}
		this.target ??= this.device.createTexture({
			size: [w, h],
			format: this.format,
			usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
		});
	}

	async pause(): Promise<void> {
		this.dataReady = false;
		this.pending = false;
		this.revision++;
		await this.active;
	}

	draw(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		this.dataReady = true;
		this.pending = true;
		this.revision++;
		if (!this.active)
			this.active = this.renderLatest().finally(() => {
				this.active = null;
			});
		return this.active;
	}
	private requestDraw() {
		if (this.dataReady) void this.draw().catch(this.onError);
	}
	private async renderLatest() {
		while (this.pending && !this.stopped) {
			this.pending = false;
			await this.renderFrame(this.revision);
		}
	}
	private async renderFrame(revision: number): Promise<void> {
		this.resize();
		if (!this.bindGroup) return;
		const bindGroup = this.bindGroup,
			count = this.count;
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
		const dpr = this.pixelRatio;
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
		const target = this.target as GPUTexture;
		const batches = renderBatches(count);
		if (!batches.length) batches.push({ first: 0, count: 0 });
		for (const batch of batches) {
			if (this.stopped || revision !== this.revision) return;
			const enc = this.device.createCommandEncoder();
			const pass = enc.beginRenderPass({
				colorAttachments: [
					{
						view: target.createView(),
						clearValue: { r: 0.07, g: 0.07, b: 0.07, a: 1 },
						loadOp: batch.first === 0 ? "clear" : "load",
						storeOp: "store",
					},
				],
			});
			pass.setPipeline(this.pipeline);
			pass.setBindGroup(0, bindGroup);
			if (batch.count) pass.draw(6, batch.count, 0, batch.first);
			pass.end();
			this.device.queue.submit([enc.finish()]);
			await this.device.queue.onSubmittedWorkDone();
			this.onProgress(batch.first + batch.count, count);
		}
		if (this.stopped || revision !== this.revision) return;
		// Acquire the canvas texture only when ready to present. It must not be kept
		// across asynchronous batches; the persistent offscreen target holds them.
		const present = this.device.createCommandEncoder();
		present.copyTextureToTexture({ texture: target }, { texture: this.ctx.getCurrentTexture() }, [
			w,
			h,
		]);
		this.device.queue.submit([present.finish()]);
		await this.device.queue.onSubmittedWorkDone();
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
			this.requestDraw();
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
				this.requestDraw();
			},
			{ passive: false },
		);
		new ResizeObserver(() => this.requestDraw()).observe(c);
	}
}
