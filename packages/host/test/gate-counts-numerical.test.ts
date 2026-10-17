import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernels } from "@flow-atlas/compute";
import { type FcsFile, openFcs } from "@flow-atlas/fcs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDevice, releaseDevice } from "../../compute/test/setup.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { type GateCountRequest, resolveGateCounts, runGateCounts } from "../src/gate-counts.js";

type Gate = GateCountRequest["gates"][number];
type Sample = { sampleId: string; metadata: Omit<FcsFile, "data"> };
const MAX = 2 ** 128 - 2 ** 104;
const MAGNITUDE = 2 ** 30;
const DY = 2 ** -30;
let root: string;
let store: ArtifactStore;
let kernels: Kernels;
let baseline: Sample;
let serial = 0;

// Independent little-endian FCS encoder: deliberately preserves NaN/infinities
// rather than relying on production export validation or production gate references.
function synthetic(rows: Array<[number, number]>): Uint8Array {
	const keywords: Record<string, string> = {
		$BEGINANALYSIS: "0",
		$ENDANALYSIS: "0",
		$BEGINSTEXT: "0",
		$ENDSTEXT: "0",
		$BYTEORD: "1,2,3,4",
		$DATATYPE: "F",
		$MODE: "L",
		$NEXTDATA: "0",
		$PAR: "2",
		$TOT: String(rows.length),
	};
	for (const [index, name] of ["x", "y"].entries()) {
		const p = `$P${index + 1}`;
		Object.assign(keywords, {
			[`${p}B`]: "32",
			[`${p}N`]: name,
			[`${p}R`]: "4096",
			[`${p}E`]: "0,0",
			[`${p}G`]: "1",
		});
	}
	let begin = 0;
	let text = new Uint8Array();
	for (;;) {
		keywords.$BEGINDATA = String(begin);
		keywords.$ENDDATA = String(begin + rows.length * 8 - 1);
		text = new TextEncoder().encode(`|${Object.entries(keywords).flat().join("|")}|`);
		const next = 58 + text.length;
		if (next === begin) break;
		begin = next;
	}
	const bytes = new Uint8Array(begin + rows.length * 8);
	bytes.set(
		new TextEncoder().encode(
			`FCS3.1    ${[58, begin - 1, begin, bytes.length - 1, 0, 0]
				.map((value) => String(value).padStart(8))
				.join("")}`,
		),
	);
	bytes.set(text, 58);
	const view = new DataView(bytes.buffer);
	rows.forEach(([x, y], index) => {
		view.setFloat32(begin + index * 8, x, true);
		view.setFloat32(begin + index * 8 + 4, y, true);
	});
	return bytes;
}

async function sample(rows: Array<[number, number]>): Promise<Sample> {
	const bytes = synthetic(rows);
	const name = `numerical-${serial++}.fcs`;
	await writeFile(join(root, name), bytes);
	const snapshot = await store.snapshot(name);
	const reader = await openFcs({
		size: bytes.length,
		read: async (offset, length) => bytes.slice(offset, offset + length),
	});
	return { sampleId: snapshot.sha256, metadata: reader.metadata };
}

function rectangle(
	id: string,
	min: Array<number | null> = [null, null],
	max: Array<number | null> = [null, null],
): Gate {
	return {
		id,
		name: id,
		parentId: null,
		dimensions: min.length === 1 ? ["x"] : ["x", "y"],
		geometry: { type: "rectangle", min, max },
	};
}
function polygon(id: string, vertices: Array<[number, number]>): Gate {
	return {
		id,
		name: id,
		parentId: null,
		dimensions: ["x", "y"],
		geometry: { type: "polygon", vertices },
	};
}
function not(id: string, ref: string, parentId: string | null = null): Gate {
	return {
		id,
		name: id,
		parentId,
		dimensions: [],
		geometry: { type: "boolean", op: "not", refs: [ref] },
	};
}
function resolve(
	source: Sample,
	gates: Gate[],
	range: { startEvent?: number; eventCount?: number } = {},
) {
	return resolveGateCounts(
		{ sampleId: source.sampleId, coordinateSpace: "stored-f32", gates, ...range },
		source.metadata,
	);
}
function run(resolved: ReturnType<typeof resolve>, progress: (count: number) => void = () => {}) {
	// Two rows per chunk forces aggregation without a large synthetic population.
	return runGateCounts(kernels, store, resolved, 1024, 16, new AbortController().signal, progress);
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "flow-atlas-gate-numerical-"));
	store = await ArtifactStore.create(root);
	baseline = await sample([
		[0, 0],
		[1, 1],
	]);
	kernels = new Kernels((await getDevice()).device);
}, 30_000);
afterAll(async () => {
	kernels?.device.destroy();
	releaseDevice();
	if (root) await rm(root, { recursive: true, force: true });
});

