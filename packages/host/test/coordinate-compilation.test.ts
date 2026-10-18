import { describe, expect, it, vi } from "vitest";
import { canonical, digest } from "../src/artifact-store.js";
import { compileNearestF32 } from "../src/coordinate-compilation.js";
import type { GateCountRequest } from "../src/gate-counts.js";
import type { PopulationMedianRequest } from "../src/population-medians.js";

type Gate = GateCountRequest["gates"][number];
const rect = (
	id: string,
	min: number | null,
	max: number | null,
	parentId: string | null = null,
): Gate => ({
	id,
	name: id,
	parentId,
	dimensions: ["X"],
	geometry: { type: "rectangle", min: [min], max: [max] },
});
const poly = (vertices: [number, number][], id = "p", parentId: string | null = null): Gate => ({
	id,
	name: id,
	parentId,
	dimensions: ["X", "Y"],
	geometry: { type: "polygon", vertices },
});
const boolean = (
	id: string,
	op: "and" | "or" | "not",
	refs: string[],
	parentId: string | null = null,
): Gate => ({
	id,
	name: id,
	parentId,
	dimensions: [],
	geometry: { type: "boolean", op, refs },
});
const recipe = (gates: Gate[]): GateCountRequest => ({
	sampleId: "a".repeat(64),
	coordinateSpace: "stored-f32",
	startEvent: 7,
	eventCount: 11,
	gates,
});
const square = (lo: number, hi: number): [number, number][] => [
	[lo, lo],
	[hi, lo],
	[hi, hi],
	[lo, hi],
];

// CPU test-reference convention from gate-counts.test.ts:182-278: finite axes,
// inclusive rectangle bounds, strict-ray even-odd polygons, parent-restricted Booleans.
// Both comparisons use identical JS-number arithmetic and identical F32 events.
// This is a coordinate-only counterfactual, NOT GPU/native/topology parity evidence.
function memberships(rows: number[][], gates: Gate[]) {
	const columns: Record<string, number> = { X: 0, Y: 1 };
	const sets = new Map<string, Set<number>>();
	const pending = gates.slice();
	const bound = (value: number, edge: number | null | undefined, upper: boolean) =>
		edge === null || edge === undefined || (upper ? value <= edge : value >= edge);
	while (pending.length) {
		let progressed = false;
		for (let slot = pending.length - 1; slot >= 0; slot--) {
			const gate = pending[slot] as Gate;
			const deps = [
				...(gate.parentId === null ? [] : [gate.parentId]),
				...(gate.geometry.type === "boolean" ? gate.geometry.refs : []),
			];
			if (!deps.every((id) => sets.has(id))) continue;
			pending.splice(slot, 1);
			progressed = true;
			const parent =
				gate.parentId === null ? new Set(rows.keys()) : (sets.get(gate.parentId) as Set<number>);
			const members = new Set<number>();
			const geometry = gate.geometry;
			rows.forEach((row, index) => {
				if (!parent.has(index)) return;
				if (geometry.type === "boolean") {
					const values = geometry.refs.map((id) => (sets.get(id) as Set<number>).has(index));
					if (
						geometry.op === "and"
							? values.every(Boolean)
							: geometry.op === "or"
								? values.some(Boolean)
								: !values[0]
					)
						members.add(index);
					return;
				}
				const x = row[columns[gate.dimensions[0] as string] as number] as number;
				const y =
					gate.dimensions[1] === undefined
						? x
						: (row[columns[gate.dimensions[1]] as number] as number);
				if (!Number.isFinite(x) || !Number.isFinite(y)) return;
				if (geometry.type === "rectangle") {
					if (
						bound(x, geometry.min[0], false) &&
						bound(x, geometry.max[0], true) &&
						(gate.dimensions.length === 1 ||
							(bound(y, geometry.min[1], false) && bound(y, geometry.max[1], true)))
					)
						members.add(index);
				} else {
					let inside = false;
					for (let i = 0, j = geometry.vertices.length - 1; i < geometry.vertices.length; j = i++) {
						const [ax, ay] = geometry.vertices[i] as [number, number],
							[bx, by] = geometry.vertices[j] as [number, number];
						if (ay > y !== by > y) {
							const crossing = ax + ((y - ay) * (bx - ax)) / (by - ay);
							if (x < crossing) inside = !inside;
						}
					}
					if (inside) members.add(index);
				}
			});
			sets.set(gate.id, members);
		}
		if (!progressed) throw new Error("Invalid test DAG");
	}
	return gates.map((gate) => ({
		id: gate.id,
		members: [...(sets.get(gate.id) as Set<number>)],
		parentCount:
			gate.parentId === null ? rows.length : (sets.get(gate.parentId) as Set<number>).size,
	}));
}
const events = (rows: number[][]) => rows.map((row) => Array.from(new Float32Array(row)));
const rejection = (reason: string) =>
	expect.objectContaining({
		code: "COORDINATE_COMPILATION_REJECTED",
		details: expect.objectContaining({ profile: "nearest-f32-compiled-v1", reason }),
	});

