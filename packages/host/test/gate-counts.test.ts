import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAnalysisService } from "../src/analysis.js";
import type { AnalysisService, OperationArgs } from "../src/contracts.js";
import { createStudioServer } from "../src/server.js";

type Request = OperationArgs<"start_gate_counts">;
type Gate = Request["gates"][number];
type Row = [number, number, number];
type Result = Record<string, unknown>;
type Count = {
	id: string;
	name: string;
	parentId: string | null;
	count: number;
	parentCount: number;
	rootCount: number;
	frequencyOfParent: number | null;
	frequencyOfRoot: number | null;
};
type Job = Result & {
	jobId: string;
	kind?: string;
	state?: string;
	processedEvents?: number;
	totalEvents?: number;
	result?: { path: string; sha256: string; bytes: number; receiptPath: string };
};

const roots: string[] = [];
const services: AnalysisService[] = [];
const originals = new Map<string, Uint8Array>();

// Independent FCS 3.1 encoder: little-endian $DATATYPE F rows behind a "|" keyword section,
// written without any production encoder or gate reference so counting sees raw bytes only.
function synthetic(rows: Row[], names = ["FSC", "PE", "APC"]): Uint8Array {
	const keywords: Record<string, string> = {
		$BEGINANALYSIS: "0",
		$ENDANALYSIS: "0",
		$BEGINSTEXT: "0",
		$ENDSTEXT: "0",
		$BYTEORD: "1,2,3,4",
		$DATATYPE: "F",
		$MODE: "L",
		$NEXTDATA: "0",
		$PAR: `${names.length}`,
		$TOT: `${rows.length}`,
	};
	for (const [index, name] of names.entries()) {
		const prefix = `$P${index + 1}`;
		Object.assign(keywords, {
			[`${prefix}B`]: "32",
			[`${prefix}N`]: name,
			[`${prefix}R`]: "4096",
			[`${prefix}E`]: "0,0",
			[`${prefix}G`]: "1",
		});
	}
	const values = rows.flat();
	let begin = 0;
	let text = new Uint8Array();
	for (;;) {
		keywords.$BEGINDATA = `${begin}`;
		keywords.$ENDDATA = `${begin + values.length * 4 - 1}`;
		text = new TextEncoder().encode(`|${Object.entries(keywords).flat().join("|")}|`);
		const next = 58 + text.length;
		if (next === begin) break;
		begin = next;
	}
	const bytes = new Uint8Array(begin + values.length * 4);
	bytes.set(
		new TextEncoder().encode(
			`FCS3.1    ${[58, begin - 1, begin, bytes.length - 1, 0, 0]
				.map((value) => `${value}`.padStart(8))
				.join("")}`,
		),
	);
	bytes.set(text, 58);
	const view = new DataView(bytes.buffer);
	for (const [index, value] of values.entries()) view.setFloat32(begin + index * 4, value, true);
	return bytes;
}

// One 20-row tile repeated 17 times = 340 events. With 12-byte rows and a 1024-byte chunk
// budget the reader yields 85-event chunks whose boundaries (85/170/255) land on tile phases
// 5/10/15, where QuadA membership changes — so any chunk-edge miscount shifts the totals.
const TILE: Row[] = [
	[10, 0, 0], // inclusive rectangle boundary corner
	[11, 5, 5],
	[12, -5, 5],
	[13, 5, -5],
	[14, -5, -5],
	[15, 3, 0], // inclusive APC minimum boundary
	[16, 0, 3], // inclusive PE minimum boundary
	[17, -1, -1], // inclusive QuadB maximum boundary
	[17, 1, 1],
	[18, 6, 6],
	[19, 7, -7],
	[20, -7, 7],
	[21, 8, 8],
	[22, -7, -7],
	[23, 9, 9],
	[24, Number.NaN, 5], // dropped by every gate here: geometry excludes it and so does the parent chain
	[25, Number.POSITIVE_INFINITY, 5],
	[26, 5, Number.NEGATIVE_INFINITY], // one-dimensional PE gate ignores the APC axis
	[27, 4, 4],
	[28, 12, 12],
];
const TILES = 17;
const rows = (): Row[] => Array.from({ length: TILES }, () => TILE).flat();

