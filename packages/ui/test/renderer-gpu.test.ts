import { afterAll, expect, it, vi } from "vitest";
import { upload } from "../../compute/src/buffers.js";
import { getDevice, releaseDevice } from "../../compute/test/setup.js";
import pointsSrc from "../src/points.wgsl?raw";
import { PointRenderer } from "../src/renderer.js";

afterAll(() => {
	vi.unstubAllGlobals();
	releaseDevice();
});

it("batched GPU rendering including the tail matches a single ordered draw", async () => {
	const { device } = await getDevice();
	device.pushErrorScope("validation");
	const size = 64,
		n = 65537,
		format = "rgba8unorm" as const;
	const positions = new Float32Array(n * 2),
		colors = new Uint32Array(n);
	// Distinct tail at the center catches lost or incorrectly rebased instances.
	for (let i = 0; i < n - 1; i++) {
		positions[i * 2] = (i % 31) / 31;
		positions[i * 2 + 1] = (i % 37) / 37;
		colors[i] = 0xff4080f0;
	}
	positions[(n - 1) * 2] = positions[(n - 1) * 2 + 1] = 0.5;
	colors[n - 1] = 0xff00ff00;
	const pos = upload(device, positions),
		color = upload(device, colors);
	const desc = {
		size: [size, size],
		format,
		usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
	};
	const actual = device.createTexture(desc),
		expected = device.createTexture(desc);
	vi.stubGlobal("window", { devicePixelRatio: 1 });
	vi.stubGlobal("matchMedia", () => ({ matches: true }));
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
		},
	);
	vi.stubGlobal("navigator", { gpu: { getPreferredCanvasFormat: () => format } });
	const events = new Map<string, (event: Partial<PointerEvent>) => void>();
	let frame: FrameRequestCallback | null = null;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frame = callback;
		return 1;
	});
	vi.stubGlobal("cancelAnimationFrame", () => {
		frame = null;
	});
	const canvas = {
		width: size,
		height: size,
		clientWidth: size,
		clientHeight: size,
		addEventListener(name: string, callback: (event: Partial<PointerEvent>) => void) {
			events.set(name, callback);
		},
		setPointerCapture() {},
		getBoundingClientRect: () => ({ left: 0, top: 0, width: size, height: size }),
		getContext: () => ({ configure() {}, getCurrentTexture: () => actual }),
	} as unknown as HTMLCanvasElement;
	const renderer = new PointRenderer(device, canvas);
	renderer.setData(pos, color, n, { minX: 0, maxX: 1, minY: 0, maxY: 1 });
	await renderer.draw();
	const module = device.createShaderModule({ code: pointsSrc });
	const pipeline = device.createRenderPipeline({
		layout: "auto",
		vertex: { module, entryPoint: "vs" },
		fragment: {
			module,
			entryPoint: "fs",
			targets: [
				{
					format,
					blend: {
						color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
						alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
					},
				},
			],
		},
		primitive: { topology: "triangle-list" },
	});
	const view = device.createBuffer({
		size: 32,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
	});
	device.queue.writeBuffer(
		view,
		0,
		new Float32Array([1.8, 1.8, -0.9, -0.9, 3 / size, 3 / size, 0, 0]),
	);
	const bg = device.createBindGroup({
		layout: pipeline.getBindGroupLayout(0),
		entries: [view, pos, color].map((buffer, binding) => ({ binding, resource: { buffer } })),
	});
	const encoder = device.createCommandEncoder();
	const pass = encoder.beginRenderPass({
		colorAttachments: [
			{
				view: expected.createView(),
				loadOp: "clear",
				storeOp: "store",
				clearValue: { r: 0.07, g: 0.07, b: 0.07, a: 1 },
			},
		],
	});
	pass.setPipeline(pipeline);
	pass.setBindGroup(0, bg);
	pass.draw(6, n);
	pass.end();
	const buffers = [actual, expected].map((texture) => {
		const buffer = device.createBuffer({
			size: size * size * 4,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		});
		encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: size * 4 }, [size, size]);
		return buffer;
	});
	device.queue.submit([encoder.finish()]);
	await Promise.all(buffers.map((buffer) => buffer.mapAsync(GPUMapMode.READ)));
	const pixels = buffers.map((buffer) => new Uint8Array(buffer.getMappedRange().slice(0)));
	expect(pixels[0]).toEqual(pixels[1]);
	expect(pixels[0]?.some((value, index) => index % 4 === 1 && value > 100)).toBe(true);
	// A gesture moves the completed GPU image immediately, without revisiting points.
	events.get("pointerdown")?.({ pointerId: 1, pointerType: "touch", clientX: 0, clientY: 0 });
	events.get("pointermove")?.({ pointerId: 1, clientX: 16, clientY: 0 });
	expect(frame).not.toBeNull();
	(frame as unknown as FrameRequestCallback)(0);
	await device.queue.onSubmittedWorkDone();
	await renderer.pause();
	const shifted = device.createBuffer({
		size: size * size * 4,
		usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
	});
	const copy = device.createCommandEncoder();
	copy.copyTextureToBuffer({ texture: actual }, { buffer: shifted, bytesPerRow: size * 4 }, [
		size,
		size,
	]);
	device.queue.submit([copy.finish()]);
	await shifted.mapAsync(GPUMapMode.READ);
	const moved = new Uint8Array(shifted.getMappedRange());
	let difference = 0;
	for (let y = 0; y < size; y++)
		for (let x = 0; x < size; x++)
			for (let c = 0; c < 4; c++) {
				const reference =
					x < 16
						? c === 3
							? 255
							: 18
						: ((pixels[0] as Uint8Array)[(y * size + x - 16) * 4 + c] as number);
				difference = Math.max(
					difference,
					Math.abs((moved[(y * size + x) * 4 + c] as number) - reference),
				);
			}
	expect(difference).toBe(0);
	shifted.destroy();
	expect(await device.popErrorScope()).toBeNull();
	for (const buffer of [...buffers, pos, color, view]) buffer.destroy();
	actual.destroy();
	expected.destroy();
	device.destroy();
}, 30000);
