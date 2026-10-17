import { createHash } from "node:crypto";
import { mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FcsFile, readHeader, writeFcs } from "@flow-atlas/fcs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAnalysisService } from "../src/analysis.js";
import { writeAll } from "../src/artifact-store.js";
import type { AnalysisService, OperationArgs } from "../src/contracts.js";
import { createStudioServer } from "../src/server.js";

type Request = OperationArgs<"start_population_medians">;
type Gate = Request["gates"][number];
type Row = [pe: number, apc: number, fsc: number];
type Result = Record<string, unknown>;
type Job = Result & {
	jobId: string;
	state?: string;
	processedEvents?: number;
	totalEvents?: number;
	result?: { path: string; sha256: string; bytes: number; receiptPath: string };
};

const HEX64 = /^[a-f0-9]{64}$/;
const POLICY = expect.stringMatching(/.+/);
const roots: string[] = [];
const services: AnalysisService[] = [];
const originals = new Map<string, Uint8Array>();

// Independent FCS 3.1 encoder: little-endian $DATATYPE F rows behind a "|" keyword section.
// Rows are expressed in logical [PE, APC, FSC] order and written in the file's column order,
// so each fixture can carry the same logical channel names in a different physical order.
// Every fixture passes through this encoder before writeFile (prior-milestone lesson).
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

// Hand-enumerated 8-row tile over (PE, APC); FSC is never gated on S1 and only proves
// name-based column mapping. Memberships follow the shared count policy: inclusive rectangle
// bounds, even-odd polygon with boundary ties outside, nonfinite geometric exclusion, and
// Boolean NOT complementing within its parent.
//   r0 (3,3): quadA+posPE+edgePE3+andGate+bright(poly)  r1 (-1,-1): quadB+notQuadA
//   r2 (0,0): quadA boundary                            r3 (5,2): quadA+posPE+bright
//   r4 (2,8): quadA+posPE, polygon hypotenuse x+y=10 -> outside
//   r5 (-2,4): notQuadA                                 r6 (3,-1): edgePE3+notQuadA
//   r7 (10,10): quadA+posPE
const TILE: Row[] = [
	[3, 3, 100],
	[-1, -1, 101],
	[0, 0, 102],
	[5, 2, 103],
	[2, 8, 104],
	[-2, 4, 105],
	[3, -1, 106],
	[10, 10, 107],
];
const rowsS1 = (): Row[] => Array.from({ length: 12 }, () => TILE).flat(); // 96 rows

// S2 adds two nonfinite rows: r2 carries NaN FSC while remaining inside quadA (its PE/APC
// targets stay finite), and r8 carries NaN PE so every geometric gate excludes it while
// NOT within the finite-PE/APC "all" parent cannot re-include it.
const rowsS2 = (): Row[] => [
	[3, 3, 1],
	[-1, -1, 2],
	[0, 0, Number.NaN],
	[5, 2, 3],
	[2, 8, 4],
	[-2, 4, 5],
	[3, -1, 6],
	[10, 10, 7],
	[Number.NaN, 5, 9],
];

// S3 exercises bit-exact target endpoints: -1, -0 (canonical positive zero), the two
// smallest positive subnormals, and 5.
const rowsS3 = (): Row[] => [
	[-1, 0, 0],
	[-0, 0, 0],
	[2 ** -149, 0, 0],
	[2 ** -148, 0, 0],
	[5, 0, 0],
];

// Uniform filler for a deterministic mid-run cancellation window: every row sits in quadA
// with PE=APC=3, so any prefix count is known without enumeration.
const rowsFiller = (count: number): Row[] =>
	Array.from({ length: count }, () => [3, 3, 400] as Row);