function rectangle(
	id: string,
	name: string,
	parentId: string | null,
	dimensions: string[],
	min: Array<number | null>,
	max: Array<number | null>,
): Gate {
	return { id, name, parentId, dimensions, geometry: { type: "rectangle", min, max } };
}

// Dependents deliberately precede their dependencies: admission must topologically sort,
// never trust array order.
function recipe(sampleId: string, extra: Partial<Request> = {}): Request {
	const gates: Gate[] = [
		rectangle("leaf", "Leaf", "andGate", ["PE"], [6], [null]),
		{
			id: "notWithin",
			name: "NotWithin",
			parentId: "quadAPC",
			dimensions: [],
			geometry: { type: "boolean", op: "not", refs: ["quadA"] },
		},
		rectangle("emptyChild", "EmptyChild", "empty", ["PE", "APC"], [0, 0], [1, 1]),
		{
			id: "andGate",
			name: "And",
			parentId: "all",
			dimensions: [],
			geometry: { type: "boolean", op: "and", refs: ["quadA", "edge"] },
		},
		rectangle("quadB", "QuadB", "all", ["PE", "APC"], [null, -12], [-1, -1]),
		rectangle("quadA", "QuadA", "all", ["PE", "APC"], [0, 0], [null, null]),
		{
			id: "orGate",
			name: "Or",
			parentId: "all",
			dimensions: [],
			geometry: { type: "boolean", op: "or", refs: ["quadA", "quadB"] },
		},
		rectangle("edge", "Edge", null, ["PE"], [5], [5]),
		{
			id: "triangle",
			name: "Triangle",
			parentId: "quadA",
			dimensions: ["PE", "APC"],
			geometry: {
				type: "polygon",
				vertices: [
					[2, 2],
					[15, 2],
					[2, 15],
				],
			},
		},
		rectangle("all", "All", null, ["PE", "APC"], [null, null], [null, null]),
		rectangle("empty", "Empty", "all", ["PE"], [1000], [1001]),
		rectangle("quadAPC", "QuadAPC", "all", ["APC"], [0], [null]),
	];
	return { sampleId, coordinateSpace: "stored-f32", ...extra, gates };
}

// Reference population semantics mirroring the documented kernel policy: inclusive rectangle
// bounds, even-odd polygons with boundary ties outside, nonfinite geometric exclusion, and
// Boolean NOT complementing within its parent. Tile values are small integers, so real-number
// arithmetic is exact F32 here and edge margins keep polygon crossings rounding-proof.
function expectedCounts(
	source: Row[],
	startEvent: number,
	eventCount: number,
	gates: Gate[],
): Count[] {
	const selected = source.slice(startEvent, startEvent + eventCount);
	const columns: Record<string, number> = { FSC: 0, PE: 1, APC: 2 };
	const sets = new Map<string, Set<number>>();
	const bound = (value: number, edge: number | null | undefined, upper: boolean): boolean =>
		edge === null || edge === undefined || (upper ? value <= edge : value >= edge);
	// Resolve memberships in dependency rounds, mirroring the admitted topological order;
	// reported counts stay in the recipe's own (shuffled) order.
	const dependencies = (gate: Gate): string[] => [
		...(gate.parentId === null ? [] : [gate.parentId]),
		...(gate.geometry.type === "boolean" ? gate.geometry.refs : []),
	];
	const pending = gates.slice();
	while (pending.length > 0) {
		let progressed = false;
		for (let slot = pending.length - 1; slot >= 0; slot--) {
			const gate = pending[slot] as Gate;
			if (!dependencies(gate).every((id) => sets.has(id))) continue;
			pending.splice(slot, 1);
			progressed = true;
			const members = new Set<number>();
			const parent =
				gate.parentId === null
					? new Set(selected.keys())
					: (sets.get(gate.parentId) as Set<number>);
			const geometry = gate.geometry;
			if (geometry.type === "boolean") {
				selected.forEach((_, index) => {
					if (!parent.has(index)) return;
					const values = geometry.refs.map((id) => (sets.get(id) as Set<number>).has(index));
					const keep =
						geometry.op === "and"
							? values.every(Boolean)
							: geometry.op === "or"
								? values.some(Boolean)
								: !values[0];
					if (keep) members.add(index);
				});
			} else {
				const x = columns[gate.dimensions[0] as string] as number;
				const y =
					gate.dimensions[1] === undefined
						? undefined
						: (columns[gate.dimensions[1] as string] as number);
				selected.forEach((row, index) => {
					if (!parent.has(index)) return;
					const px = row[x] as number;
					const py = y === undefined ? px : (row[y] as number);
					if (!Number.isFinite(px) || !Number.isFinite(py)) return;
					if (geometry.type === "rectangle") {
						if (
							bound(px, geometry.min[0], false) &&
							bound(px, geometry.max[0], true) &&
							(y === undefined ||
								(bound(py, geometry.min[1], false) && bound(py, geometry.max[1], true)))
						)
							members.add(index);
					} else {
						let inside = false;
						const vertices = geometry.vertices;
						for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
							const [ax, ay] = vertices[i] as [number, number];
							const [bx, by] = vertices[j] as [number, number];
							if (ay > py !== by > py) {
								const crossing = ax + ((py - ay) * (bx - ax)) / (by - ay);
								if (px < crossing) inside = !inside;
							}
						}
						if (inside) members.add(index);
					}
				});
			}
			sets.set(gate.id, members);
		}
		if (!progressed) throw new Error("Reference gate graph is cyclic");
	}
	return gates.map((gate) => {
		const count = (sets.get(gate.id) as Set<number>).size;
		const parentCount =
			gate.parentId === null ? selected.length : (sets.get(gate.parentId) as Set<number>).size;
		return {
			id: gate.id,
			name: gate.name,
			parentId: gate.parentId,
			count,
			parentCount,
			rootCount: selected.length,
			frequencyOfParent: parentCount === 0 ? null : count / parentCount,
			frequencyOfRoot: selected.length === 0 ? null : count / selected.length,
		};
	});
}

