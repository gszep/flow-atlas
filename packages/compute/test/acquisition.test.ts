import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type AcquisitionChannel,
	AcquisitionNumericalError,
	linearizeChunk,
	prepareAcquisition,
} from "../src/acquisition.js";
import { Kernels } from "../src/kernels.js";
import { getDevice, releaseDevice } from "./setup.js";

let k: Kernels;
beforeAll(async () => {
	k = new Kernels((await getDevice()).device);
}, 30_000);
afterAll(() => releaseDevice());
const channel = (name = "A", gain = 1): AcquisitionChannel => ({
	name,
	gain,
	range: 1024,
	amplification: [0, 0],
});

describe("explicit GPU stored-to-acquisition-linear conversion", () => {
	it("copies identity bits including NaN payloads, infinities, subnormal and negative zero", async () => {
		const plan = await prepareAcquisition(k, [channel()], {}, 32);
		const bits = new Uint32Array([0x7fc00123, 0x7f800001, 0x80000000, 1, 0xff800000, 0x3f800000]);
		try {
			const output = await linearizeChunk(k, plan, new Float32Array(bits.buffer), 16);
			expect(new Uint32Array(output.buffer)).toEqual(bits);
			expect(output.buffer).not.toBe(bits.buffer);
			expect(plan.metadata.channels[0]?.operation).toBe("identity");
		} finally {
			plan.destroy();
		}
	});
	it("matches independent closed-form gain/log/time reference over whole-row windows and byte offsets", async () => {
		const channels: AcquisitionChannel[] = [
			channel("gain", 2),
			{ ...channel("log", 4), amplification: [4, 2] },
			{ ...channel("zero-log0", 2), amplification: [2, 0] },
			channel("tImE", 100),
			channel("mask"),
		];
		const plan = await prepareAcquisition(k, channels, { timeStep: 0.25 }, 160);
		const storage = new Float32Array(5 * 137 + 2),
			data = storage.subarray(1, -1);
		const bits = new Uint32Array(storage.buffer, 4, data.length);
		for (let row = 0; row < 137; row++) {
			data.set([-100 + row * 20, row * 10 - 400, row * 9 - 200, row * 4, 0], row * 5);
			bits[row * 5 + 4] = row % 2 ? 0x7fc00123 : 0x80000000;
		}
		const before = bits.slice();
		// Scalar closed-form reference is test-only; never production event arithmetic.
		const expected = Array.from(data, (v, i) =>
			i % 5 === 0
				? v / 2
				: i % 5 === 1
					? (2 * 10 ** ((4 * v) / 1024)) / 4
					: i % 5 === 2
						? 10 ** ((2 * v) / 1024) / 2
						: v * 0.25,
		);
		(channels[0] as AcquisitionChannel).gain = 999;
		try {
			const output = await linearizeChunk(k, plan, data, 40);
			let error = 0;
			for (let i = 0; i < output.length; i++)
				if (i % 5 !== 4)
					error = Math.max(
						error,
						Math.abs((output[i] as number) - (expected[i] as number)) /
							Math.max(1, Math.abs(expected[i] as number)),
					);
			expect(error).toBeLessThan(0.00001);
			expect(new Uint32Array(output.buffer).filter((_, i) => i % 5 === 4)).toEqual(
				before.filter((_, i) => i % 5 === 4),
			);
			expect(bits).toEqual(before);
			expect(plan.metadata).toMatchObject({
				timeChannel: "tImE",
				timeStep: 0.25,
				channels: [
					{ gain: 2 },
					{},
					{ log0: 1, log0Normalized: true },
					{ gain: 100, gainIgnored: true },
					{},
				],
			});
			expect(JSON.parse(JSON.stringify(plan.metadata))).toEqual(plan.metadata);
			expect(
				Object.isFrozen(plan) &&
					Object.isFrozen(plan.metadata) &&
					Object.isFrozen(plan.metadata.channels) &&
					plan.metadata.channels.every(Object.isFrozen),
			).toBe(true);
		} finally {
			plan.destroy();
		}
	});
	it("resolves only exact Time, defaults step to one, permits explicit exact overrides", async () => {
		for (const [names, options, resolved, expected] of [
			[["Time-A"], {}, null, [4]],
			[["Time"], {}, "Time", [8]],
			[["Time", "TIME"], { timeChannel: "TIME", timeStep: 2 }, "TIME", [4, 16]],
			[["Clock"], { timeChannel: "Clock" }, "Clock", [8]],
		] as const) {
			const plan = await prepareAcquisition(
				k,
				names.map((n) => channel(n, 2)),
				options,
				64,
			);
			try {
				expect(plan.timeChannel).toBe(resolved);
				expect(await linearizeChunk(k, plan, new Float32Array(names.length).fill(8), 16)).toEqual(
					new Float32Array(expected),
				);
			} finally {
				plan.destroy();
			}
		}
	});
	it("rejects bad metadata before allocating resources", async () => {
		const spy = vi.spyOn(k.device, "createBuffer");
		try {
			const invalid = [
				[],
				[channel("")],
				[channel(), channel()],
				[{ ...channel(), amplification: [0, 1] }],
				[{ ...channel(), amplification: [-1, 0] }],
				[{ ...channel(), amplification: [1, -1] }],
				[{ ...channel("Time"), amplification: [1, 1] }],
				[channel("Time"), channel("TIME")],
				...Array.from([0, -1, NaN, Infinity, 1e40, 1e-40, 1e-50], (v) => [
					{ ...channel(), gain: v },
				]),
				...Array.from([0, -1, NaN, Infinity, 1e40, 1e-40], (v) => [{ ...channel(), range: v }]),
			] as AcquisitionChannel[][];
			for (const channels of invalid)
				await expect(prepareAcquisition(k, channels, {}, 4096)).rejects.toThrow();
			for (const options of [
				{ timeChannel: "missing" },
				{ timeStep: 2 },
				{ timeStep: 0 },
				{ timeStep: NaN },
				{ timeStep: Infinity },
				{ timeStep: 1e-40 },
			])
				await expect(prepareAcquisition(k, [channel()], options, 32)).rejects.toThrow();
			for (const limit of [NaN, 0, 16, 31, 32.5])
				await expect(prepareAcquisition(k, [channel()], {}, limit)).rejects.toThrow();
			await expect(
				prepareAcquisition(
					k,
					Array.from({ length: 4097 }, (_, i) => channel(`${i}`)),
					{},
					1e6,
				),
			).rejects.toThrow(/4096/);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
	it.each([
		[channel("A", 0.5), [NaN, Infinity, 3e38, -Infinity]],
		[channel("A", 2), [2 ** -126, -(2 ** -126), 1e-40, -1e-40]],
		[{ ...channel(), amplification: [1, 1], range: 1 }, [100, -100, NaN, Infinity]],
		[channel("Time"), [3e38, -3e38, Infinity, NaN]],
	] as const)(
		"rejects unsafe transformed values with window-scoped GPU diagnostics",
		async (c, values) => {
			const plan = await prepareAcquisition(k, [c], c.name === "Time" ? { timeStep: 2 } : {}, 32);
			try {
				const input = new Float32Array([1, 1, 1, 1, ...values]);
				await expect(linearizeChunk(k, plan, input, 16)).rejects.toMatchObject({
					name: "AcquisitionNumericalError",
					diagnostics: {
						source: "gpu-computation",
						numericalErrors: 4,
						windowStartEvent: 4,
						windowEventCount: 4,
					},
				});
			} finally {
				plan.destroy();
			}
		},
	);
	it("supports the channel ceiling with separately bounded metadata and event windows", async () => {
		const plan = await prepareAcquisition(
			k,
			Array.from({ length: 4096 }, (_, i) => channel(`${i}`, 2)),
			{},
			131072,
		);
		try {
			expect(await linearizeChunk(k, plan, new Float32Array(8192).fill(-8), 16384)).toEqual(
				new Float32Array(8192).fill(-4),
			);
			await expect(linearizeChunk(k, plan, new Float32Array(), 16380)).rejects.toThrow(/row/);
		} finally {
			plan.destroy();
		}
	});
	it("cleans every buffer on success, rejected dispatch, numerical errors, concurrent work and destroy", async () => {
		const created: Array<{ size: number; destroy: ReturnType<typeof vi.spyOn> }> = [];
		const create = k.device.createBuffer.bind(k.device);
		const spy = vi.spyOn(k.device, "createBuffer").mockImplementation((desc) => {
			const buffer = create(desc);
			created.push({ size: buffer.size, destroy: vi.spyOn(buffer, "destroy") });
			return buffer;
		});
		k.device.pushErrorScope("validation");
		try {
			const plan = await prepareAcquisition(k, [channel("A", 2)], {}, 32);
			const writeBuffer = k.device.queue.writeBuffer.bind(k.device.queue);
			const failedWrite = vi
				.spyOn(k.device.queue, "writeBuffer")
				.mockImplementationOnce((...args) => writeBuffer(...args))
				.mockImplementationOnce(() => {
					throw new Error("uniform upload failed");
				});
			try {
				await expect(linearizeChunk(k, plan, new Float32Array([1]), 16)).rejects.toThrow(
					/uniform upload/,
				);
			} finally {
				failedWrite.mockRestore();
			}
			const empty = new Float32Array();
			expect(await linearizeChunk(k, plan, empty, 16)).not.toBe(empty);
			await expect(linearizeChunk({ device: {} } as Kernels, plan, empty, 16)).rejects.toThrow(
				/another/,
			);
			await expect(
				linearizeChunk(new Kernels(k.device, {}), plan, new Float32Array([1]), 16),
			).rejects.toThrow(/unknown kernel/);
			await expect(linearizeChunk(k, plan, new Float32Array([NaN]), 16)).rejects.toBeInstanceOf(
				AcquisitionNumericalError,
			);
			const pending = [1, -4].map((v) => linearizeChunk(k, plan, new Float32Array(53).fill(v), 16));
			plan.destroy();
			plan.destroy();
			await expect(linearizeChunk(k, plan, empty, 16)).rejects.toThrow(/destroyed/);
			expect(await Promise.all(pending)).toEqual([
				new Float32Array(53).fill(0.5),
				new Float32Array(53).fill(-2),
			]);
			expect(created.every((b) => b.destroy.mock.calls.length === 1)).toBe(true);
			expect(created.slice(1).every((b) => b.size <= 16)).toBe(true);
			expect(await k.device.popErrorScope()).toBeNull();
		} finally {
			spy.mockRestore();
		}
	});
	it("rejects incomplete rows and frees metadata after upload failure", async () => {
		const plan = await prepareAcquisition(k, [channel(), channel("B")], {}, 64);
		try {
			await expect(linearizeChunk(k, plan, new Float32Array(3), 16)).rejects.toThrow(/complete/);
		} finally {
			plan.destroy();
		}
		const buffer = k.device.createBuffer({
			size: 32,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		const destroyed = vi.spyOn(buffer, "destroy");
		const allocate = vi.spyOn(k.device, "createBuffer").mockReturnValueOnce(buffer);
		const write = vi.spyOn(k.device.queue, "writeBuffer").mockImplementationOnce(() => {
			throw new Error("upload failed");
		});
		try {
			await expect(prepareAcquisition(k, [channel()], {}, 32)).rejects.toThrow(/upload failed/);
			expect(destroyed).toHaveBeenCalledTimes(1);
		} finally {
			allocate.mockRestore();
			write.mockRestore();
		}
	});
});