// Shared recipe in deliberately shuffled request order: dependents precede their
// dependencies, so admission must topologically sort rather than trust array order.
const GATES: Gate[] = [
	{
		id: "andGate",
		name: "AndGate",
		parentId: "all",
		dimensions: [],
		geometry: { type: "boolean", op: "and", refs: ["quadA", "edgePE3"] },
	},
	{
		id: "notQuadA",
		name: "NotQuadA",
		parentId: "all",
		dimensions: [],
		geometry: { type: "boolean", op: "not", refs: ["quadA"] },
	},
	{
		id: "orGate",
		name: "OrGate",
		parentId: "all",
		dimensions: [],
		geometry: { type: "boolean", op: "or", refs: ["quadA", "quadB"] },
	},
	{
		id: "bright",
		name: "Bright",
		parentId: "quadA",
		dimensions: ["PE", "APC"],
		geometry: {
			type: "polygon",
			vertices: [
				[1, 1],
				[9, 1],
				[1, 9],
			],
		},
	},
	rectangle("posPE", "PosPE", "quadA", ["PE"], [1], [null]),
	rectangle("edgePE3", "EdgePE3", null, ["PE"], [3], [3]),
	rectangle("quadA", "QuadA", "all", ["PE", "APC"], [0, 0], [null, null]),
	rectangle("quadB", "QuadB", null, ["PE", "APC"], [null, null], [-1, -1]),
	rectangle("all", "All", null, ["PE", "APC"], [null, null], [null, null]),
	rectangle("noneGate", "NoneGate", "all", ["PE"], [1000], [1001]),
];

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

// Exact diagnostics of the existing four-pass GPU median summary (compute/src/median.ts),
// with sourceRows counting the selected source window once; eventVisits counts all four passes.
function medianSummary(options: {
	populationId: string | null;
	channels: string[];
	count: number;
	lower: number[];
	upper: number[];
	sourceRows: number;
	gatePolicy: string | null;
}) {
	const { populationId, channels, count, lower, upper, sourceRows, gatePolicy } = options;
	return {
		populationId,
		coordinateSpace: "stored-f32",
		channels,
		count,
		lower,
		upper,
		// Hand-derived rank endpoints, not implementation mirroring: lower is the
		// floor((count-1)/2)-th and upper the floor(count/2)-th smallest member, 0-based.
		ranks: { indexBase: 0, lower: Math.floor((count - 1) / 2), upper: Math.floor(count / 2) },
		diagnostics: {
			algorithm: "gpu-radix256-exact-rank-v1",
			passCount: 4,
			precision: "exact-f32-rank-endpoints",
			scope: "selected-population-not-vendor-parity",
			zeroPolicy: "canonical-positive-zero",
			subnormalPolicy: "preserve-integer-bit-order",
			sourceRows,
		},
		gateNumericalPolicy: gatePolicy,
	};
}