async function terminal(service: AnalysisService, jobId: string): Promise<Job> {
	let job: Job = { jobId };
	await vi.waitFor(
		async () => {
			job = (await service.invoke("get_job", { jobId })) as Job;
			expect(["succeeded", "failed", "cancelled"]).toContain(job.state);
		},
		{ timeout: 20_000, interval: 5 },
	);
	return job;
}

async function countsArtifact(root: string, job: Job): Promise<{ summary: Result } & Result> {
	const output = job.result as NonNullable<Job["result"]>;
	const bytes = await readFile(join(root, output.path));
	expect(createHash("sha256").update(bytes).digest("hex")).toBe(output.sha256);
	expect(output.bytes).toBe(bytes.byteLength);
	expect(output.path).toMatch(/counts\.json$/);
	expect(output.receiptPath).toMatch(/receipt\.json$/);
	return JSON.parse(bytes.toString("utf8")) as { summary: Result } & Result;
}

async function session(name: string): Promise<{
	root: string;
	service: AnalysisService;
	sampleId: string;
}> {
	const root = await mkdtemp(join(tmpdir(), `flow-atlas-${name}-`));
	roots.push(root);
	const bytes = synthetic(rows());
	await writeFile(join(root, "sample.fcs"), bytes);
	const service = await createAnalysisService({ root, maxChunkBytes: 1024 });
	services.push(service);
	const imported = (await service.invoke("import_fcs", { path: "sample.fcs" })) as Result;
	const sampleId = imported.sampleId as string;
	originals.set(sampleId, bytes);
	// Counting must use the immutable snapshot, never this mutable source path.
	await writeFile(join(root, "sample.fcs"), "source replaced after import");
	return { root, service, sampleId };
}

async function unchangedStores(root: string, before: { runs: string[]; outputs: string[] }) {
	expect(await readdir(join(root, ".flow-atlas", "runs"))).toEqual(before.runs);
	expect(await readdir(join(root, "outputs"))).toEqual(before.outputs);
	expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
}

let root: string, service: AnalysisService, sampleId: string;
const request = (): Request => recipe(sampleId);

beforeAll(async () => {
	({ root, service, sampleId } = await session("gate-counts"));
}, 30_000);
afterAll(async () => {
	for (const opened of services.splice(0)) await opened.close();
	for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
	originals.clear();
});

