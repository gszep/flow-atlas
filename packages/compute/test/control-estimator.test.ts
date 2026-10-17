import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	ControlEstimationError,
	type ControlMedians,
	estimateControlMatrix,
	type MedianEndpoints,
} from "../src/control-estimator.js";
import { Kernels } from "../src/kernels.js";
import { getDevice, releaseDevice } from "./setup.js";

let k: Kernels;
beforeAll(async () => {
	k = new Kernels((await getDevice()).device);
}, 30_000);
afterAll(() => releaseDevice());
const limit = 256 * 1024;
const endpoint = (lower: number[], upper = lower, count = 1): MedianEndpoints => ({
	count,
	lower,
	upper,
});
const control = (
	primaryDetector: string,
	positive: MedianEndpoints,
	negative = endpoint(positive.lower.map(() => 0)),
): ControlMedians => ({ primaryDetector, positive, negative });
// Independent mathematical midpoints in JS double precision are test-only.
function reference(names: string[], controls: ControlMedians[]): number[] {
	return names.flatMap((name, i) => {
		const c = controls.find((c) => c.primaryDetector === name) as ControlMedians;
		const delta = names.map(
			(_, j) =>
				((c.positive.lower[j] as number) + (c.positive.upper[j] as number)) / 2 -
				((c.negative.lower[j] as number) + (c.negative.upper[j] as number)) / 2,
		);
		return delta.map((v) => v / (delta[i] as number));
	});
}
async function rejected(controls: ControlMedians[], options = {}) {
	try {
		await estimateControlMatrix(
			k,
			controls.map((c) => c.primaryDetector),
			controls,
			limit,
			options,
		);
		throw new Error("Expected rejection");
	} catch (e) {
		expect(e).toBeInstanceOf(ControlEstimationError);
		const error = e as ControlEstimationError;
		expect(JSON.parse(JSON.stringify(error.diagnostics))).toEqual(error.diagnostics);
		return error;
	}
}

