import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAnalysisService } from "../src/analysis.js";
import type { AnalysisService, OperationArgs } from "../src/contracts.js";
import { createStudioServer } from "../src/server.js";

type BatchRequest = OperationArgs<"start_batch_gate_counts">;
type Gate = BatchRequest["gates"][number];
type SampleSpec = BatchRequest["samples"][number];
type Row = [pe: number, apc: number, fsc: number];
type Pair = [count: number, parentCount: number];
type Result = Record<string, unknown>;
type Job = Result & {
	jobId: string;
	state?: string;
	processedEvents?: number;
	totalEvents?: number;
	result?: { path: string; sha256: string; bytes: number; receiptPath: string };
};

const HEX64 = /^[a-f0-9]{64}$/;
const roots: string[] = [];
const services: AnalysisService[] = [];
const originals = new Map<string, Uint8Array>();

// Independent FCS 3.1 encoder: little-endian $DATATYPE F rows behind a "|" keyword section.
// Rows are expressed in logical [PE, APC, FSC] order and written in the file's column order,
// so each sample can carry the same logical channel names in a different physical order.
function synthetic(rows: Row[], fileOrder: string[]): Uint8Array {
	const logical = ["PE", "APC", "FSC"];
	const keywords: Record<string, string> = {
		$BEGINANALYSIS: "0",
		$ENDANALYSIS: "0",
		$BEGINSTEXT: "0",
		$ENDSTEXT: "0",
		$BYTEORD: "1,2,3,4",
		$DATATYPE: "F",
		$MODE: "L",
		$NEXTDATA: "0",
		$PAR: `${fileOrder.length}`,
		$TOT: `${rows.length}`,
	};
	for (const [index, name] of fileOrder.entries()) {
		const prefix = `$P${index + 1}`;
		Object.assign(keywords, {
			[`${prefix}B`]: "32",
			[`${prefix}N`]: name,
			[`${prefix}R`]: "4096",
			[`${prefix}E`]: "0,0",
			[`${prefix}G`]: "1",
		});
	}
	const values: number[] = [];
	for (const row of rows)
		for (const name of fileOrder) values.push(row[logical.indexOf(name)] as number);
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

// Hand-enumerated 4x4 (PE, APC) grids with small exact integers; the FSC column is never
// gated and only proves name-based column mapping. The three samples use different grids so
// one shared recipe yields different counts per source.
const GRID_A: Array<[number, number]> = [
	[-5, -5],
	[-5, -1],
	[-5, 3],
	[-5, 9],
	[-1, -5],
	[-1, -1],
	[-1, 3],
	[-1, 9],
	[3, -5],
	[3, -1],
	[3, 3],
	[3, 9],
	[9, -5],
	[9, -1],
	[9, 3],
	[9, 9],
];
const GRID_B: Array<[number, number]> = [
	[-7, -4],
	[-7, -2],
	[-7, 3],
	[-7, 4],
	[-2, -4],
	[-2, -2],
	[-2, 3],
	[-2, 4],
	[3, -4],
	[3, -2],
	[3, 3],
	[3, 4],
	[4, -4],
	[4, -2],
	[4, 3],
	[4, 4],
];
const rowsA = (): Row[] => [
	...GRID_A.map(([pe, apc], i) => [pe, apc, 100 + i] as Row),
	// One nonfinite PE row: excluded by every geometric gate and by parent domains.
	[Number.NaN, 5, 116],
];
const rowsB = (): Row[] => [
	...GRID_B.map(([pe, apc], i) => [pe, apc, 200 + i] as Row),
	// Nonfinite in the other column, plus one duplicated quadA point.
	[5, Number.NaN, 216],
	[4, 4, 217],
];
const rowsC = (): Row[] => [
	// First half (rows 0..9): PE along 0..9; row 0 sits on the inclusive quadA corner.
	...Array.from({ length: 10 }, (_, i) => [i, i === 0 ? 0 : -1, 300 + i] as Row),
	// Second half (rows 10..19): quadA cluster, two polygon-boundary points, two NaN rows.
	[3, 3, 310],
	[9, 9, 311],
	[3, 9, 312],
	[9, 3, 313],
	[5, 5, 314],
	[Number.NaN, 0, 315],
	[0, Number.NaN, 316],
	[6, 6, 317],
	[7, 7, 318],
	[8, 8, 319],
];
// Uniform filler for deterministic mid-run cancellation/mutation windows: every count is
// known for any row count (all=quadA=edge=quadP=bright=andA=orAB=N; quadB=notBright=notQuadA=0).
// Distinct FSC values keep each filler's content hash unique.
const filler = (count: number, fsc: number): Row[] =>
	Array.from({ length: count }, () => [3, 3, fsc] as Row);

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
function polygonGate(
	id: string,
	name: string,
	parentId: string,
	dimensions: string[],
	vertices: Array<[number, number]>,
): Gate {
	return { id, name, parentId, dimensions, geometry: { type: "polygon", vertices } };
}
function booleanGate(
	id: string,
	name: string,
	parentId: string,
	op: "and" | "or" | "not",
	refs: string[],
): Gate {
	return { id, name, parentId, dimensions: [], geometry: { type: "boolean", op, refs } };
}

// One shared recipe for every sample, in deliberately shuffled request order: dependents
// precede their dependencies, so admission must topologically sort rather than trust order.
// Row order below follows this request order (gateIndex 0..9).
const GATES: Gate[] = [
	booleanGate("andA", "AndA", "all", "and", ["quadA", "edge"]),
	booleanGate("notBright", "NotBright", "quadA", "not", ["bright"]),
	booleanGate("orAB", "OrAB", "all", "or", ["quadA", "quadB"]),
	booleanGate("notQuadA", "NotQuadA", "all", "not", ["quadA"]),
	rectangle("edge", "Edge", null, ["PE"], [3], [3]),
	rectangle("quadP", "QuadP", "all", ["APC"], [0], [null]),
	polygonGate(
		"bright",
		"Bright",
		"quadA",
		["PE", "APC"],
		[
			[2, 2],
			[10, 2],
			[2, 10],
		],
	),
	rectangle("quadA", "QuadA", "all", ["PE", "APC"], [0, 0], [null, null]),
	rectangle("quadB", "QuadB", null, ["PE", "APC"], [null, null], [-1, -1]),
	rectangle("all", "All", null, ["PE", "APC"], [null, null], [null, null]),
];

// Hand-enumerated [count, parentCount] per gate g0..g9. Derived by listing grid memberships
// by hand against the documented policy (inclusive rectangle bounds, even-odd polygon with
// boundary ties outside, nonfinite exclusion, Boolean NOT complementing within its parent):
// A: all=16, quadA={r10,r11,r14,r15}=4, quadB={r0,r1,r4,r5}=4, quadP=8, edge(PE=3)=4,
//    bright={r10}=1, notBright=3, andA={r10,r11}=2, orAB=8, notQuadA=12; root domain 17.
// B: all=17, quadA=5 (incl. duplicate), quadB=4, quadP=9, edge=4, bright=5, notBright=0,
//    andA=2, orAB=9, notQuadA=12; root domain 18.
// C: all=18, quadA=9 (row 0 on the inclusive corner), quadB=0, quadP=9, edge=3, bright=2,
//    notBright=7, andA=2, orAB=9, notQuadA=9; root domain 20.
const A_FULL: Pair[] = [
	[2, 16],
	[3, 4],
	[8, 16],
	[12, 16],
	[4, 17],
	[8, 16],
	[1, 4],
	[4, 16],
	[4, 17],
	[16, 17],
];
const B_FULL: Pair[] = [
	[2, 17],
	[0, 5],
	[9, 17],
	[12, 17],
	[4, 18],
	[9, 17],
	[5, 5],
	[5, 17],
	[4, 18],
	[17, 18],
];
const C_FULL: Pair[] = [
	[2, 18],
	[7, 9],
	[9, 18],
	[9, 18],
	[3, 20],
	[9, 18],
	[2, 9],
	[9, 18],
	[0, 20],
	[18, 20],
];
// Windowed slices: B rows 0..15 (grid only: quadA=4, bright=4, root 16);
// C rows 10..19 (second half only: all=8, quadA=8, edge=2, bright=2, notQuadA=0, root 10).
const B_WINDOW: Pair[] = [
	[2, 16],
	[0, 4],
	[8, 16],
	[12, 16],
	[4, 16],
	[8, 16],
	[4, 4],
	[4, 16],
	[4, 16],
	[16, 16],
];
const C_WINDOW: Pair[] = [
	[2, 8],
	[6, 8],
	[8, 8],
	[0, 8],
	[2, 10],
	[8, 8],
	[2, 8],
	[8, 8],
	[0, 10],
	[8, 10],
];
const ZEROS: Pair[] = Array.from({ length: GATES.length }, () => [0, 0] as Pair);

// Format hand-enumerated pairs into the normalized row shape; frequencies follow the
// binding rule (numeric zero stays numeric, only zero denominators become null).
function expectedRows(
	tables: Array<{ pairs: Pair[]; rootCount: number }>,
): Array<Record<string, unknown>> {
	return tables.flatMap((table, sampleIndex) =>
		table.pairs.map(([count, parentCount], gateIndex) => ({
			sampleIndex,
			gateIndex,
			count,
			parentCount,
			rootCount: table.rootCount,
			frequencyOfParent: parentCount === 0 ? null : count / parentCount,
			frequencyOfRoot: table.rootCount === 0 ? null : count / table.rootCount,
		})),
	);
}

function batch(samples: SampleSpec[]): BatchRequest {
	return { coordinateSpace: "stored-f32", samples, gates: GATES };
}

function labeledBatch(ids: Record<"A" | "B" | "C", string>) {
	const request = batch([
		{ sampleId: ids.A, label: "alpha" },
		{ sampleId: ids.B, label: "beta" },
		{ sampleId: ids.C, label: "gamma" },
	]);
	const summary = {
		sampleCount: 3,
		gateCount: GATES.length,
		rowCount: 30,
		coordinateSpace: "stored-f32",
		numericalPolicy: expect.stringMatching(/.+/),
		samples: [
			{
				sampleIndex: 0,
				sampleId: ids.A,
				label: "alpha",
				startEvent: 0,
				eventCount: 17,
				rootCount: 17,
				recipeHash: expect.stringMatching(HEX64),
			},
			{
				sampleIndex: 1,
				sampleId: ids.B,
				label: "beta",
				startEvent: 0,
				eventCount: 18,
				rootCount: 18,
				recipeHash: expect.stringMatching(HEX64),
			},
			{
				sampleIndex: 2,
				sampleId: ids.C,
				label: "gamma",
				startEvent: 0,
				eventCount: 20,
				rootCount: 20,
				recipeHash: expect.stringMatching(HEX64),
			},
		],
		rows: expectedRows([
			{ pairs: A_FULL, rootCount: 17 },
			{ pairs: B_FULL, rootCount: 18 },
			{ pairs: C_FULL, rootCount: 20 },
		]),
	};
	return { request, summary };
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

async function countsArtifact(jobRoot: string, job: Job): Promise<Result> {
	const output = job.result as NonNullable<Job["result"]>;
	const bytes = await readFile(join(jobRoot, output.path));
	expect(createHash("sha256").update(bytes).digest("hex")).toBe(output.sha256);
	expect(output.bytes).toBe(bytes.byteLength);
	expect(output.path).toMatch(/counts\.json$/);
	expect(output.receiptPath).toMatch(/receipt\.json$/);
	return JSON.parse(bytes.toString("utf8")) as Result;
}

async function unchangedStores(
	jobRoot: string,
	before: { runs: string[]; outputs: string[] },
): Promise<void> {
	expect(await readdir(join(jobRoot, ".flow-atlas", "runs"))).toEqual(before.runs);
	expect(await readdir(join(jobRoot, "outputs"))).toEqual(before.outputs);
	expect(await readdir(join(jobRoot, ".flow-atlas", "tmp"))).toEqual([]);
}

type Harness = {
	root: string;
	service: AnalysisService;
	ids: Record<"A" | "B" | "C" | "D", string>;
	importFile: (name: string, bytes: Uint8Array) => Promise<string>;
};

async function harness(name: string, prefix: string): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), `flow-atlas-${name}-`));
	roots.push(root);
	const service = await createAnalysisService({ root, maxChunkBytes: 1024 });
	services.push(service);
	const importFile = async (file: string, bytes: Uint8Array): Promise<string> => {
		await writeFile(join(root, file), bytes);
		const imported = (await service.invoke("import_fcs", { path: file })) as Result;
		return imported.sampleId as string;
	};
	const files: Array<[string, Uint8Array]> = [
		[`${prefix}-a.fcs`, synthetic(rowsA(), ["PE", "APC", "FSC"])],
		[`${prefix}-b.fcs`, synthetic(rowsB(), ["FSC", "PE", "APC"])],
		[`${prefix}-c.fcs`, synthetic(rowsC(), ["APC", "FSC", "PE"])],
	];
	const ids: Record<"A" | "B" | "C" | "D", string> = { A: "", B: "", C: "", D: "" };
	for (const [index, [file, bytes]] of files.entries()) {
		const id = await importFile(file, bytes);
		originals.set(id, bytes);
		ids[["A", "B", "C"][index] as "A" | "B" | "C"] = id;
		// Counting must use the immutable snapshot, never this mutable source path.
		await writeFile(join(root, file), "source replaced after import");
	}
	return { root, service, ids, importFile };
}