describe("gate population counts through the analysis service", () => {
	it("rejects malformed gate recipes before creating any run record", async () => {
		const before = {
			runs: await readdir(join(root, ".flow-atlas", "runs")),
			outputs: await readdir(join(root, "outputs")),
		};
		const cyclic: Gate[] = [
			rectangle("a", "A", "b", ["PE"], [0], [1]),
			rectangle("b", "B", "a", ["PE"], [0], [1]),
		];
		const refCycle: Gate[] = [
			{
				id: "a",
				name: "A",
				parentId: null,
				dimensions: [],
				geometry: { type: "boolean", op: "and", refs: ["b"] },
			},
			{
				id: "b",
				name: "B",
				parentId: null,
				dimensions: [],
				geometry: { type: "boolean", op: "and", refs: ["a"] },
			},
		];
		const cases: Array<[string, unknown]> = [
			[
				"duplicate gate IDs",
				[
					{ ...rectangle("a", "A", null, ["PE"], [0], [1]) },
					rectangle("a", "A2", null, ["PE"], [2], [3]),
				],
			],
			["parent cycle", cyclic],
			["Boolean reference cycle", refCycle],
			["self parent", [rectangle("a", "A", "a", ["PE"], [0], [1])]],
			["missing parent", [rectangle("a", "A", "ghost", ["PE"], [0], [1])]],
			[
				"missing Boolean reference",
				[
					{
						id: "a",
						name: "A",
						parentId: null,
						dimensions: [],
						geometry: { type: "boolean", op: "or", refs: ["ghost"] },
					},
				],
			],
			["unknown channel", [rectangle("a", "A", null, ["CD3"], [0], [1])]],
			[
				"Boolean gate with dimensions",
				[
					{
						id: "a",
						name: "A",
						parentId: null,
						dimensions: ["PE"],
						geometry: { type: "boolean", op: "and", refs: ["a"] },
					},
				],
			],
			[
				"NOT with two references",
				[
					{
						id: "a",
						name: "A",
						parentId: null,
						dimensions: [],
						geometry: { type: "boolean", op: "not", refs: ["a", "a"] },
					},
				],
			],
			[
				"duplicate Boolean references",
				[
					rectangle("a", "A", null, ["PE"], [0], [1]),
					{
						id: "b",
						name: "B",
						parentId: null,
						dimensions: [],
						geometry: { type: "boolean", op: "and", refs: ["a", "a"] },
					},
				],
			],
			["inverted rectangle bounds", [rectangle("a", "A", null, ["PE"], [2], [1])]],
		];
		for (const [, gates] of cases) {
			await expect(
				service.invoke("start_gate_counts", { sampleId, coordinateSpace: "stored-f32", gates }),
			).rejects.toMatchObject({ code: "INVALID_GATE_RECIPE" });
		}
		await expect(
			service.invoke("start_gate_counts", {
				sampleId,
				coordinateSpace: "stored-f32",
				startEvent: 341,
				gates: [rectangle("a", "A", null, ["PE"], [0], [1])],
			}),
		).rejects.toMatchObject({ code: "INVALID_GATE_RANGE" });
		await expect(
			service.invoke("start_gate_counts", {
				sampleId,
				coordinateSpace: "stored-f32",
				eventCount: 341,
				gates: [rectangle("a", "A", null, ["PE"], [0], [1])],
			}),
		).rejects.toMatchObject({ code: "INVALID_GATE_RANGE" });
		// The strict schema refuses display transforms, processing arguments, and bound violations.
		const base = { sampleId, coordinateSpace: "stored-f32", gates: request().gates };
		for (const extra of [
			{ inputSpace: "linearized" },
			{ acquisition: { timeStep: 0.5 } },
			{ transforms: [{ channel: "PE", type: "biexponential" }] },
			{ compensationId: "unused" },
			{ coordinateSpace: "display" },
			{ gates: [] },
			{
				gates: Array.from({ length: 129 }, (_, index) =>
					rectangle(`g${index}`, `G${index}`, null, ["PE"], [0], [1]),
				),
			},
		]) {
			await expect(
				service.invoke("start_gate_counts", { ...base, ...extra }),
			).rejects.toMatchObject({
				code: "INVALID_PARAMS",
			});
		}
		await unchangedStores(root, before);
	});

	it("counts shuffled rectangle/polygon/Boolean populations with parent restriction across small chunks", async () => {
		const submitted = (await service.invoke("start_gate_counts", request())) as Job;
		const job = await terminal(service, submitted.jobId);
		expect(job).toMatchObject({
			state: "succeeded",
			kind: "gate-counts",
			progressUnit: "events",
			processedEvents: 340,
			totalEvents: 340,
			request: request(),
			inputContext: { inputSpace: "stored" },
		});
		const artifact = await countsArtifact(root, job);
		expect(artifact).toMatchObject({ schemaVersion: 1, jobId: job.jobId, sampleId });
		const summary = artifact.summary as Result;
		expect(summary).toMatchObject({
			coordinateSpace: "stored-f32",
			startEvent: 0,
			eventCount: 340,
			rootCount: 340,
		});
		expect(typeof summary.numericalPolicy).toBe("string");
		expect((summary.numericalPolicy as string).length).toBeGreaterThan(0);
		expect(summary.counts).toEqual(expectedCounts(rows(), 0, 340, request().gates));
		const byId = new Map((summary.counts as Count[]).map((count) => [count.id, count]));
		// Root denominator is the whole selected range, not the root gate's own membership.
		expect(byId.get("all")).toMatchObject({
			count: 289,
			parentCount: 340,
			frequencyOfParent: 289 / 340,
			frequencyOfRoot: 289 / 340,
		});
		expect(byId.get("quadA")).toMatchObject({
			count: 170,
			parentCount: 289,
			frequencyOfParent: 170 / 289,
		});
		expect(byId.get("triangle")).toMatchObject({
			count: 68,
			parentCount: 170,
			frequencyOfParent: 68 / 170,
			frequencyOfRoot: 68 / 340,
		});
		// NOT complements within its parent: rows excluded by the geometric ref but kept by
		// the parent re-enter, while rows the parent chain itself drops stay excluded.
		expect(byId.get("notWithin")).toMatchObject({
			count: 34,
			parentCount: 204,
			frequencyOfParent: 34 / 204,
		});
		// A one-dimensional rectangle is axis-independent and keeps exact-value boundaries.
		expect(byId.get("edge")).toMatchObject({ count: 51, parentCount: 340 });
		// Zero memberships keep numeric zero frequencies; only zero denominators become null.
		expect(byId.get("leaf")).toMatchObject({
			count: 0,
			parentCount: 17,
			frequencyOfParent: 0,
			frequencyOfRoot: 0,
		});
		expect(byId.get("empty")).toMatchObject({ count: 0, parentCount: 289, frequencyOfParent: 0 });
		expect(byId.get("emptyChild")).toMatchObject({
			count: 0,
			parentCount: 0,
			frequencyOfParent: null,
			frequencyOfRoot: 0,
		});
		const receipt = (await service.invoke("get_receipt", { jobId: job.jobId })) as Result;
		expect(receipt).toMatchObject({
			schemaVersion: 1,
			operation: "gate-counts",
			jobId: job.jobId,
			state: "succeeded",
			input: { sha256: sampleId },
			inputContext: { inputSpace: "stored" },
			recipe: request(),
			eventCount: 340,
			progressUnit: "events",
			output: job.result,
		});
		expect(receipt.recipeHash).toMatch(/^[a-f0-9]{64}$/);
		expect(receipt.recipeHash).toBe(artifact.recipeHash);
		expect(receipt.summary).toEqual(artifact.summary);
		const output = job.result as NonNullable<Job["result"]>;
		expect(JSON.parse(await readFile(join(root, output.receiptPath), "utf8"))).toEqual(receipt);
		// The imported snapshot is byte-identical after counting.
		expect(
			(await readFile(join(root, ".flow-atlas", "inputs", `${sampleId}.fcs`))).equals(
				originals.get(sampleId) as Uint8Array,
			),
		).toBe(true);
	});

	it.each([
		["straddling chunk boundary", 84, 3],
		["chunk-aligned window", 85, 85],
		["trailing partial window", 272, 68],
		["empty window", 100, 0],
	])(
		"counts an explicit %s (%s..%s) identically to the reference",
		async (_, startEvent, eventCount) => {
			const submitted = (await service.invoke("start_gate_counts", {
				...request(),
				startEvent,
				eventCount,
			})) as Job;
			const job = await terminal(service, submitted.jobId);
			expect(job.state).toBe("succeeded");
			const artifact = await countsArtifact(root, job);
			expect(artifact.summary).toEqual({
				coordinateSpace: "stored-f32",
				numericalPolicy: expect.any(String),
				startEvent,
				eventCount,
				rootCount: eventCount,
				counts: expectedCounts(rows(), startEvent, eventCount, request().gates),
			});
			if (eventCount === 0)
				expect(
					(artifact.summary as { counts: Count[] }).counts.every(
						(count) =>
							count.count === 0 &&
							count.parentCount === 0 &&
							count.frequencyOfParent === null &&
							count.frequencyOfRoot === null,
					),
				).toBe(true);
		},
	);

	it("cancels a long count and leaves no artifacts or staging directories", async () => {
		const large = synthetic(rows(Array.from({ length: 600 }, () => TILE).flat() as Row[]));
		await writeFile(join(root, "large.fcs"), large);
		const imported = (await service.invoke("import_fcs", { path: "large.fcs" })) as Result;
		const largeId = imported.sampleId as string;
		originals.set(largeId, large);
		const submitted = (await service.invoke("start_gate_counts", recipe(largeId))) as Job;
		expect(await service.invoke("cancel_job", { jobId: submitted.jobId })).toMatchObject({
			accepted: true,
		});
		const job = await terminal(service, submitted.jobId);
		expect(job.state).toBe("cancelled");
		const receipt = (await service.invoke("get_receipt", { jobId: submitted.jobId })) as Result;
		expect(receipt).toMatchObject({
			operation: "gate-counts",
			state: "cancelled",
			recipe: recipe(largeId),
		});
		expect(receipt.recipeHash).toMatch(/^[a-f0-9]{64}$/);
		expect(receipt.summary).toBeUndefined();
		expect(receipt.output).toBeUndefined();
		expect(await readdir(join(root, "outputs"))).not.toContain(submitted.jobId);
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
		// The immutable snapshot survives a cancelled count byte-for-byte.
		expect(
			(await readFile(join(root, ".flow-atlas", "inputs", `${largeId}.fcs`))).equals(large),
		).toBe(true);
	});

	it("executes through MCP and serves the identical receipt after a host restart", async () => {
		const scoped = await session("gate-mcp");
		const token = "gate-counts-mcp-token";
		const studio = await createStudioServer({ service: scoped.service, token });
		const client = new Client({ name: "gate-counts-test", version: "1" });
		let started: Result = {},
			receipt: Result = {},
			job: Job = { jobId: "" };
		try {
			await client.connect(
				new StreamableHTTPClientTransport(new URL(`${studio.url}/mcp`), {
					requestInit: { headers: { authorization: `Bearer ${token}` } },
				}),
			);
			const call = async (name: string, args: Result) => {
				const response = await client.callTool({ name, arguments: args });
				expect(response.isError).not.toBe(true);
				return JSON.parse(
					(response.content as Array<{ text: string }>)[0]?.text ?? "null",
				) as Result;
			};
			started = await call("start_gate_counts", recipe(scoped.sampleId) as unknown as Result);
			job = await terminal(scoped.service, started.jobId as string);
			expect(job.state).toBe("succeeded");
			receipt = await call("get_receipt", { jobId: started.jobId });
			expect(receipt).toMatchObject({
				operation: "gate-counts",
				state: "succeeded",
				input: { sha256: scoped.sampleId },
				recipe: recipe(scoped.sampleId),
			});
			expect(receipt.summary).toEqual((await countsArtifact(scoped.root, job)).summary);
			const rejected = await client.callTool({
				name: "start_gate_counts",
				arguments: {
					sampleId: scoped.sampleId,
					coordinateSpace: "stored-f32",
					gates: [rectangle("a", "A", "ghost", ["PE"], [0], [1])],
				},
			});
			expect(rejected.isError).toBe(true);
			expect(
				JSON.parse((rejected.content as Array<{ text: string }>)[0]?.text ?? "null"),
			).toMatchObject({
				error: { code: "INVALID_GATE_RECIPE" },
			});
		} finally {
			await client.close();
			await studio.close();
		}
		await scoped.service.close();
		// A restarted host serves the published receipt without re-running the job.
		const restored = await createAnalysisService({ root: scoped.root, maxChunkBytes: 1024 });
		services.push(restored);
		const jobId = started.jobId as string;
		expect(await restored.invoke("get_receipt", { jobId })).toEqual(receipt);
		expect(await restored.invoke("get_job", { jobId })).toMatchObject({
			state: "succeeded",
			kind: "gate-counts",
			live: false,
			phase: "complete",
			processedEvents: 340,
			totalEvents: 340,
			result: job.result,
		});
	}, 30_000);
});
