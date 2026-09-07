import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { biexTable, interpolate, invert, linearTable, logTable } from "../src/index.js";

interface Fixture {
	oracle: {
		params: {
			width: number;
			neg: number;
			pos: number;
			maxRange: number;
			channelRange: number;
			length: number;
		};
		x: number[];
		y: number[];
		probes: number[];
		values: number[];
	};
	default: { x: number[]; y: number[] };
}

const fx = JSON.parse(
	readFileSync(join(import.meta.dirname, "../../../fixtures/biex.json"), "utf8"),
) as Fixture;

const maxAbsDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
	let m = 0;
	for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs((a[i] as number) - (b[i] as number)));
	return m;
};

describe("biex parity with FlowWorkspace.jl", () => {
	it("oracle params table matches to 1e-9 relative", () => {
		const t = biexTable(fx.oracle.params);
		expect(t.x.length).toBe(fx.oracle.x.length);
		expect(maxAbsDiff(t.x, fx.oracle.x) / 262144).toBeLessThan(1e-9);
		expect(maxAbsDiff(t.y, fx.oracle.y)).toBe(0);
	});

	it("default params table matches", () => {
		const t = biexTable();
		expect(maxAbsDiff(t.x, fx.default.x) / 262144).toBeLessThan(1e-9);
	});

	it("interpolated probe values match Julia LinearInterpolation(Flat)", () => {
		const t = biexTable(fx.oracle.params);
		fx.oracle.probes.forEach((p, i) => {
			expect(interpolate(t, p)).toBeCloseTo(fx.oracle.values[i] as number, 6);
		});
	});

	it("x is strictly ascending; invert round-trips", () => {
		const t = biexTable(fx.oracle.params);
		for (let i = 1; i < t.x.length; i++) expect(t.x[i]).toBeGreaterThan(t.x[i - 1] as number);
		for (const p of [-500, 0, 3, 250, 40000, 200000]) {
			expect(invert(t, interpolate(t, p))).toBeCloseTo(p, 6);
		}
		expect(interpolate(t, Number.NaN)).toBeNaN();
	});
});

describe("linear / log", () => {
	it("linear with gain", () => {
		const t = linearTable({ maxRange: 10, gain: 2 });
		expect(interpolate(t, 3.5)).toBe(7);
		expect(interpolate(t, 100)).toBe(20); // flat extrapolation
	});
	it("log", () => {
		const t = logTable({ maxRange: 1000 });
		expect(interpolate(t, 99)).toBeCloseTo(2, 12);
	});
});
