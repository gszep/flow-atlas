import { afterEach, expect, it, vi } from "vitest";
import { moveCamera } from "../src/map-camera.js";
import { canvasBudget, renderBatches } from "../src/render-budget.js";
import { PointRenderer } from "../src/renderer.js";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it("retains every event including the tail while capping each draw", () => {
	const batches = renderBatches(3885530);
	let next = 0;
	const valid = batches.every((batch) => {
		const ok = batch.first === next && batch.count > 0 && batch.count <= 65536;
		next += batch.count;
		return ok;
	});
	expect(valid).toBe(true);
	expect(next).toBe(3885530);
	expect(batches.at(-1)).toEqual({ first: 3866624, count: 18906 });
});

it("caps phone pixel density and honors texture limits without sampling events", () => {
	expect(canvasBudget(390, 844, 3, 8192, true)).toEqual({ width: 585, height: 1266, ratio: 1.5 });
	const large = canvasBudget(6000, 4000, 3, 2048, true);
	expect(large.width * large.height).toBeLessThanOrEqual(2_000_000);
	expect(Math.max(large.width, large.height)).toBeLessThanOrEqual(2048);
});

function rendererFixture() {
	vi.stubGlobal("GPUTextureUsage", {
		RENDER_ATTACHMENT: 16,
		COPY_DST: 2,
		COPY_SRC: 1,
		TEXTURE_BINDING: 4,
	});
	vi.stubGlobal("GPUBufferUsage", { UNIFORM: 64, COPY_DST: 8 });
	vi.stubGlobal("window", { devicePixelRatio: 3 });
	vi.stubGlobal("matchMedia", () => ({ matches: true }));
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
		},
	);
	vi.stubGlobal("navigator", { gpu: { getPreferredCanvasFormat: () => "bgra8unorm" } });
	const calls: string[] = [],
		draws: number[][] = [];
	const events = new Map<string, (event: Partial<PointerEvent & WheelEvent>) => void>();
	const frames = new Map<number, FrameRequestCallback>();
	let frameId = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++frameId, callback);
		return frameId;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => {
		frames.delete(id);
	});
	const ctx = {
		configure: vi.fn(),
		getCurrentTexture: () => {
			calls.push("canvas");
			return { createView: () => ({}) };
		},
	};
	const device = {
		limits: { maxTextureDimension2D: 8192 },
		lost: new Promise(() => {}),
		createShaderModule: () => ({}),
		createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
		createBuffer: () => ({}),
		createBindGroup: () => ({}),
		createSampler: () => ({}),
		createTexture: () => ({ createView: () => ({}), destroy: vi.fn() }),
		queue: {
			writeBuffer: vi.fn(),
			submit: () => {
				calls.push("submit");
			},
			onSubmittedWorkDone: async () => {
				calls.push("drain");
			},
		},
		createCommandEncoder: () => ({
			beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
				calls.push(
					(Array.from(descriptor.colorAttachments)[0] as GPURenderPassColorAttachment).loadOp,
				);
				return {
					setPipeline() {},
					setBindGroup() {},
					draw: (...args: number[]) => {
						draws.push(args);
					},
					end() {},
				};
			},
			copyTextureToTexture: () => {
				calls.push("present");
			},
			finish: () => ({}),
		}),
	} as unknown as GPUDevice;
	const canvas = {
		clientWidth: 390,
		clientHeight: 844,
		width: 0,
		height: 0,
		getContext: () => ctx,
		addEventListener(name: string, callback: (event: Partial<PointerEvent & WheelEvent>) => void) {
			events.set(name, callback);
		},
		setPointerCapture() {},
		getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844 }),
	} as unknown as HTMLCanvasElement;
	return { device, canvas, calls, draws, events, frames };
}

it("does not draw uncoloured data, drains batches, and only then acquires the canvas", async () => {
	const f = rendererFixture(),
		renderer = new PointRenderer(f.device, f.canvas);
	renderer.setData({} as GPUBuffer, {} as GPUBuffer, 65537, { minX: 0, maxX: 1, minY: 0, maxY: 1 });
	expect(f.calls).toEqual([]);
	await renderer.draw();
	expect(f.draws).toEqual([
		[4, 65536, 0, 0],
		[4, 1, 0, 65536],
	]);
	expect(f.calls).toEqual([
		"clear",
		"submit",
		"drain",
		"load",
		"submit",
		"drain",
		"canvas",
		"present",
		"submit",
		"drain",
	]);
});

