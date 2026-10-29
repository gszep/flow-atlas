import { type Camera, moveCamera } from "./map-camera.js";
import pointsSrc from "./points.wgsl?raw";
import { canvasBudget, renderBatches } from "./render-budget.js";

export interface Bounds {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

export class PointRenderer {
	onViewChange: (() => void) | null = null;
	private readonly ctx: GPUCanvasContext;
	private readonly pipeline: GPURenderPipeline;
	private readonly layeredPipeline: GPURenderPipeline;
	private layered = false;
	private depth: GPUTexture | null = null;
	private frame = 0;
	private lastFrame: { sequence: number; events: number; layered: boolean; camera: Camera } | null =
		null;
	private readonly viewBuf: GPUBuffer;
	private readonly format: GPUTextureFormat;
	private bindGroup: GPUBindGroup | null = null;
	private target: GPUTexture | null = null;
	private count = 0;
	private revision = 0;
	private pending = false;
	private live = false;
	private active: Promise<void> | null = null;
	private gestureFrame: number | null = null;
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
		const layout = device.createPipelineLayout({
			bindGroupLayouts: [
				device.createBindGroupLayout({
					entries: [
						{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
						{
							binding: 1,
							visibility: GPUShaderStage.VERTEX,
							buffer: { type: "read-only-storage" },
						},
						{
							binding: 2,
							visibility: GPUShaderStage.VERTEX,
							buffer: { type: "read-only-storage" },
						},
					],
				}),
			],
		});
		const descriptor: GPURenderPipelineDescriptor = {
			layout,
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
			primitive: { topology: "triangle-strip" },
		};
		this.pipeline = device.createRenderPipeline(descriptor);
		this.layeredPipeline = device.createRenderPipeline({
			...descriptor,
			depthStencil: { format: "depth24plus", depthWriteEnabled: true, depthCompare: "less-equal" },
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
			this.cancelGesture();
			this.target?.destroy();
			this.target = null;
			this.depth?.destroy();
			this.depth = null;
		});
	}

	setData(pos: GPUBuffer, color: GPUBuffer, count: number, bounds: Bounds): void {
		this.cancelGesture();
		this.revision++;
		this.pending = false;
		this.dataReady = false;
		this.count = count;
		this.layered = false;
		this.bounds = bounds;
		this.bindGroup = this.device.createBindGroup({
			layout: this.pipeline.getBindGroupLayout(0),
			entries: [this.viewBuf, pos, color].map((buffer, binding) => ({
				binding,
				resource: { buffer },
			})),
		});
		this.zoom = 1;
		this.panX = 0;
		this.panY = 0;
		// The caller must finish colour preparation before requesting the first frame.
	}