function mediansJob(
	sampleId: string,
	populationId: string | null,
	channels: string[],
	window: { startEvent?: number; eventCount?: number } = {},
): Request {
	return {
		sampleId,
		coordinateSpace: "stored-f32",
		populationId,
		gates: populationId === null ? [] : GATES,
		channels,
		...window,
	};
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

async function mediansArtifact(jobRoot: string, job: Job): Promise<Result> {
	const output = job.result as NonNullable<Job["result"]>;
	const bytes = await readFile(join(jobRoot, output.path));
	expect(createHash("sha256").update(bytes).digest("hex")).toBe(output.sha256);
	expect(output.bytes).toBe(bytes.byteLength);
	expect(output.path).toMatch(/medians\.json$/);
	expect(output.receiptPath).toMatch(/receipt\.json$/);
	return JSON.parse(bytes.toString("utf8")) as Result;
}

type Harness = {
	root: string;
	service: AnalysisService;
	ids: Record<"S1" | "S2" | "S3" | "S4" | "F", string>;
};

async function harness(name: string): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), `flow-atlas-${name}-`));
	roots.push(root);
	const service = await createAnalysisService({ root, maxChunkBytes: 1024 });
	services.push(service);
	// Real importer path with a defensive fixture gate: the encoded bytes must parse as an
	// FCS 3.1 header before any import is attempted (prior-milestone lesson).
	const importSample = async (file: string, bytes: Uint8Array): Promise<string> => {
		const header = readHeader(
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		);
		expect(header.version).toBe("FCS3.1");
		await writeFile(join(root, file), bytes);
		const imported = (await service.invoke("import_fcs", { path: file })) as Result;
		const sampleId = imported.sampleId as string;
		originals.set(sampleId, bytes);
		// Medians must use the immutable snapshot, never this mutable source path.
		await writeFile(join(root, file), "source replaced after import");
		return sampleId;
	};
	const ids: Record<"S1" | "S2" | "S3" | "S4" | "F", string> = {
		S1: "",
		S2: "",
		S3: "",
		S4: "",
		F: "",
	};
	ids.S1 = await importSample("medians-s1.fcs", synthetic(rowsS1(), ["FSC", "APC", "PE"]));
	ids.S2 = await importSample("medians-s2.fcs", synthetic(rowsS2(), ["APC", "PE", "FSC"]));
	ids.S3 = await importSample("medians-s3.fcs", synthetic(rowsS3(), ["PE", "APC", "FSC"]));
	// Zero-event fixture through the production encoder (no rows to encode independently).
	const empty = {
		version: "FCS3.1",
		eventCount: 0,
		keywords: {},
		channels: [
			{
				index: 1,
				name: "PE",
				bits: 32,
				range: 100,
				gain: 1,
				amplification: [0, 0] as [number, number],
			},
		],
	} satisfies Omit<FcsFile, "data">;
	const handle = await open(join(root, "medians-s4.fcs"), "w");
	try {
		for await (const bytes of writeFcs(empty, [new Float32Array()], { chunkBytes: 512 }))
			await writeAll(handle, bytes);
	} finally {
		await handle.close();
	}
	const emptyBytes = await readFile(join(root, "medians-s4.fcs"));
	expect(readHeader(emptyBytes.buffer.slice(0, emptyBytes.byteLength)).version).toBe("FCS3.1");
	const imported = (await service.invoke("import_fcs", { path: "medians-s4.fcs" })) as Result;
	ids.S4 = imported.sampleId as string;
	ids.F = await importSample(
		"medians-filler.fcs",
		synthetic(rowsFiller(30_000), ["PE", "APC", "FSC"]),
	);
	await writeFile(join(root, "medians-filler.fcs"), "source replaced after import");
	return { root, service, ids };
}

let root: string, service: AnalysisService;
let ids: Record<"S1" | "S2" | "S3" | "S4" | "F", string>;
let mainJobId = "";
let mainReceipt: Result = {};

beforeAll(async () => {
	({ root, service, ids } = await harness("population-medians"));
}, 60_000);
afterAll(async () => {
	for (const opened of services.splice(0)) await opened.close();
	for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
	originals.clear();
});

async function unchangedStores(before: { runs: string[]; outputs: string[] }): Promise<void> {
	expect(await readdir(join(root, ".flow-atlas", "runs"))).toEqual(before.runs);
	expect(await readdir(join(root, "outputs"))).toEqual(before.outputs);
	expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
}