it("cancels superseded batches before presenting and starts a fresh frame", async () => {
	const f = rendererFixture();
	let renderer: PointRenderer, paused: Promise<void> | undefined;
	renderer = new PointRenderer(
		f.device,
		f.canvas,
		() => {},
		(done) => {
			if (done === 65536) paused = renderer.pause();
		},
	);
	renderer.setData({} as GPUBuffer, {} as GPUBuffer, 65537, { minX: 0, maxX: 1, minY: 0, maxY: 1 });
	await renderer.draw();
	await paused;
	expect(f.draws).toHaveLength(1);
	expect(f.calls).not.toContain("canvas");
	renderer.setData({} as GPUBuffer, {} as GPUBuffer, 1, { minX: 0, maxX: 1, minY: 0, maxY: 1 });
	await renderer.draw();
	expect(f.calls).toContain("present");
});

it("coalesces wheel events into one live full-point draw with no later refinement", async () => {
	vi.useFakeTimers();
	const f = rendererFixture(),
		renderer = new PointRenderer(f.device, f.canvas);
	renderer.setData({} as GPUBuffer, {} as GPUBuffer, 3885530, {
		minX: 0,
		maxX: 1,
		minY: 0,
		maxY: 1,
	});
	await renderer.draw();
	f.draws.length = 0;
	f.calls.length = 0;
	for (let i = 0; i < 100; i++)
		f.events.get("wheel")?.({ preventDefault() {}, deltaY: -1, offsetX: 195, offsetY: 422 });
	expect(f.frames.size).toBe(1);
	expect(f.draws).toHaveLength(0);
	const callback = [...f.frames.values()][0];
	f.frames.clear();
	callback?.(0);
	await vi.advanceTimersByTimeAsync(0);
	expect(f.draws).toEqual([[4, 3885530, 0, 0]]);
	expect(f.calls).not.toContain("present");
	await vi.advanceTimersByTimeAsync(500);
	expect(f.draws).toEqual([[4, 3885530, 0, 0]]);
});

it("pinches around the moving midpoint and handles pointer cancellation", async () => {
	vi.useFakeTimers();
	const f = rendererFixture(),
		renderer = new PointRenderer(f.device, f.canvas);
	renderer.setData({} as GPUBuffer, {} as GPUBuffer, 1, { minX: 0, maxX: 1, minY: 0, maxY: 1 });
	await renderer.draw();
	f.events.get("pointerdown")?.({ pointerId: 1, pointerType: "touch", clientX: 100, clientY: 200 });
	f.events.get("pointerdown")?.({ pointerId: 2, pointerType: "touch", clientX: 200, clientY: 200 });
	f.events.get("pointermove")?.({ pointerId: 2, clientX: 300, clientY: 200 });
	expect(renderer.zoom).toBeCloseTo(2);
	f.events.get("pointercancel")?.({ pointerId: 2 });
	const zoom = renderer.zoom;
	f.events.get("pointermove")?.({ pointerId: 1, clientX: 110, clientY: 200 });
	expect(renderer.zoom).toBe(zoom);
	await renderer.pause();
	expect(f.frames.size).toBe(0);
});

it("gesture transforms preserve the point under the moving midpoint", () => {
	const completed = { zoom: 2, panX: 0.25, panY: -0.5 };
	const live = moveCamera(completed, 0.4, -0.2, 0.6, 0.1, 1.5);
	const worldX = (0.4 - completed.panX) / completed.zoom;
	const worldY = (-0.2 - completed.panY) / completed.zoom;
	expect(worldX * live.zoom + live.panX).toBeCloseTo(0.6);
	expect(worldY * live.zoom + live.panY).toBeCloseTo(0.1);
});

it("keeps only one point frame in flight and cancels the pending camera on pause", async () => {
	vi.useFakeTimers();
	const f = rendererFixture(),
		renderer = new PointRenderer(f.device, f.canvas);
	renderer.setData({} as GPUBuffer, {} as GPUBuffer, 1, { minX: 0, maxX: 1, minY: 0, maxY: 1 });
	await renderer.draw();
	f.draws.length = 0;
	const releases: Array<() => void> = [];
	const completion = vi.spyOn(f.device.queue, "onSubmittedWorkDone").mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				releases.push(resolve);
			}),
	);
	for (let i = 0; i < 20; i++) {
		f.events.get("wheel")?.({ preventDefault() {}, deltaY: -1, offsetX: 195, offsetY: 422 });
		const callback = [...f.frames.values()][0];
		f.frames.clear();
		callback?.(0);
	}
	expect(f.draws).toEqual([[4, 1, 0, 0]]);
	expect(releases).toHaveLength(1);
	const paused = renderer.pause();
	completion.mockRestore();
	for (const release of releases) release();
	await paused;
	expect(f.frames.size).toBe(0);
});
