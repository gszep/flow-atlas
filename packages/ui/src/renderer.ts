import { type Camera, moveCamera, previewTransform } from "./map-camera.js";
import previewSrc from "./map-preview.wgsl?raw";
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
	private completed: GPUTexture | null = null;
	private completedCamera: Camera | null = null;
	private readonly previewPipeline: GPURenderPipeline;
	private readonly previewUniform: GPUBuffer;
	private readonly previewSampler: GPUSampler;
	private previewFrame: number | null = null;
	private previewActive: Promise<void> | null = null;
	private previewInFlight = 0;
	private previewDirty = false;
	private settleTimer: ReturnType<typeof setTimeout> | null = null;
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
		const previewModule = device.createShaderModule({ code: previewSrc });
		this.previewPipeline = device.createRenderPipeline({
			layout: "auto",
			vertex: { module: previewModule, entryPoint: "vs" },
			fragment: { module: previewModule, entryPoint: "fs", targets: [{ format: this.format }] },
			primitive: { topology: "triangle-list" },
		});
		this.previewUniform = device.createBuffer({
			size: 16,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.previewSampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
		this.attachInteraction();
		void device.lost.then(() => {
			this.stopped = true;
			this.pending = false;
			this.revision++;
			this.target?.destroy();
			this.target = null;
			this.completed?.destroy();
			this.completed = null;
			this.cancelInteraction();
		});
	}

	setData(pos: GPUBuffer, color: GPUBuffer, count: number, bounds: Bounds): void {
		this.cancelInteraction();
		this.completedCamera = null;
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
			this.completed?.destroy();
			this.completed = null;
			this.completedCamera = null;
		}
		this.target ??= this.device.createTexture({
			size: [w, h],
			format: this.format,
			usage:
				GPUTextureUsage.RENDER_ATTACHMENT |
				GPUTextureUsage.COPY_SRC |
				GPUTextureUsage.TEXTURE_BINDING,
		});
	}

	async pause(): Promise<void> {
		this.cancelInteraction();
		this.dataReady = false;
		this.pending = false;
		this.revision++;
		await this.active;
		await this.previewActive;
	}

	draw(): Promise<void> {
		if (this.stopped) return Promise.resolve();
		this.cancelInteraction();
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
	private cancelInteraction() {
		if (this.previewFrame !== null) cancelAnimationFrame(this.previewFrame);
		this.previewFrame = null;
		this.previewDirty = false;
		if (this.settleTimer !== null) clearTimeout(this.settleTimer);
		this.settleTimer = null;
	}
	private camera(): Camera {
		return { zoom: this.zoom, panX: this.panX, panY: this.panY };
	}
	private gesture() {
		if (!this.dataReady || this.stopped) return;
		// Cancel an obsolete expensive rebuild, not the completed image used for motion.
		this.revision++;
		this.pending = false;
		this.previewDirty = true;
		this.schedulePreview();
		if (this.settleTimer !== null) clearTimeout(this.settleTimer);
		this.settleTimer = setTimeout(() => {
			this.settleTimer = null;
			this.requestDraw();
		}, 150);
	}
	private schedulePreview() {
		if (
			this.previewFrame !== null ||
			this.previewInFlight >= 2 ||
			!this.previewDirty ||
			!this.dataReady ||
			this.stopped
		)
			return;
		this.previewFrame = requestAnimationFrame(() => {
			this.previewFrame = null;
			this.previewDirty = false;
			this.previewInFlight++;
			const active = this.presentPreview()
				.catch(this.onError)
				.finally(() => {
					this.previewInFlight--;
					if (this.previewActive === active) this.previewActive = null;
					this.schedulePreview();
				});
			this.previewActive = active;
		});
	}
	private async presentPreview() {
		if (!this.completed || !this.completedCamera || this.stopped) return;
		this.device.queue.writeBuffer(
			this.previewUniform,
			0,
			previewTransform(this.completedCamera, this.camera()),
		);
		const bindGroup = this.device.createBindGroup({
			layout: this.previewPipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: this.completed.createView() },
				{ binding: 1, resource: this.previewSampler },
				{ binding: 2, resource: { buffer: this.previewUniform } },
			],
		});
		const encoder = this.device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: this.ctx.getCurrentTexture().createView(),
					loadOp: "clear",
					storeOp: "store",
					clearValue: { r: 0.07, g: 0.07, b: 0.07, a: 1 },
				},
			],
		});
		pass.setPipeline(this.previewPipeline);
		pass.setBindGroup(0, bindGroup);
		pass.draw(3);
		pass.end();
		this.device.queue.submit([encoder.finish()]);
		await this.device.queue.onSubmittedWorkDone();
	}
	private async renderLatest() {
		while (this.pending && !this.stopped) {
			this.pending = false;
			await this.renderFrame(this.revision);
		}
	}
	private async renderFrame(revision: number): Promise<void> {
		await this.previewActive;
		if (this.stopped || revision !== this.revision) return;
		this.resize();
		if (!this.bindGroup) return;
		const bindGroup = this.bindGroup,
			count = this.count;
		const camera = this.camera();
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
		// The completed image stays immutable while the next image is rebuilt.
		this.target = this.completed;
		this.completed = target;
		this.completedCamera = camera;
	}

	private attachInteraction(): void {
		const pointers = new Map<number, { x: number; y: number }>();
		const c = this.canvas;
		const centre = () => {
			const points = [...pointers.values()].slice(0, 2),
				a = points[0];
			if (!a) return null;
			const b = points[1] ?? a;
			return {
				x: (a.x + b.x) / 2,
				y: (a.y + b.y) / 2,
				distance: points.length === 2 ? Math.hypot(a.x - b.x, a.y - b.y) : 0,
			};
		};
		c.addEventListener("pointerdown", (e) => {
			if (!this.dataReady || (e.pointerType === "mouse" && e.button !== 0)) return;
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			c.setPointerCapture(e.pointerId);
		});
		c.addEventListener("pointermove", (e) => {
			if (!pointers.has(e.pointerId) || !this.dataReady) return;
			const before = centre();
			pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
			const after = centre();
			if (!before || !after) return;
			const rect = c.getBoundingClientRect();
			const fromX = ((before.x - rect.left) / rect.width) * 2 - 1,
				fromY = 1 - ((before.y - rect.top) / rect.height) * 2;
			const toX = ((after.x - rect.left) / rect.width) * 2 - 1,
				toY = 1 - ((after.y - rect.top) / rect.height) * 2;
			const factor =
				before.distance > 0 && after.distance > 0 ? after.distance / before.distance : 1;
			Object.assign(this, moveCamera(this.camera(), fromX, fromY, toX, toY, factor));
			this.gesture();
		});
		const end = (e: PointerEvent) => {
			pointers.delete(e.pointerId);
		};
		c.addEventListener("pointerup", end);
		c.addEventListener("pointercancel", end);
		c.addEventListener("lostpointercapture", end);
		c.addEventListener(
			"wheel",
			(e) => {
				e.preventDefault();
				if (!this.dataReady) return;
				const f = Math.exp(-Math.max(-2000, Math.min(2000, e.deltaY)) * 0.0015);
				// zoom about cursor
				const nx = (e.offsetX / c.clientWidth) * 2 - 1;
				const ny = 1 - (e.offsetY / c.clientHeight) * 2;
				Object.assign(this, moveCamera(this.camera(), nx, ny, nx, ny, f));
				this.gesture();
			},
			{ passive: false },
		);
		new ResizeObserver(() => this.requestDraw()).observe(c);
	}
}