describe("gated population medians through the analysis service", () => {
	it("rejects invalid population recipes atomically before any run record", async () => {
		const before = {
			runs: await readdir(join(root, ".flow-atlas", "runs")),
			outputs: await readdir(join(root, "outputs")),
		};
		// A non-null populationId must name one of the recipe's gates.
		await expect(
			service.invoke("start_population_medians", mediansJob(ids.S1, "ghost", ["PE"])),
		).rejects.toMatchObject({ code: "INVALID_POPULATION_RECIPE" });
		// The root population (null) requires the empty gate recipe.
		await expect(
			service.invoke("start_population_medians", {
				sampleId: ids.S1,
				coordinateSpace: "stored-f32",
				populationId: null,
				gates: GATES,
				channels: ["PE"],
			}),
		).rejects.toMatchObject({ code: "INVALID_POPULATION_RECIPE" });
		// Gate-channel and target-channel validation.
		await expect(
			service.invoke("start_population_medians", {
				sampleId: ids.S1,
				coordinateSpace: "stored-f32",
				populationId: "bad",
				gates: [rectangle("bad", "Bad", null, ["CD3"], [0], [1])],
				channels: ["PE"],
			}),
		).rejects.toMatchObject({ code: "INVALID_GATE_RECIPE" });
		await expect(
			service.invoke("start_population_medians", mediansJob(ids.S1, "quadA", ["CD3"])),
		).rejects.toMatchObject({ code: "INVALID_POPULATION_CHANNEL" });
		await expect(
			service.invoke("start_population_medians", mediansJob(ids.S1, "quadA", ["PE", "PE"])),
		).rejects.toMatchObject({ code: "INVALID_POPULATION_CHANNEL" });
		// The strict schema refuses display transforms, processing arguments, and bound violations.
		const base = mediansJob(ids.S1, "quadA", ["PE"]);
		for (const extra of [
			{ inputSpace: "linearized" },
			{ acquisition: { timeStep: 0.5 } },
			{ transforms: [{ channel: "PE", type: "biexponential" }] },
			{ coordinateSpace: "display" },
			{ channels: [] },
			{ channels: Array.from({ length: 33 }, (_, i) => `C${i}`) },
			{
				gates: Array.from({ length: 129 }, (_, i) =>
					rectangle(`g${i}`, `G${i}`, null, ["PE"], [i], [i]),
				),
			},
		]) {
			await expect(
				service.invoke("start_population_medians", { ...base, ...extra }),
			).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		}
		await unchangedStores(before);
	});

	it("computes root rank endpoints over all rows with full provenance", async () => {
		const request = mediansJob(ids.S1, null, ["PE", "APC"]);
		const submitted = (await service.invoke("start_population_medians", request)) as Job;
		const job = await terminal(service, submitted.jobId);
		// Four passes over 96 window rows: 384 event visits, no gate pass counted.
		expect(job).toMatchObject({
			state: "succeeded",
			kind: "population-medians", // kind string assumed pending implementation read
			progressUnit: "event-visits",
			processedEvents: 384,
			totalEvents: 384,
			request,
			inputContext: { inputSpace: "stored" },
		});
		// Hand enumeration: PE rows sorted give 12x[-2,-1,0,2] then 24x3, 12x5, 12x10, so
		// ranks 47/48 fall on 2/3; APC gives 24x-1, 12x[0,2,3,4,8,10] with 47/48 on 2/3.
		const expected = medianSummary({
			populationId: null,
			channels: ["PE", "APC"],
			count: 96,
			lower: [2, 2],
			upper: [3, 3],
			sourceRows: 96,
			gatePolicy: null,
		});
		const artifact = await mediansArtifact(root, job);
		expect(artifact.summary).toEqual(expected);
		expect(artifact.recipe).toEqual(request);
		const receipt = (await service.invoke("get_receipt", { jobId: job.jobId })) as Result;
		expect(receipt).toMatchObject({
			schemaVersion: 1,
			operation: "population-medians",
			jobId: job.jobId,
			state: "succeeded",
			input: { sha256: ids.S1 },
			inputContext: { inputSpace: "stored" },
			recipe: request,
			eventVisits: 384,
			progressUnit: "event-visits",
			output: job.result,
		});
		expect(receipt.recipeHash).toMatch(HEX64);
		expect(receipt.summary).toEqual(artifact.summary);
		expect(
			JSON.parse(
				await readFile(join(root, (job.result as NonNullable<Job["result"]>).receiptPath), "utf8"),
			),
		).toEqual(receipt);
		// The imported snapshot is byte-identical after counting.
		expect(
			(await readFile(join(root, ".flow-atlas", "inputs", `${ids.S1}.fcs`))).equals(
				originals.get(ids.S1) as Uint8Array,
			),
		).toBe(true);
		mainJobId = submitted.jobId;
		mainReceipt = receipt;
	});

	it("medians gated populations through shuffled nested and Boolean recipes", async () => {
		const jobs = await Promise.all(
			(
				[
					// Plain nested rectangle: 60 members, ranks 29/30 on 3/3 for both targets.
					[
						mediansJob(ids.S1, "quadA", ["PE", "APC"]),
						medianSummary({
							populationId: "quadA",
							channels: ["PE", "APC"],
							count: 60,
							lower: [3, 3],
							upper: [3, 3],
							sourceRows: 96,
							gatePolicy: POLICY,
						}),
					],
					// Polygon child of a gated parent: 24 members; boundary row (2,8) excluded.
					[
						mediansJob(ids.S1, "bright", ["PE", "APC"]),
						medianSummary({
							populationId: "bright",
							channels: ["PE", "APC"],
							count: 24,
							lower: [3, 2],
							upper: [5, 3],
							sourceRows: 96,
							gatePolicy: POLICY,
						}),
					],
					// NOT within all selects r1/r5/r6 per tile: PE has 12 each of -2/-1/3,
					// APC has 24x-1 and 12x4. Both ranks 17/18 are -1 on both channels.
					[
						mediansJob(ids.S1, "notQuadA", ["PE", "APC"]),
						medianSummary({
							populationId: "notQuadA",
							channels: ["PE", "APC"],
							count: 36,
							lower: [-1, -1],
							upper: [-1, -1],
							sourceRows: 96,
							gatePolicy: POLICY,
						}),
					],
					// Boolean AND of two geometric gates under all: single member r0.
					[
						mediansJob(ids.S1, "andGate", ["PE"]),
						medianSummary({
							populationId: "andGate",
							channels: ["PE"],
							count: 12,
							lower: [3],
							upper: [3],
							sourceRows: 96,
							gatePolicy: POLICY,
						}),
					],
				] as Array<[Request, Result]>
			).map(async ([request, expected]) => {
				const submitted = (await service.invoke("start_population_medians", request)) as Job;
				const job = await terminal(service, submitted.jobId);
				expect(job.state).toBe("succeeded");
				const artifact = await mediansArtifact(root, job);
				expect(artifact.summary).toEqual(expected);
				return artifact;
			}),
		);
		expect(jobs).toHaveLength(4);
	});

	it("returns lower/upper endpoints in requested target order", async () => {
		// edgePE3 (24 members): PE ranks 11/12 both land on 3 while APC ranks split -1/3;
		// requesting ["APC","PE"] must mirror the arrays per channel, not sort them.
		const edgeRequest = mediansJob(ids.S1, "edgePE3", ["APC", "PE"]);
		const edgeJob = await terminal(
			service,
			((await service.invoke("start_population_medians", edgeRequest)) as Job).jobId,
		);
		expect(edgeJob.state).toBe("succeeded");
		expect((await mediansArtifact(root, edgeJob)).summary).toEqual(
			medianSummary({
				populationId: "edgePE3",
				channels: ["APC", "PE"],
				count: 24,
				lower: [-1, 3],
				upper: [3, 3],
				sourceRows: 96,
				gatePolicy: POLICY,
			}),
		);
		// posPE (48 members): PE ranks 23/24 land on 3/5 while APC lands on 3/8; the reversed
		// request must swap the upper endpoints, proving order-following rather than sorting.
		const posRequest = mediansJob(ids.S1, "posPE", ["APC", "PE"]);
		const posJob = await terminal(
			service,
			((await service.invoke("start_population_medians", posRequest)) as Job).jobId,
		);
		expect(posJob.state).toBe("succeeded");
		expect((await mediansArtifact(root, posJob)).summary).toEqual(
			medianSummary({
				populationId: "posPE",
				channels: ["APC", "PE"],
				count: 48,
				lower: [3, 3],
				upper: [8, 5],
				sourceRows: 96,
				gatePolicy: POLICY,
			}),
		);
	});

	it("crosses chunk boundaries on a windowed source with odd and even populations", async () => {
		// 88-row window exceeds any 1024-byte chunk (<=85 rows at 12-byte stride), so the
		// four passes stream at least two chunks; totals stay 4x88 = 352 event visits.
		const window = { startEvent: 0, eventCount: 88 };
		const oddRequest = mediansJob(ids.S1, "quadA", ["PE", "APC"], window);
		const oddJob = await terminal(
			service,
			((await service.invoke("start_population_medians", oddRequest)) as Job).jobId,
		);
		expect(oddJob).toMatchObject({
			state: "succeeded",
			processedEvents: 352,
			totalEvents: 352,
			progressUnit: "event-visits",
		});
		// 11 tiles: quadA has 55 members (odd) with ranks 27/27 landing on 3/3.
		expect((await mediansArtifact(root, oddJob)).summary).toEqual(
			medianSummary({
				populationId: "quadA",
				channels: ["PE", "APC"],
				count: 55,
				lower: [3, 3],
				upper: [3, 3],
				sourceRows: 88,
				gatePolicy: POLICY,
			}),
		);
		const evenRequest = mediansJob(ids.S1, "edgePE3", ["APC", "PE"], window);
		const evenJob = await terminal(
			service,
			((await service.invoke("start_population_medians", evenRequest)) as Job).jobId,
		);
		expect(evenJob.state).toBe("succeeded");
		// 22 members (even): APC ranks 10/11 land on -1/3, PE on 3/3.
		expect((await mediansArtifact(root, evenJob)).summary).toEqual(
			medianSummary({
				populationId: "edgePE3",
				channels: ["APC", "PE"],
				count: 22,
				lower: [-1, 3],
				upper: [3, 3],
				sourceRows: 88,
				gatePolicy: POLICY,
			}),
		);
	});

	it("excludes nonfinite rows through gates but rejects selected nonfinite targets", async () => {
		// quadA includes the NaN-FSC row r2, but PE/APC targets are finite: success.
		// It excludes the NaN-PE row r8, so its PE target stays finite too.
		const excludedRequest = mediansJob(ids.S2, "quadA", ["PE"]);
		const excludedJob = await terminal(
			service,
			((await service.invoke("start_population_medians", excludedRequest)) as Job).jobId,
		);
		expect(excludedJob.state).toBe("succeeded");
		expect((await mediansArtifact(root, excludedJob)).summary).toEqual(
			medianSummary({
				populationId: "quadA",
				channels: ["PE"],
				count: 5,
				lower: [3],
				upper: [3],
				sourceRows: 9,
				gatePolicy: POLICY,
			}),
		);
		// NOT cannot re-include r8, which is outside its finite-PE/APC "all" parent.
		// Members r1/r5/r6 have APC values -1/4/-1: count 3, both rank-1 endpoints -1.
		const notRequest = mediansJob(ids.S2, "notQuadA", ["APC"]);
		const notJob = await terminal(
			service,
			((await service.invoke("start_population_medians", notRequest)) as Job).jobId,
		);
		expect(notJob.state).toBe("succeeded");
		expect((await mediansArtifact(root, notJob)).summary).toEqual(
			medianSummary({
				populationId: "notQuadA",
				channels: ["APC"],
				count: 3,
				lower: [-1],
				upper: [-1],
				sourceRows: 9,
				gatePolicy: POLICY,
			}),
		);
		// Selecting the nonfinite column of a population that contains it must fail typed.
		const includedRequest = mediansJob(ids.S2, "quadA", ["FSC"]);
		const includedJob = await terminal(
			service,
			((await service.invoke("start_population_medians", includedRequest)) as Job).jobId,
		);
		expect(includedJob).toMatchObject({ state: "failed", result: undefined });
		const includedReceipt = (await service.invoke("get_receipt", {
			jobId: includedJob.jobId,
		})) as Result;
		expect(includedReceipt).toMatchObject({
			state: "failed",
			recipe: includedRequest,
			error: { code: "NONFINITE_POPULATION_TARGET" },
		});
		expect(includedReceipt.summary).toBeUndefined();
		// The root population includes every row, so the NaN-FSC row fails the FSC target...
		const rootFailRequest = mediansJob(ids.S2, null, ["FSC"]);
		const rootFailJob = await terminal(
			service,
			((await service.invoke("start_population_medians", rootFailRequest)) as Job).jobId,
		);
		expect(rootFailJob.state).toBe("failed");
		expect(
			((await service.invoke("get_receipt", { jobId: rootFailJob.jobId })) as Result).error,
		).toMatchObject({ code: "NONFINITE_POPULATION_TARGET" });
		// ...the NaN-PE row fails the PE target...
		expect(
			(
				await terminal(
					service,
					(
						(await service.invoke(
							"start_population_medians",
							mediansJob(ids.S2, null, ["PE"]),
						)) as Job
					).jobId,
				)
			).state,
		).toBe("failed");
		// ...and the root APC target still succeeds over all nine finite APC values.
		const rootOkRequest = mediansJob(ids.S2, null, ["APC"]);
		const rootOkJob = await terminal(
			service,
			((await service.invoke("start_population_medians", rootOkRequest)) as Job).jobId,
		);
		expect(rootOkJob.state).toBe("succeeded");
		expect((await mediansArtifact(root, rootOkJob)).summary).toEqual(
			medianSummary({
				populationId: null,
				channels: ["APC"],
				count: 9,
				lower: [3],
				upper: [3],
				sourceRows: 9,
				gatePolicy: null,
			}),
		);
		// Failed median jobs publish nothing.
		expect(await readdir(join(root, "outputs"))).not.toContain(includedJob.jobId);
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
	});

	it("preserves subnormal endpoints and canonicalizes signed zero", async () => {
		// Root over all five rows: canonical order is -1, 0, 2^-149, 2^-148, 5; the odd
		// median is the first positive subnormal, proving subnormals are not flushed to zero.
		const subnormalJob = await terminal(
			service,
			((await service.invoke("start_population_medians", mediansJob(ids.S3, null, ["PE"]))) as Job)
				.jobId,
		);
		expect(subnormalJob.state).toBe("succeeded");
		expect((await mediansArtifact(root, subnormalJob)).summary).toEqual(
			medianSummary({
				populationId: null,
				channels: ["PE"],
				count: 5,
				lower: [2 ** -149],
				upper: [2 ** -149],
				sourceRows: 5,
				gatePolicy: null,
			}),
		);
		// Window {-1, -0}: canonicalization sorts -0 as positive zero, so ranks 0/1 give
		// lower -1 and upper 0 (raw bit ordering would report 0 then -1).
		const zeroJob = await terminal(
			service,
			(
				(await service.invoke(
					"start_population_medians",
					mediansJob(ids.S3, null, ["PE"], { startEvent: 0, eventCount: 2 }),
				)) as Job
			).jobId,
		);
		expect(zeroJob.state).toBe("succeeded");
		expect((await mediansArtifact(root, zeroJob)).summary).toEqual(
			medianSummary({
				populationId: null,
				channels: ["PE"],
				count: 2,
				lower: [-1],
				upper: [0],
				sourceRows: 2,
				gatePolicy: null,
			}),
		);
	});

	it("rejects empty root and empty gated populations without fabricating medians", async () => {
		// Root over a zero-event source: no rows, no median.
		const rootEmptyRequest = mediansJob(ids.S4, null, ["PE"]);
		const rootEmptyJob = await terminal(
			service,
			((await service.invoke("start_population_medians", rootEmptyRequest)) as Job).jobId,
		);
		expect(rootEmptyJob).toMatchObject({ state: "failed", result: undefined });
		expect(
			(await service.invoke("get_receipt", { jobId: rootEmptyJob.jobId })) as Result,
		).toMatchObject({
			state: "failed",
			recipe: rootEmptyRequest,
			error: { code: "EMPTY_POPULATION" },
		});
		// A gated population that selects nobody on a nonempty source behaves identically.
		const gatedEmptyRequest = mediansJob(ids.S1, "noneGate", ["PE"]);
		const gatedEmptyJob = await terminal(
			service,
			((await service.invoke("start_population_medians", gatedEmptyRequest)) as Job).jobId,
		);
		expect(gatedEmptyJob.state).toBe("failed");
		expect(
			(await service.invoke("get_receipt", { jobId: gatedEmptyJob.jobId })) as Result,
		).toMatchObject({ state: "failed", error: { code: "EMPTY_POPULATION" } });
		expect(await readdir(join(root, "outputs"))).not.toContain(gatedEmptyJob.jobId);
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
	});

	it("cancels a long four-pass median and leaves no artifacts", async () => {
		const request = mediansJob(ids.F, "quadA", ["PE"]);
		const submitted = (await service.invoke("start_population_medians", request)) as Job;
		// 120000 total visits; cancel once the second chunk boundary is crossed.
		await vi.waitFor(
			async () => {
				const job = (await service.invoke("get_job", { jobId: submitted.jobId })) as Job;
				expect(job.processedEvents ?? 0).toBeGreaterThanOrEqual(1000);
			},
			{ timeout: 15_000, interval: 10 },
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
			progressUnit: "event-visits",
		});
		expect((receipt.processedEvents as number) ?? 0).toBeGreaterThanOrEqual(1000);
		expect(receipt.summary).toBeUndefined();
		expect(receipt.output).toBeUndefined();
		expect(await readdir(join(root, "outputs"))).not.toContain(submitted.jobId);
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
		// The immutable snapshot survives a cancelled median byte-for-byte.
		expect(
			(await readFile(join(root, ".flow-atlas", "inputs", `${ids.F}.fcs`))).equals(
				originals.get(ids.F) as Uint8Array,
			),
		).toBe(true);
	}, 45_000);

	it("executes through MCP and serves the identical receipt after a host restart", async () => {
		const scoped = await harness("medians-mcp");
		const token = "population-medians-mcp-token";
		const studio = await createStudioServer({ service: scoped.service, token });
		const client = new Client({ name: "population-medians-test", version: "1" });
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
			const request = mediansJob(scoped.ids.S1, "edgePE3", ["APC", "PE"]);
			started = await call("start_population_medians", request as unknown as Result);
			job = await terminal(scoped.service, started.jobId as string);
			expect(job.state).toBe("succeeded");
			receipt = await call("get_receipt", { jobId: started.jobId });
			expect(receipt).toMatchObject({
				operation: "population-medians",
				state: "succeeded",
				input: { sha256: scoped.ids.S1 },
				recipe: request,
			});
			expect(receipt.summary).toEqual((await mediansArtifact(scoped.root, job)).summary);
			const rejected = await client.callTool({
				name: "start_population_medians",
				arguments: mediansJob(scoped.ids.S1, "ghost", ["PE"]) as unknown as Result,
			});
			expect(rejected.isError).toBe(true);
			expect(
				JSON.parse((rejected.content as Array<{ text: string }>)[0]?.text ?? "null"),
			).toMatchObject({ error: { code: "INVALID_POPULATION_RECIPE" } });
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
			kind: "population-medians",
			live: false,
			phase: "complete",
			processedEvents: 384,
			totalEvents: 384,
			result: job.result,
		});
	}, 30_000);

	it("serves the durable main median receipt after the host restarts", async () => {
		await service.close();
		const restored = await createAnalysisService({ root, maxChunkBytes: 1024 });
		services.push(restored);
		expect(await restored.invoke("get_receipt", { jobId: mainJobId })).toEqual(mainReceipt);
		expect(await restored.invoke("get_job", { jobId: mainJobId })).toMatchObject({
			state: "succeeded",
			kind: "population-medians",
			live: false,
			phase: "complete",
		});
	});
});