describe("explicit conventional GPU median-difference matrix", () => {
	it.each([2, 3])("recovers asymmetric %i-channel matrices with reordered controls", async (n) => {
		const names = ["A", "B", "C"].slice(0, n);
		const negative = endpoint([10, 20, 30].slice(0, n), [14, 24, 34].slice(0, n), 10);
		const controls = [
			control("A", endpoint([110, 40, 20].slice(0, n), [114, 44, 24].slice(0, n), 4), negative),
			control("B", endpoint([42, 222, 42].slice(0, n), undefined, 7), negative),
			control("C", endpoint([62, 12, 82], undefined, 3), negative),
		]
			.slice(0, n)
			.reverse();
		const before = structuredClone(controls);
		const output = await estimateControlMatrix(k, names, controls, limit);
		const expected = reference(names, controls);
		const maxError = Math.max(
			...output.matrix.map((v, i) => Math.abs(v - (expected[i] as number))),
		);
		expect(maxError).toBeLessThan(1e-6);
		expect(output.channels).toEqual(names);
		expect(controls).toEqual(before);
		expect(output.diagnostics.controls.map((c) => c.primarySeparation)).toEqual(
			[100, 200, 50].slice(0, n),
		);
		expect(output.diagnostics.controls.map((c) => c.negativeCoefficientCount)).toEqual(
			[n === 3 ? 1 : 0, 0, 1].slice(0, n),
		);
		expect(output.diagnostics.controls.every((c) => c.invalidCoefficientCount === 0)).toBe(true);
		expect(output.diagnostics).toMatchObject({ minEvents: 1, minPrimarySeparation: 0 });
		expect(JSON.parse(JSON.stringify(output.diagnostics))).toEqual(output.diagnostics);
		expect(
			Object.isFrozen(output) &&
				Object.isFrozen(output.channels) &&
				Object.isFrozen(output.diagnostics) &&
				Object.isFrozen(output.diagnostics.controls) &&
				output.diagnostics.controls.every(Object.isFrozen),
		).toBe(true);
	});

	it("avoids premature f32 midpoint rounding at large common baselines", async () => {
		const base = 2 ** 24;
		const negative = endpoint([base, base], [base + 2, base + 2], 2);
		const controls = [
			control("A", endpoint([base + 2, base], [base + 4, base + 4], 2), negative),
			control("B", endpoint([base, base + 2], [base + 4, base + 4], 2), negative),
		];
		const output = await estimateControlMatrix(k, ["A", "B"], controls, limit);
		expect(Array.from(output.matrix)).toEqual(reference(["A", "B"], controls));
		expect(Array.from(output.matrix)).toEqual([1, 0.5, 0.5, 1]);
		const prematurelyRounded =
			Math.fround((base + 2 + base + 4) / 2) - Math.fround((base + base + 2) / 2);
		expect(prematurelyRounded).toBe(4);
		expect(output.diagnostics.controls[0]?.primarySeparation).toBe(2);
	});

	it("retains signed coefficients above unity without max or max-absolute normalization", async () => {
		const result = await estimateControlMatrix(
			k,
			["A", "B"],
			[control("A", endpoint([2, -8])), control("B", endpoint([9, 3]))],
			limit,
		);
		expect(Array.from(result.matrix)).toEqual([1, -4, 3, 1]);
		expect(result.diagnostics.controls.map((c) => c.negativeCoefficientCount)).toEqual([1, 0]);
		expect((await rejected([control("A", endpoint([0]))])).diagnostics.controls[0]?.status).toBe(
			"insufficient-primary-separation",
		);
	});

	it("matches independent mathematical midpoints across heterogeneous endpoints", async () => {
		const names = Array.from({ length: 17 }, (_, i) => `D${i}`);
		const controls = names.map((name, i) => {
			const nl = names.map((_, j) => 1000 + j * 7 - i * 5);
			const nu = nl.map((v, j) => v + (j % 4));
			const pl = nl.map((v, j) => v + (i === j ? 500 + i * 20 : (j - i) * 17));
			const pu = pl.map((v, j) => v + (j % 3) * 5);
			return control(name, endpoint(pl, pu, 100), endpoint(nl, nu, 12));
		});
		const expected = reference(names, controls);
		const output = await estimateControlMatrix(k, names, controls.reverse(), limit);
		expect(
			Math.max(...output.matrix.map((v, i) => Math.abs(v - (expected[i] as number)))),
		).toBeLessThan(1e-6);
	});

	it("snapshots endpoints, options and names before awaits and owns independent results", async () => {
		const names = ["A"];
		const values = [3];
		const controls = [control("A", endpoint(values))];
		const options = { minEvents: 1 };
		const pending = estimateControlMatrix(k, names, controls, limit, options);
		names[0] = "changed";
		values[0] = -1;
		(controls[0] as ControlMedians).primaryDetector = "changed";
		options.minEvents = 100;
		const output = await pending;
		expect(output.channels).toEqual(["A"]);
		expect(output.diagnostics.controls[0]).toMatchObject({
			primaryDetector: "A",
			primarySeparation: 3,
		});
		output.matrix[0] = 100;
		const other = await estimateControlMatrix(k, ["A"], [control("A", endpoint([3]))], limit);
		expect(Array.from(other.matrix)).toEqual([1]);
	});

	it.each([0, -1, 5])(
		"rejects nonpositive or threshold-equal separation %i",
		async (separation) => {
			const e = await rejected([control("A", endpoint([separation]))], { minPrimarySeparation: 5 });
			expect(e.code).toBe("CONTROL_ESTIMATION_REJECTED");
			expect(e.diagnostics.controls[0]).toMatchObject({
				status: "insufficient-primary-separation",
				primarySeparation: separation,
				primarySeparationStatus: "available",
				invalidCoefficientCount: null,
				negativeCoefficientCount: null,
			});
		},
	);

	it("checks positive and negative support independently; accepts exact minEvents", async () => {
		const c = control("A", endpoint([4], [4], 5), endpoint([0], [0], 2));
		const e = await rejected([c], { minEvents: 3 });
		expect(e.diagnostics.controls[0]).toMatchObject({
			status: "insufficient-events",
			positiveCount: 5,
			negativeCount: 2,
		});
		const ok = await estimateControlMatrix(k, ["A"], [c], limit, {
			minEvents: 2,
			minPrimarySeparation: 3,
		});
		expect(ok.matrix[0]).toBe(1);
		c.positive.count = 1;
		expect((await rejected([c], { minEvents: 2 })).diagnostics.controls[0]?.status).toBe(
			"insufficient-events",
		);
	});

	it.each([
		[3e38, -3e38],
		[2 ** -126 + 2 ** -149, 2 ** -126],
		[2 ** 126, 0],
	])(
		"rejects unsafe primary paired differences (%s, %s) with unavailable quality",
		async (pos, neg) => {
			const e = await rejected([control("A", endpoint([pos]), endpoint([neg]))]);
			expect(e.diagnostics.controls[0]).toMatchObject({
				status: "unsafe-primary-difference",
				primarySeparation: null,
				primarySeparationStatus: "unavailable",
				invalidCoefficientCount: null,
			});
		},
	);

	it.each([
		[2 ** -126, 2], // ratio exceeds conservative ceiling
		[2, 2 ** -126], // ratio underflow
		[1, 3e38], // intermediate sum overflow guard
	])(
		"rejects invalid coefficients without fabricating valid diagnostics",
		async (primary, offDiagonal) => {
			const e = await rejected([
				control("A", endpoint([primary, offDiagonal])),
				control("B", endpoint([0, 1])),
			]);
			expect(e.diagnostics.controls).toMatchObject([
				{
					status: "invalid-coefficient",
					primarySeparation: primary,
					invalidCoefficientCount: 1,
					negativeCoefficientCount: 0,
				},
				{ status: "accepted", primarySeparation: 1, invalidCoefficientCount: 0 },
			]);
		},
	);

	it("accepts minimum-normal separation, huge shared baselines, and exact signed cancellation", async () => {
		const tiny = await estimateControlMatrix(
			k,
			["A"],
			[control("A", endpoint([2 ** -126]))],
			limit,
		);
		expect(tiny.matrix[0]).toBe(1);
		const big = 2 ** 127;
		const ulp = 2 ** 104;
		const output = await estimateControlMatrix(
			k,
			["A", "B"],
			[
				control("A", endpoint([big + ulp, 1], [big + ulp, 3], 2), endpoint([big, 0], [big, 4], 2)),
				control("B", endpoint([0, 1])),
			],
			limit,
		);
		expect(Array.from(output.matrix)).toEqual([1, 0, 0, 1]);
		expect(output.diagnostics.controls[0]?.primarySeparation).toBe(ulp);
	});

	it("rejects a subnormal midpoint even if both endpoint differences are normal", async () => {
		const min = 2 ** -126;
		const e = await rejected([control("A", endpoint([min], [min], 2), endpoint([0], [min], 2))]);
		expect(e.diagnostics.controls[0]?.status).toBe("unsafe-primary-difference");
	});

	it("validates names, shapes, counts, endpoints, options and budgets before allocation", async () => {
		const spy = vi.spyOn(k.device, "createBuffer");
		const good = control("A", endpoint([1]));
		const cases: Array<() => Promise<unknown>> = [
			() => estimateControlMatrix(k, [], [], limit),
			() => estimateControlMatrix(k, ["A", "A"], [good, good], limit),
			() => estimateControlMatrix(k, [""], [good], limit),
			() => estimateControlMatrix(k, ["a"], [good], limit),
			() => estimateControlMatrix(k, ["A"], [], limit),
			() => estimateControlMatrix(k, ["A", "B"], [good, good], limit),
			() => estimateControlMatrix(k, ["A"], [control("A", endpoint([]))], limit),
			() => estimateControlMatrix(k, ["A"], [control("A", endpoint([2], [1], 2))], limit),
			() => estimateControlMatrix(k, ["A"], [control("A", endpoint([1], [2], 3))], limit),
			() =>
				estimateControlMatrix(
					k,
					Array.from({ length: 129 }, (_, i) => `${i}`),
					[],
					limit,
				),
		];
		for (const v of [NaN, Infinity, -Infinity, 1e39, 1e-40, -1e-40, Number.MIN_VALUE])
			cases.push(() => estimateControlMatrix(k, ["A"], [control("A", endpoint([v]))], limit));
		for (const v of [0, -1, 1.5, NaN, Infinity, 2 ** 32]) {
			cases.push(() =>
				estimateControlMatrix(k, ["A"], [control("A", endpoint([1], [1], v))], limit),
			);
			cases.push(() => estimateControlMatrix(k, ["A"], [good], limit, { minEvents: v }));
		}
		for (const v of [-1, NaN, Infinity, 1e-40])
			cases.push(() => estimateControlMatrix(k, ["A"], [good], limit, { minPrimarySeparation: v }));
		for (const v of [0, NaN, Infinity, 23, 24.5])
			cases.push(() => estimateControlMatrix(k, ["A"], [good], v));
		try {
			const failures = [];
			for (const run of cases)
				failures.push(
					await run().then(
						() => false,
						() => true,
					),
				);
			expect(failures.every(Boolean)).toBe(true);
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("supports 128 channels with one bounded endpoint binding", async () => {
		const names = Array.from({ length: 128 }, (_, i) => `${i}`);
		const controls = names.map((name, i) =>
			control(name, endpoint(names.map((_, j) => (i === j ? 1 : 0)))),
		);
		const output = await estimateControlMatrix(k, names, controls, limit);
		expect(Array.from(output.matrix)).toEqual(controls.flatMap((c) => c.positive.lower));
		await expect(estimateControlMatrix(k, names, controls, limit - 1)).rejects.toThrow(
			/binding limit/,
		);
	});

	it("obeys actual device binding, buffer and dispatch limits", async () => {
		const controls = [control("A", endpoint([1, 0])), control("B", endpoint([0, 1]))];
		const limits = {
			maxStorageBufferBindingSize: limit,
			maxBufferSize: limit,
			maxComputeWorkgroupsPerDimension: 128,
		};
		const outcomes = [];
		for (const lowered of [
			{ maxBufferSize: 63 },
			{ maxStorageBufferBindingSize: 63 },
			{ maxComputeWorkgroupsPerDimension: 1 },
		]) {
			const bounded = { device: { limits: { ...limits, ...lowered } } } as unknown as Kernels;
			outcomes.push(
				await estimateControlMatrix(bounded, ["A", "B"], controls, limit).then(
					() => false,
					() => true,
				),
			);
		}
		expect(outcomes).toEqual([true, true, true]);
	});

	it("cleans every allocation on success, GPU rejection and pipeline/upload/readback failures", async () => {
		const created: GPUBuffer[] = [];
		const original = k.device.createBuffer.bind(k.device);
		const spy = vi.spyOn(k.device, "createBuffer").mockImplementation((desc) => {
			const b = original(desc);
			vi.spyOn(b, "destroy");
			created.push(b);
			return b;
		});
		k.device.pushErrorScope("validation");
		try {
			const good = [control("A", endpoint([1]))];
			await estimateControlMatrix(k, ["A"], good, 24);
			await rejected([control("A", endpoint([-1]))]);
			const get = vi.spyOn(k, "get").mockImplementationOnce(() => {
				throw new Error("pipeline failed");
			});
			await expect(estimateControlMatrix(k, ["A"], good, 24)).rejects.toThrow(/pipeline failed/);
			get.mockRestore();
			const write = vi.spyOn(k.device.queue, "writeBuffer").mockImplementationOnce(() => {
				throw new Error("upload failed");
			});
			await expect(estimateControlMatrix(k, ["A"], good, 24)).rejects.toThrow(/upload failed/);
			write.mockRestore();
			spy.mockImplementation((desc) => {
				const b = original(desc);
				vi.spyOn(b, "destroy");
				created.push(b);
				if (desc.usage & GPUBufferUsage.MAP_READ)
					vi.spyOn(b, "mapAsync").mockRejectedValueOnce(new Error("readback failed"));
				return b;
			});
			await expect(estimateControlMatrix(k, ["A"], good, 24)).rejects.toThrow(/readback failed/);
			expect(created.every((b) => vi.mocked(b.destroy).mock.calls.length === 1)).toBe(true);
			expect(created.every((b) => b.size <= 24)).toBe(true);
			expect(await k.device.popErrorScope()).toBeNull();
		} finally {
			spy.mockRestore();
		}
	});
});
