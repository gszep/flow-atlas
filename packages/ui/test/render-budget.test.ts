import { afterEach, expect, it, vi } from "vitest";
import { canvasBudget, renderBatches } from "../src/render-budget.js";
import { PointRenderer } from "../src/renderer.js";

afterEach(() => vi.unstubAllGlobals());

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
	vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 16, COPY_DST: 2, COPY_SRC: 1 });
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
	const ctx = {
		configure: vi.fn(),
		getCurrentTexture: () => {
			calls.push("canvas");
			return {};
		},
	};
	const device = {
		limits: { maxTextureDimension2D: 8192 },
		lost: new Promise(() => {}),
		createShaderModule: () => ({}),
		createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
		createBuffer: () => ({}),
		createBindGroup: () => ({}),
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
		addEventListener() {},
	} as unknown as HTMLCanvasElement;
	return { device, canvas, calls, draws };
}

it("does not draw uncoloured data, drains batches, and only then acquires the canvas", async () => {
	const f = rendererFixture(),
		renderer = new PointRenderer(f.device, f.canvas);
	renderer.setData({} as GPUBuffer, {} as GPUBuffer, 65537, { minX: 0, maxX: 1, minY: 0, maxY: 1 });
	expect(f.calls).toEqual([]);
	await renderer.draw();
	expect(f.draws).toEqual([
		[6, 65536, 0, 0],
		[6, 1, 0, 65536],
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