describe("explicit nearest-F32 coordinate compilation (CPU metadata only)", () => {
	it.each([
		{ value: 0.1, lower: false, before: [0], after: [0, 1] },
		{ value: 0.7, lower: true, before: [2], after: [1, 2] },
	])(
		"records the membership-changing $value bound and signed coordinate delta",
		({ value, lower, before, after }) => {
			const original = recipe([rect("r", lower ? value : null, lower ? null : value)]);
			const unchanged = structuredClone(original);
			const rows = events([[0], [value], [1]]);
			const { compiled, report } = compileNearestF32(original);
			expect(memberships(rows, original.gates)[0]?.members).toEqual(before);
			expect(memberships(rows, compiled.gates)[0]?.members).toEqual(after);
			expect(original).toEqual(unchanged);
			expect(report).toMatchObject({
				profile: "nearest-f32-compiled-v1",
				semantics: "new-compiled-recipe",
				lossy: true,
				changedCoordinateCount: 1,
				maxAbsoluteError: Math.abs(Math.fround(value) - value),
				originalRecipeHash: digest(original),
				compiledRecipeHash: digest(compiled),
				membershipPreservation: "not-guaranteed",
				topologyPreservation: "not-guaranteed",
				topologyValidation: "limited-structural-checks",
			});
			expect(report.gates[0]).toEqual({
				id: "r",
				originalGeometry: original.gates[0]?.geometry,
				compiledGeometry: compiled.gates[0]?.geometry,
				deltas: {
					type: "rectangle",
					min: [lower ? Math.fround(value) - value : null],
					max: [lower ? null : Math.fround(value) - value],
				},
			});
			expect({ ...compiled, gates: original.gates }).toEqual(original);
		},
	);

	it("rounds midpoint ties to even neighbors around one", () => {
		const ulp = 2 ** -23;
		const original = recipe([rect("down", 1 + 2 ** -24, null), rect("up", null, 1 + 3 * 2 ** -24)]);
		const { compiled, report } = compileNearestF32(original);
		expect(compiled.gates.map(({ geometry }) => geometry)).toEqual([
			{ type: "rectangle", min: [1], max: [null] },
			{ type: "rectangle", min: [null], max: [1 + 2 * ulp] },
		]);
		const rows = events([[1], [1 + ulp], [1 + 2 * ulp], [1 + 3 * ulp]]);
		expect(memberships(rows, original.gates).map(({ members }) => members)).toEqual([
			[1, 2, 3],
			[0, 1],
		]);
		expect(memberships(rows, compiled.gates).map(({ members }) => members)).toEqual([
			[0, 1, 2, 3],
			[0, 1, 2],
		]);
		expect(report.changedCoordinateCount).toBe(2);
		expect(report.maxAbsoluteError).toBe(2 ** -24);
	});

	it("retains actual strict-ray edge/vertex conventions rather than excluding every boundary", () => {
		const original = recipe([poly(square(0, 1))]);
		const rows = events([
			[0, 0.5],
			[1, 0.5],
			[0.5, 0],
			[0.5, 1],
			[0, 0],
			[1, 0],
			[0, 1],
			[1, 1],
			[0.5, 0.5],
		]);
		const result = compileNearestF32(original);
		expect(memberships(rows, result.compiled.gates)[0]?.members).toEqual([0, 2, 4, 8]);
		expect(result.report.lossy).toBe(false);
		const raised = recipe([poly(square(0, 1 + 2 ** -24))]);
		const boundary = events([
			[1, 0.5],
			[0.5, 1],
			[1, 1],
			[0.5, 0.5],
		]);
		expect(memberships(boundary, raised.gates)[0]?.members).toEqual([0, 1, 2, 3]);
		expect(memberships(boundary, compileNearestF32(raised).compiled.gates)[0]?.members).toEqual([
			3,
		]);
		const moved = recipe([poly(square(1 + 2 ** -24, 2))]);
		const leftBottom = events([
			[1, 1],
			[1, 1.5],
			[1.5, 1],
			[1.5, 1.5],
		]);
		expect(memberships(leftBottom, moved.gates)[0]?.members).toEqual([3]);
		expect(memberships(leftBottom, compileNearestF32(moved).compiled.gates)[0]?.members).toEqual([
			0, 1, 2, 3,
		]);
	});

	it("rejects introduced thin-polygon and rectangle collapse without altering source coordinates", () => {
		const lo = 1 - 2 ** -26,
			hi = 1 + 2 ** -25;
		const original = recipe([
			poly([
				[lo, 0],
				[hi, 0],
				[hi, 1],
				[lo, 1],
			]),
		]);
		const before = structuredClone(original);
		expect(memberships(events([[1, 0.5]]), original.gates)[0]?.members).toEqual([0]);
		expect(() => compileNearestF32(original)).toThrowError(
			rejection("introduced-zero-span-polygon"),
		);
		expect(original).toEqual(before);
		expect(() => compileNearestF32(recipe([rect("r", lo, hi)]))).toThrowError(
			rejection("introduced-zero-width-rectangle"),
		);
		const duplicate = recipe([
			poly([
				[0, 0],
				[1, 1],
				[1 + 2 ** -25, 1 + 2 ** -25],
				[2, 0],
			]),
		]);
		expect(() => compileNearestF32(duplicate)).toThrowError(
			rejection("lost-distinct-polygon-vertices"),
		);
	});

	it("uses exact dyadic collinearity when binary64 products cancel, but permits existing degeneracy and zero-area bowties", () => {
		const n = 2 ** 30;
		// Exact determinant is -1; the two binary64 products round to the same value.
		expect(n * (n / 2 - 1.5) - (n - 1) * (n / 2 - 1)).toBe(0);
		expect(() =>
			compileNearestF32(
				recipe([
					poly([
						[0, 0],
						[n, n - 1],
						[n / 2 - 1, n / 2 - 1.5],
					]),
				]),
			),
		).toThrowError(rejection("introduced-polygon-collinearity"));
		const bowtie = recipe([
			poly([
				[0, 0],
				[1, 1],
				[0, 1],
				[1, 0],
			]),
		]);
		const compiled = compileNearestF32(bowtie);
		expect(compiled.report.lossy).toBe(false);
		expect(
			memberships(
				events([
					[0.25, 0.125],
					[0.25, 0.875],
					[0.5, 0.5],
					[0.75, 0.125],
					[0.75, 0.875],
				]),
				compiled.compiled.gates,
			)[0]?.members,
		).toEqual([0, 1, 3, 4]);
		const degenerate = recipe([
			poly([
				[0, 0],
				[1, 1],
				[2, 2],
			]),
		]);
		expect(compileNearestF32(degenerate).compiled).toEqual(degenerate);
	});

	it("accepts explicitly changed nested/Boolean memberships and denominators while preserving DAG metadata", () => {
		const bound = Math.fround(0.1);
		const original = recipe([
			boolean("within", "not", ["q"], "p"),
			boolean("not", "not", ["p"]),
			boolean("or", "or", ["p", "q"]),
			boolean("and", "and", ["p", "q"]),
			rect("child", null, null, "p"),
			rect("q", bound, null),
			rect("p", null, 0.1),
		]);
		const rows = events([[0], [bound], [0.5], [1]]);
		const result = compileNearestF32(original);
		expect(
			memberships(rows, original.gates).map(({ id, members, parentCount }) => [
				id,
				members.length,
				parentCount,
			]),
		).toEqual([
			["within", 1, 1],
			["not", 3, 4],
			["or", 4, 4],
			["and", 0, 4],
			["child", 1, 1],
			["q", 3, 4],
			["p", 1, 4],
		]);
		expect(
			memberships(rows, result.compiled.gates).map(({ id, members, parentCount }) => [
				id,
				members.length,
				parentCount,
			]),
		).toEqual([
			["within", 1, 2],
			["not", 2, 4],
			["or", 4, 4],
			["and", 1, 4],
			["child", 2, 2],
			["q", 3, 4],
			["p", 2, 4],
		]);
		expect(result.compiled.gates.map(({ geometry: _, ...gate }) => gate)).toEqual(
			original.gates.map(({ geometry: _, ...gate }) => gate),
		);
		expect(result.report.gates.slice(0, 4).map(({ deltas }) => deltas)).toEqual([
			null,
			null,
			null,
			null,
		]);
		expect(result.compiled.gates.slice(0, 4)).toEqual(original.gates.slice(0, 4));
	});

	it.each([
		[Infinity, "nonfinite-original"],
		[-Infinity, "nonfinite-original"],
		[NaN, "nonfinite-original"],
		[1e39, "overflow"],
		[2 ** -149, "compiled-subnormal"],
		[-(2 ** -149), "compiled-subnormal"],
		[2 ** -150, "underflow-to-zero"],
		[-(2 ** -150), "underflow-to-zero"],
	] as const)("rejects unsafe numeric coordinate %s (%s)", (value, reason) => {
		expect(() => compileNearestF32(recipe([rect("bad", null, value)]))).toThrowError(
			rejection(reason),
		);
	});

	it("retains original nonprecision shape, ordered-bound, magnitude and dy limits", () => {
		const cases: Array<[Gate, string]> = [
			[rect("r", 2, 1), "reversed-rectangle-bounds"],
			[
				poly([
					[0, 0],
					[2 ** 30 + 0.5, 0],
					[0, 1],
				]),
				"polygon-magnitude-limit",
			],
			[
				poly([
					[0, 0],
					[1, 0],
					[0, 2 ** -31],
				]),
				"polygon-edge-dy-limit",
			],
			[poly(Array.from({ length: 257 }, (_, i) => [i % 2, i % 3])), "invalid-gate-shape"],
			[{ ...rect("r", 0, 1), dimensions: ["X", "Y"] }, "rectangle-dimension-mismatch"],
			[boolean("b", "not", ["a", "c"]), "invalid-boolean-shape"],
		];
		for (const [gate, reason] of cases)
			expect(() => compileNearestF32(recipe([gate]))).toThrowError(rejection(reason));
	});

	it("rounds each finite coordinate once, canonicalizes zero explicitly, and hashes entire median recipes", () => {
		const original: PopulationMedianRequest = {
			...recipe([rect("r", null, -0), poly(square(0.1, 0.7))]),
			populationId: "p",
			channels: ["Y", "X"],
		};
		const rounding = vi.spyOn(Math, "fround");
		try {
			const { compiled, report } = compileNearestF32(original);
			expect(rounding).toHaveBeenCalledTimes(9);
			expect(compiled.populationId).toBe("p");
			expect(compiled.channels).toEqual(["Y", "X"]);
			expect(report.originalRecipeHash).toBe(digest(original));
			expect(report.compiledRecipeHash).toBe(digest(compiled));
			expect(report.originalRecipeHash).not.toBe(digest({ ...original, startEvent: 8 }));
			expect(report.changedCoordinateCount).toBe(9);
			const geometry = compiled.gates[0]?.geometry;
			expect(geometry?.type === "rectangle" && Object.is(geometry.max[0], 0)).toBe(true);
			const source = original.gates[0]?.geometry;
			expect(source?.type === "rectangle" && Object.is(source.max[0], -0)).toBe(true);
			expect(
				[compiled, compiled.gates, report, report.gates, report.gates[0]?.originalGeometry].every(
					Object.isFrozen,
				),
			).toBe(true);
		} finally {
			rounding.mockRestore();
		}
		const root: PopulationMedianRequest = {
			sampleId: "a".repeat(64),
			coordinateSpace: "stored-f32",
			populationId: null,
			channels: ["X"],
			gates: [],
		};
		expect(compileNearestF32(root)).toMatchObject({
			compiled: root,
			report: {
				lossy: false,
				changedCoordinateCount: 0,
				maxAbsoluteError: 0,
				gates: [],
				originalRecipeHash: digest(root),
				compiledRecipeHash: digest(root),
			},
		});
	});

	it("rejects oversized original/compiled recipes and complete reports rather than truncating evidence", () => {
		expect(() =>
			compileNearestF32(recipe([{ ...rect("r", 0, 1), name: "x".repeat(70000) }])),
		).toThrowError(rejection("original-recipe-too-large"));
		const expanded = recipe(
			Array.from({ length: 20 }, (_, index) =>
				poly(Array.from({ length: 64 }, () => square(0.1, 0.7)).flat(), `p${index}`),
			),
		);
		expect(Buffer.byteLength(canonical(expanded))).toBeLessThan(64 * 1024);
		expect(() => compileNearestF32(expanded)).toThrowError(rejection("compiled-recipe-too-large"));
		const reportHeavy = recipe(
			Array.from({ length: 16 }, (_, index) =>
				poly(Array.from({ length: 64 }, () => square(-0.5, 0.5)).flat(), `p${index}`),
			),
		);
		const before = canonical(reportHeavy);
		expect(Buffer.byteLength(before)).toBeLessThan(64 * 1024);
		expect(() => compileNearestF32(reportHeavy)).toThrowError(
			expect.objectContaining({ code: "COORDINATE_REPORT_TOO_LARGE" }),
		);
		expect(canonical(reportHeavy)).toBe(before);
	});
});