	private resize() {
		const budget = canvasBudget(
			this.canvas.clientWidth,
			this.canvas.clientHeight,
			window.devicePixelRatio,
			this.device.limits.maxTextureDimension2D,
			matchMedia("(max-width: 760px), (pointer: coarse)").matches,
		);
		this.pixelRatio = budget.ratio;
		if (this.canvas.width !== budget.width || this.canvas.height !== budget.height) {
			this.canvas.width = budget.width;
			this.canvas.height = budget.height;
			this.target?.destroy();
			this.target = null;
			this.depth?.destroy();
			this.depth = null;
		}
	}
	private cancelGesture() {
		if (this.gestureFrame !== null) cancelAnimationFrame(this.gestureFrame);
		this.gestureFrame = null;
	}
	async pause(): Promise<void> {
		this.cancelGesture();
		this.dataReady = false;
		this.pending = false;
		this.revision++;
		await this.active;
	}
	draw(live = false): Promise<void> {
		return this.enqueue(live);
	}
	private enqueue(live: boolean): Promise<void> {
		if (this.stopped) return Promise.resolve();
		this.dataReady = true;
		this.pending = true;
		this.live = live;
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
	private camera(): Camera {
		return { zoom: this.zoom, panX: this.panX, panY: this.panY };
	}
	async focus(bounds: Bounds): Promise<void> {
		if (!Object.values(bounds).every(Number.isFinite)) throw new Error("Invalid population bounds");
		const base = this.screenTransform(),
			sx = base.sx / this.zoom,
			sy = base.sy / this.zoom;
		const span =
			Math.max(this.bounds.maxX - this.bounds.minX, this.bounds.maxY - this.bounds.minY) || 1;
		this.zoom = Math.max(
			0.02,
			Math.min(
				10000,
				1.65 / (Math.max(bounds.maxX - bounds.minX, span / 1000) * sx),
				1.65 / (Math.max(bounds.maxY - bounds.minY, span / 1000) * sy),
			),
		);
		this.panX =
			((this.bounds.minX + this.bounds.maxX - (bounds.minX + bounds.maxX)) / 2) * sx * this.zoom;
		this.panY =
			((this.bounds.minY + this.bounds.maxY - (bounds.minY + bounds.maxY)) / 2) * sy * this.zoom;
		await this.draw(true);
	}
	/** Embedding coordinates, distinct from raw-channel gate space. */
	dataToScreen(point: { x: number; y: number }): { x: number; y: number } {
		const { sx, sy, ox, oy } = this.screenTransform();
		return {
			x: ((point.x * sx + ox + 1) * this.canvas.clientWidth) / 2,
			y: ((1 - point.y * sy - oy) * this.canvas.clientHeight) / 2,
		};
	}
	screenToData(clientX: number, clientY: number): { x: number; y: number } {
		const rect = this.canvas.getBoundingClientRect(),
			{ sx, sy, ox, oy } = this.screenTransform();
		return {
			x: (((clientX - rect.left) / rect.width) * 2 - 1 - ox) / sx,
			y: (1 - ((clientY - rect.top) / rect.height) * 2 - oy) / sy,
		};
	}
	private screenTransform() {
		const { minX, maxX, minY, maxY } = this.bounds;
		const range = Math.max(maxX - minX, maxY - minY) || 1;
		const aspect = this.canvas.width / this.canvas.height;
		const sx = (1.8 / range) * this.zoom * (aspect > 1 ? 1 / aspect : 1);
		const sy = (1.8 / range) * this.zoom * (aspect > 1 ? 1 : aspect);
		return {
			sx,
			sy,
			ox: (-(minX + maxX) / 2) * sx + this.panX,
			oy: (-(minY + maxY) / 2) * sy + this.panY,
		};
	}
	/** Change a display buffer without resetting the user's camera. */
	setColors(pos: GPUBuffer, color: GPUBuffer, layered = false): void {
		this.layered = layered;
		this.bindGroup = this.device.createBindGroup({
			layout: this.pipeline.getBindGroupLayout(0),
			entries: [this.viewBuf, pos, color].map((buffer, binding) => ({
				binding,
				resource: { buffer },
			})),
		});
	}
	viewState() {
		const rect = this.canvas.getBoundingClientRect();
		return {
			ready: !this.stopped && this.dataReady && !!this.bindGroup,
			frame: this.lastFrame,
			camera: this.camera(),
			viewport: { width: this.canvas.clientWidth, height: this.canvas.clientHeight },
			visibleBounds: {
				topLeft: this.screenToData(rect.left, rect.top),
				bottomRight: this.screenToData(rect.right, rect.bottom),
			},
		};
	}
	private gesture() {
		if (!this.dataReady || this.stopped || this.gestureFrame !== null) return;
		this.gestureFrame = requestAnimationFrame(() => {
			this.gestureFrame = null;
			if (this.dataReady && !this.stopped) void this.enqueue(true).catch(this.onError);
		});
	}
	private async renderLatest() {
		// Only one point frame can be in flight. While it runs, retain only the newest
		// requested camera instead of queueing a backlog of stale pointer positions.
		while (this.pending && !this.stopped) {
			this.pending = false;
			await this.renderFrame(this.revision, this.live);
		}
	}
	private async renderFrame(revision: number, live: boolean) {
		if (this.stopped || revision !== this.revision || !this.bindGroup) return;
		this.resize();
		this.onViewChange?.();
		const { minX, maxX, minY, maxY } = this.bounds;
		const w = this.canvas.width,
			h = this.canvas.height;
		const range = Math.max(maxX - minX, maxY - minY) || 1,
			aspect = w / h;
		const sx = (1.8 / range) * this.zoom * (aspect > 1 ? 1 / aspect : 1);
		const sy = (1.8 / range) * this.zoom * (aspect > 1 ? 1 : aspect);
		this.device.queue.writeBuffer(
			this.viewBuf,
			0,
			new Float32Array([
				sx,
				sy,
				(-(minX + maxX) / 2) * sx + this.panX,
				(-(minY + maxY) / 2) * sy + this.panY,
				(this.pointPx * this.pixelRatio * 2) / w,
				(this.pointPx * this.pixelRatio * 2) / h,
				0,
				0,
			]),
		);
		const bindGroup = this.bindGroup,
			count = this.count;
		const camera = this.camera(),
			layered = this.layered;
		if (layered)
			this.depth ??= this.device.createTexture({
				size: [w, h],
				format: "depth24plus",
				usage: GPUTextureUsage.RENDER_ATTACHMENT,
			});
		if (!live)
			this.target ??= this.device.createTexture({
				size: [w, h],
				format: this.format,
				usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
			});
		const target = live ? this.ctx.getCurrentTexture() : (this.target as GPUTexture);
		const batches = live ? [{ first: 0, count }] : renderBatches(count);
		if (!batches.length) batches.push({ first: 0, count: 0 });
		for (const batch of batches) {
			if (this.stopped || revision !== this.revision) return;
			const enc = this.device.createCommandEncoder();
			const pass = enc.beginRenderPass({
				...(layered
					? {
							depthStencilAttachment: {
								view: (this.depth as GPUTexture).createView(),
								depthClearValue: 1,
								depthLoadOp: batch.first === 0 ? ("clear" as const) : ("load" as const),
								depthStoreOp: "store" as const,
							},
						}
					: {}),
				colorAttachments: [
					{
						view: target.createView(),
						clearValue: { r: 0.07, g: 0.07, b: 0.07, a: 1 },
						loadOp: batch.first === 0 ? "clear" : "load",
						storeOp: "store",
					},
				],
			});
			pass.setPipeline(layered ? this.layeredPipeline : this.pipeline);
			pass.setBindGroup(0, bindGroup);
			if (batch.count) pass.draw(4, batch.count, 0, batch.first);
			pass.end();
			this.device.queue.submit([enc.finish()]);
			await this.device.queue.onSubmittedWorkDone();
			if (!live) this.onProgress(batch.first + batch.count, count);
		}
		if (this.stopped || revision !== this.revision) return;
		if (live) {
			this.lastFrame = { sequence: ++this.frame, events: count, layered, camera };
			return;
		}
		const present = this.device.createCommandEncoder();
		present.copyTextureToTexture({ texture: target }, { texture: this.ctx.getCurrentTexture() }, [
			w,
			h,
		]);
		this.device.queue.submit([present.finish()]);
		await this.device.queue.onSubmittedWorkDone();
		this.lastFrame = { sequence: ++this.frame, events: count, layered, camera };
	}

	private attachInteraction() {
		const pointers = new Map<number, { x: number; y: number }>(),
			c = this.canvas;
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
			Object.assign(
				this,
				moveCamera(
					this.camera(),
					((before.x - rect.left) / rect.width) * 2 - 1,
					1 - ((before.y - rect.top) / rect.height) * 2,
					((after.x - rect.left) / rect.width) * 2 - 1,
					1 - ((after.y - rect.top) / rect.height) * 2,
					before.distance > 0 && after.distance > 0 ? after.distance / before.distance : 1,
				),
			);
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
				const nx = (e.offsetX / c.clientWidth) * 2 - 1,
					ny = 1 - (e.offsetY / c.clientHeight) * 2;
				Object.assign(
					this,
					moveCamera(
						this.camera(),
						nx,
						ny,
						nx,
						ny,
						Math.exp(-Math.max(-2000, Math.min(2000, e.deltaY)) * 0.0015),
					),
				);
				this.gesture();
			},
			{ passive: false },
		);
		new ResizeObserver(() => this.requestDraw()).observe(c);
	}
}