describe("stored-F32 gate numerical policy (direct host runner, real GPU)", () => {
	it("includes both exact F32 extrema for null bounds, excludes nonfinite geometric coordinates, and complements rows with NOT", async () => {
		const source = await sample([
			[-MAX, 0],
			[MAX, 0],
			[0, -MAX],
			[0, MAX],
			[0, 0],
			[Number.NaN, 0],
			[0, Number.NaN],
			[Number.POSITIVE_INFINITY, 0],
			[Number.NEGATIVE_INFINITY, 0],
			[0, Number.POSITIVE_INFINITY],
			[0, Number.NEGATIVE_INFINITY],
		]);
		const progress: number[] = [];
		const result = await run(
			resolve(source, [
				rectangle("finite"),
				not("nonfinite", "finite"),
				rectangle("x-only", [null], [null]),
				rectangle("negative-extreme", [-MAX], [-MAX]),
				rectangle("positive-extreme", [MAX], [MAX]),
				polygon("square", [
					[-1, -1],
					[1, -1],
					[1, 1],
					[-1, 1],
				]),
				not("not-square", "square"),
			]),
			(count) => {
				progress.push(count);
			},
		);
		// Hand-enumerated memberships, not a second implementation of the algorithm.
		expect(result.counts.map(({ id, count }) => [id, count])).toEqual([
			["finite", 5],
			["nonfinite", 6],
			["x-only", 8],
			["negative-extreme", 1],
			["positive-extreme", 1],
			["square", 1],
			["not-square", 10],
		]);
		expect(result.rootCount).toBe(11);
		expect(result.counts[1]).toMatchObject({
			parentCount: 11,
			frequencyOfParent: 6 / 11,
			frequencyOfRoot: 6 / 11,
		});
		expect(progress).toEqual([2, 2, 2, 2, 2, 1]);
	});

	it("accepts exact polygon magnitude/dy limits while prefiltering huge outside coordinates", async () => {
		const source = await sample([
			[0.25, DY / 2],
			[0, MAGNITUDE / 2],
			[0, -MAGNITUDE / 2],
			[MAGNITUDE / 2, MAGNITUDE / 2],
			[MAX, 0],
			[-MAX, 0],
			[0, MAX],
			[0, -MAX],
			[0.5, DY / 4],
			[1.5, (3 * DY) / 4],
		]);
		const result = await run(
			resolve(source, [
				polygon("magnitude-limit", [
					[-MAGNITUDE, -MAGNITUDE],
					[MAGNITUDE, -MAGNITUDE],
					[0, MAGNITUDE],
				]),
				polygon("dy-limit", [
					[0, 0],
					[2, 0],
					[0, DY],
				]),
			]),
		);
		// Large triangle: rows 0,1,2,8,9. Thin triangle: rows 0,8.
		// All selected points are strictly away from polygon edges.
		expect(result.counts.map(({ count }) => count)).toEqual([5, 2]);
		expect(result.counts.map(({ frequencyOfRoot }) => frequencyOfRoot)).toEqual([0.5, 0.2]);
	});

	it.each([
		["nonexact rectangle", rectangle("bad", [0.1], [1])],
		["subnormal rectangle", rectangle("bad", [2 ** -149], [1])],
		[
			"nonexact polygon",
			polygon("bad", [
				[0, 0],
				[0.1, 0],
				[0, 1],
			]),
		],
		[
			"subnormal polygon",
			polygon("bad", [
				[0, 0],
				[2 ** -149, 0],
				[0, 1],
			]),
		],
		[
			"excess polygon magnitude",
			polygon("bad", [
				[0, 0],
				[2 ** 31, 0],
				[0, 1],
			]),
		],
		[
			"undersized nonhorizontal dy",
			polygon("bad", [
				[0, 0],
				[1, 0],
				[0, 2 ** -31],
			]),
		],
	] as Array<[string, Gate]>)("rejects %s geometry before execution", (_, gate) => {
		expect(() => resolve(baseline, [gate])).toThrowError(
			expect.objectContaining({ code: "INVALID_GATE_RECIPE" }),
		);
	});

	it("returns zero counts and null denominators for an empty range without allocating GPU buffers", async () => {
		const allocations = vi.spyOn(kernels.device, "createBuffer");
		const progress = vi.fn();
		try {
			const result = await run(
				resolve(baseline, [rectangle("empty"), not("child", "empty", "empty")], {
					startEvent: 2,
					eventCount: 0,
				}),
				progress,
			);
			expect(result).toMatchObject({ startEvent: 2, eventCount: 0, rootCount: 0 });
			expect(
				result.counts.map(
					({ count, parentCount, rootCount, frequencyOfParent, frequencyOfRoot }) => ({
						count,
						parentCount,
						rootCount,
						frequencyOfParent,
						frequencyOfRoot,
					}),
				),
			).toEqual(
				Array.from({ length: 2 }, () => ({
					count: 0,
					parentCount: 0,
					rootCount: 0,
					frequencyOfParent: null,
					frequencyOfRoot: null,
				})),
			);
			expect(allocations).not.toHaveBeenCalled();
			expect(progress).not.toHaveBeenCalled();
		} finally {
			allocations.mockRestore();
		}
	});

	it("destroys columns, retained masks, and the bounding-box mask when polygon evaluation fails", async () => {
		const resolved = resolve(baseline, [
			rectangle("retained"),
			polygon("fails", [
				[-2, -2],
				[2, -2],
				[0, 2],
			]),
		]);
		const destroyed: Array<ReturnType<typeof vi.spyOn>> = [];
		const create = kernels.device.createBuffer.bind(kernels.device);
		const allocate = vi.spyOn(kernels.device, "createBuffer").mockImplementation((descriptor) => {
			const buffer = create(descriptor);
			destroyed.push(vi.spyOn(buffer, "destroy"));
			return buffer;
		});
		const get = kernels.get.bind(kernels);
		let gateCalls = 0;
		const failure = new Error("injected polygon pipeline failure");
		const pipeline = vi.spyOn(kernels, "get").mockImplementation((name) => {
			// First gate is retained; second is the polygon prefilter; third fails.
			if (name === "gate" && ++gateCalls === 3) throw failure;
			return get(name);
		});
		const progress = vi.fn();
		try {
			await expect(run(resolved, progress)).rejects.toBe(failure);
			expect(gateCalls).toBe(3);
			expect(destroyed.length).toBeGreaterThan(0);
			expect(destroyed.every((spy) => spy.mock.calls.length === 1)).toBe(true);
			expect(progress).not.toHaveBeenCalled();
		} finally {
			pipeline.mockRestore();
			allocate.mockRestore();
			for (const spy of destroyed) spy.mockRestore();
		}
	});
});