let root: string, service: AnalysisService;
let ids: Record<"A" | "B" | "C" | "D", string>;
let importFile: (name: string, bytes: Uint8Array) => Promise<string>;
let mainJobId = "";
let mainReceipt: Result = {};

beforeAll(async () => {
	({ root, service, ids, importFile } = await harness("batch-counts", "batch"));
	// Huge uniform tail source: hundreds of small chunks give deterministic mid-run windows
	// for the mutation test without changing any hand-enumerated count.
	ids.D = await importFile("batch-d.fcs", synthetic(filler(60_000, 400), ["PE", "APC", "FSC"]));
	await writeFile(join(root, "batch-d.fcs"), "source replaced after import");
}, 60_000);
afterAll(async () => {
	for (const opened of services.splice(0)) await opened.close();
	for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
	originals.clear();
});

describe("batch gate population counts through the analysis service", () => {
	it("rejects invalid batch recipes atomically before any run record", async () => {
		const before = {
			runs: await readdir(join(root, ".flow-atlas", "runs")),
			outputs: await readdir(join(root, "outputs")),
		};
		// A gate channel that no source carries must fail admission, not the run.
		await expect(
			service.invoke("start_batch_gate_counts", {
				coordinateSpace: "stored-f32",
				samples: [{ sampleId: ids.A }],
				gates: [rectangle("bad", "Bad", null, ["CD3"], [0], [1])],
			}),
		).rejects.toMatchObject({ code: "INVALID_GATE_RECIPE" });
		// Sample IDs are content hashes and must be distinct within one batch.
		await expect(
			service.invoke("start_batch_gate_counts", {
				coordinateSpace: "stored-f32",
				samples: [{ sampleId: ids.A }, { sampleId: ids.A }, { sampleId: ids.B }],
				gates: GATES,
			}),
		).rejects.toMatchObject({ code: "INVALID_BATCH_RECIPE" });
		// Per-source windows must lie inside their own file.
		await expect(
			service.invoke("start_batch_gate_counts", {
				coordinateSpace: "stored-f32",
				samples: [{ sampleId: ids.A, startEvent: 18 }],
				gates: GATES,
			}),
		).rejects.toMatchObject({ code: "INVALID_GATE_RANGE" });
		// The strict schema refuses display transforms, processing arguments, and bound violations.
		const base = { coordinateSpace: "stored-f32", samples: [{ sampleId: ids.A }], gates: GATES };
		for (const extra of [
			{ inputSpace: "linearized" },
			{ acquisition: { timeStep: 0.5 } },
			{ transforms: [{ channel: "PE", type: "biexponential" }] },
			{ coordinateSpace: "display" },
			{ samples: [] },
			{ samples: Array.from({ length: 33 }, (_, i) => ({ sampleId: `s${i}` })) },
			{ gates: [] },
			{ samples: [{ sampleId: ids.A, label: "" }] },
		]) {
			await expect(
				service.invoke("start_batch_gate_counts", { ...base, ...extra }),
			).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		}
		await unchangedStores(root, before);
	});

	it("counts three reordered-channel samples through one nested/Boolean recipe", async () => {
		const { request, summary } = labeledBatch(ids);
		const submitted = (await service.invoke("start_batch_gate_counts", request)) as Job;
		const job = await terminal(service, submitted.jobId);
		expect(job).toMatchObject({
			state: "succeeded",
			kind: "batch-gate-counts",
			progressUnit: "events",
			processedEvents: 55,
			totalEvents: 55,
			request,
			inputContext: { inputSpace: "stored" },
		});
		const artifact = await countsArtifact(root, job);
		// The normalized table is the hand-enumerated expectation, byte for byte.
		expect(artifact.summary).toEqual(summary);
		mainJobId = submitted.jobId;
		mainReceipt = (await service.invoke("get_receipt", { jobId: submitted.jobId })) as Result;
		expect(mainReceipt).toMatchObject({
			schemaVersion: 1,
			operation: "batch-gate-counts",
			jobId: submitted.jobId,
			state: "succeeded",
			input: {
				samples: [
					{ sampleIndex: 0, sha256: ids.A },
					{ sampleIndex: 1, sha256: ids.B },
					{ sampleIndex: 2, sha256: ids.C },
				],
			},
			recipe: request,
			eventCount: 55,
			progressUnit: "events",
			output: job.result,
		});
		expect(mainReceipt.recipeHash).toMatch(HEX64);
		expect(mainReceipt.summary).toEqual(artifact.summary);
		// The artifact carries the batch recipe and the identical summary.
		expect(artifact).toMatchObject({
			schemaVersion: 1,
			jobId: submitted.jobId,
			recipe: request,
			recipeHash: mainReceipt.recipeHash,
		});
		expect(
			JSON.parse(
				await readFile(join(root, (job.result as NonNullable<Job["result"]>).receiptPath), "utf8"),
			),
		).toEqual(mainReceipt);
		// Every source snapshot is byte-identical after counting.
		for (const id of [ids.A, ids.B, ids.C])
			expect(
				(await readFile(join(root, ".flow-atlas", "inputs", `${id}.fcs`))).equals(
					originals.get(id) as Uint8Array,
				),
			).toBe(true);
	});

	it("applies per-source windows and null frequencies for an empty sample window", async () => {
		const windowRequest = batch([
			{ sampleId: ids.A },
			{ sampleId: ids.B, startEvent: 0, eventCount: 16 },
			{ sampleId: ids.C, startEvent: 10, eventCount: 10 },
		]);
		const windowJob = await terminal(
			service,
			((await service.invoke("start_batch_gate_counts", windowRequest)) as Job).jobId,
		);
		expect(windowJob).toMatchObject({ state: "succeeded", totalEvents: 43, processedEvents: 43 });
		expect((await countsArtifact(root, windowJob)).summary).toEqual({
			sampleCount: 3,
			gateCount: GATES.length,
			rowCount: 30,
			coordinateSpace: "stored-f32",
			numericalPolicy: expect.stringMatching(/.+/),
			samples: [
				{
					sampleIndex: 0,
					sampleId: ids.A,
					startEvent: 0,
					eventCount: 17,
					rootCount: 17,
					recipeHash: expect.stringMatching(HEX64),
				},
				{
					sampleIndex: 1,
					sampleId: ids.B,
					startEvent: 0,
					eventCount: 16,
					rootCount: 16,
					recipeHash: expect.stringMatching(HEX64),
				},
				{
					sampleIndex: 2,
					sampleId: ids.C,
					startEvent: 10,
					eventCount: 10,
					rootCount: 10,
					recipeHash: expect.stringMatching(HEX64),
				},
			],
			rows: expectedRows([
				{ pairs: A_FULL, rootCount: 17 },
				{ pairs: B_WINDOW, rootCount: 16 },
				{ pairs: C_WINDOW, rootCount: 10 },
			]),
		});
		// An empty per-source window keeps its rows with zero counts and null frequencies,
		// while the other sources count normally in the same job.
		const emptyRequest = batch([
			{ sampleId: ids.A },
			{ sampleId: ids.B, eventCount: 0 },
			{ sampleId: ids.C },
		]);
		const emptyJob = await terminal(
			service,
			((await service.invoke("start_batch_gate_counts", emptyRequest)) as Job).jobId,
		);
		expect(emptyJob).toMatchObject({ state: "succeeded", totalEvents: 37, processedEvents: 37 });
		const emptyArtifact = await countsArtifact(root, emptyJob);
		expect(emptyArtifact.summary).toEqual({
			sampleCount: 3,
			gateCount: GATES.length,
			rowCount: 30,
			coordinateSpace: "stored-f32",
			numericalPolicy: expect.stringMatching(/.+/),
			samples: [
				{
					sampleIndex: 0,
					sampleId: ids.A,
					startEvent: 0,
					eventCount: 17,
					rootCount: 17,
					recipeHash: expect.stringMatching(HEX64),
				},
				{
					sampleIndex: 1,
					sampleId: ids.B,
					startEvent: 0,
					eventCount: 0,
					rootCount: 0,
					recipeHash: expect.stringMatching(HEX64),
				},
				{
					sampleIndex: 2,
					sampleId: ids.C,
					startEvent: 0,
					eventCount: 20,
					rootCount: 20,
					recipeHash: expect.stringMatching(HEX64),
				},
			],
			rows: expectedRows([
				{ pairs: A_FULL, rootCount: 17 },
				{ pairs: ZEROS, rootCount: 0 },
				{ pairs: C_FULL, rootCount: 20 },
			]),
		});
	});

	it("fails without publishing partial artifacts when a later input is mutated mid-run", async () => {
		const request = batch([{ sampleId: ids.A }, { sampleId: ids.B }, { sampleId: ids.D }]);
		const submitted = (await service.invoke("start_batch_gate_counts", request)) as Job;
		// processedEvents > 35 proves A and B completed and the last source is past its
		// integrity verification, so the mutation below lands mid-stream deterministically.
		await vi.waitFor(
			async () => {
				const job = (await service.invoke("get_job", { jobId: submitted.jobId })) as Job;
				expect(job.processedEvents ?? 0).toBeGreaterThanOrEqual(120);
			},
			{ timeout: 10_000, interval: 10 },
		);
		const running = (await service.invoke("get_job", { jobId: submitted.jobId })) as Job;
		expect(["running", "queued"]).toContain(running.state);
		expect(await readdir(join(root, "outputs"))).not.toContain(submitted.jobId);
		const snapshot = join(root, ".flow-atlas", "inputs", `${ids.D}.fcs`);
		await chmod(snapshot, 0o600);
		const bytes = await readFile(snapshot);
		bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff;
		await writeFile(snapshot, bytes);
		const job = await terminal(service, submitted.jobId);
		expect(job).toMatchObject({ state: "failed", result: undefined });
		const receipt = (await service.invoke("get_receipt", { jobId: submitted.jobId })) as Result;
		expect(receipt).toMatchObject({
			state: "failed",
			recipe: request,
			error: {
				code: "INPUT_CHANGED",
				details: { sampleIndex: 2, completedSamples: 2, phase: "run" },
			},
		});
		expect(receipt.recipeHash).toMatch(HEX64);
		expect(receipt.summary).toBeUndefined();
		expect(receipt.output).toBeUndefined();
		// The two completed sources publish nothing: batch output is all-or-nothing.
		expect(await readdir(join(root, "outputs"))).not.toContain(submitted.jobId);
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
	}, 30_000);

	it("cancels a long batch mid-stream and leaves no artifacts", async () => {
		// A fresh huge source keeps this test independent of the mutation test above.
		const idE = await importFile(
			"batch-e.fcs",
			synthetic(filler(60_000, 401), ["PE", "APC", "FSC"]),
		);
		await writeFile(join(root, "batch-e.fcs"), "source replaced after import");
		const request = batch([{ sampleId: ids.A }, { sampleId: ids.B }, { sampleId: idE }]);
		const submitted = (await service.invoke("start_batch_gate_counts", request)) as Job;
		await vi.waitFor(
			async () => {
				const job = (await service.invoke("get_job", { jobId: submitted.jobId })) as Job;
				expect(job.processedEvents ?? 0).toBeGreaterThanOrEqual(120);
			},
			{ timeout: 10_000, interval: 10 },
		);
		expect(await service.invoke("cancel_job", { jobId: submitted.jobId })).toMatchObject({
			accepted: true,
		});
		const job = await terminal(service, submitted.jobId);
		expect(job.state).toBe("cancelled");
		const receipt = (await service.invoke("get_receipt", { jobId: submitted.jobId })) as Result;
		expect(receipt).toMatchObject({
			state: "cancelled",
			recipe: request,
			recipeHash: expect.stringMatching(HEX64),
		});
		expect((receipt.processedEvents as number) ?? 0).toBeGreaterThanOrEqual(120);
		expect(receipt.summary).toBeUndefined();
		expect(receipt.output).toBeUndefined();
		expect(await readdir(join(root, "outputs"))).not.toContain(submitted.jobId);
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
	}, 30_000);

	it("enforces the 512 sample/gate row cap on real distinct sources", async () => {
		// 31 tiny but fully valid distinct sources x 17 valid gates = 527 rows.
		const samples: string[] = [];
		for (let i = 0; i < 31; i++)
			samples.push(
				await importFile(`boundary-${i}.fcs`, synthetic([[3, 3, i]], ["PE", "APC", "FSC"])),
			);
		const gates: Gate[] = [
			...GATES,
			...Array.from({ length: 7 }, (_, i) =>
				rectangle(`filler${i}`, `F${i}`, null, ["PE"], [i], [i]),
			),
		];
		expect(samples.length * gates.length).toBe(527);
		const before = {
			runs: await readdir(join(root, ".flow-atlas", "runs")),
			outputs: await readdir(join(root, "outputs")),
		};
		await expect(
			service.invoke("start_batch_gate_counts", {
				coordinateSpace: "stored-f32",
				samples: samples.map((sampleId) => ({ sampleId })),
				gates,
			}),
		).rejects.toMatchObject({ code: "BATCH_ROW_LIMIT" });
		await unchangedStores(root, before);
		// Dropping one source stays within the cap (510 rows) and the job succeeds.
		const under = {
			coordinateSpace: "stored-f32" as const,
			samples: samples.slice(0, 30).map((sampleId) => ({ sampleId })),
			gates,
		};
		const submitted = (await service.invoke("start_batch_gate_counts", under)) as Job;
		const job = await terminal(service, submitted.jobId);
		expect(job.state).toBe("succeeded");
		const artifact = await countsArtifact(root, job);
		expect(artifact.summary).toMatchObject({ sampleCount: 30, gateCount: 17, rowCount: 510 });
		// Spot-check one hand-known row: sample 0, gate 0 (andA) covers the single (3,3) event.
		expect((artifact.summary as { rows: Result[] }).rows[0]).toEqual({
			sampleIndex: 0,
			gateIndex: 0,
			count: 1,
			parentCount: 1,
			rootCount: 1,
			frequencyOfParent: 1,
			frequencyOfRoot: 1,
		});
	}, 60_000);

	it("executes through MCP and serves the identical receipt after a host restart", async () => {
		const scoped = await harness("batch-mcp", "batch-mcp");
		const token = "batch-counts-mcp-token";
		const studio = await createStudioServer({ service: scoped.service, token });
		const client = new Client({ name: "batch-counts-test", version: "1" });
		let started: Result = {};
		let receipt: Result = {};
		let job: Job = { jobId: "" };
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
			const { request, summary } = labeledBatch(scoped.ids);
			started = await call("start_batch_gate_counts", request as unknown as Result);
			job = await terminal(scoped.service, started.jobId as string);
			expect(job.state).toBe("succeeded");
			receipt = await call("get_receipt", { jobId: started.jobId });
			expect(receipt).toMatchObject({
				operation: "batch-gate-counts",
				state: "succeeded",
				recipe: request,
			});
			expect(receipt.summary).toEqual((await countsArtifact(scoped.root, job)).summary);
			expect(receipt.summary).toEqual(summary);
			const rejected = await client.callTool({
				name: "start_batch_gate_counts",
				arguments: {
					coordinateSpace: "stored-f32",
					samples: [{ sampleId: scoped.ids.A }, { sampleId: scoped.ids.A }],
					gates: GATES,
				},
			});
			expect(rejected.isError).toBe(true);
			expect(
				JSON.parse((rejected.content as Array<{ text: string }>)[0]?.text ?? "null"),
			).toMatchObject({ error: { code: "INVALID_BATCH_RECIPE" } });
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
			kind: "batch-gate-counts",
			live: false,
			phase: "complete",
			processedEvents: 55,
			totalEvents: 55,
			result: job.result,
		});
	}, 30_000);

	it("serves the durable main batch receipt after the host restarts", async () => {
		await service.close();
		const restored = await createAnalysisService({ root, maxChunkBytes: 1024 });
		services.push(restored);
		expect(await restored.invoke("get_receipt", { jobId: mainJobId })).toEqual(mainReceipt);
		expect(await restored.invoke("get_job", { jobId: mainJobId })).toMatchObject({
			state: "succeeded",
			kind: "batch-gate-counts",
			live: false,
			phase: "complete",
		});
	});
});
