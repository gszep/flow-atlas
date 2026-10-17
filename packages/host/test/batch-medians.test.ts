import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHeader } from "@flow-atlas/fcs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAnalysisService } from "../src/analysis.js";
import type { AnalysisService, OperationArgs } from "../src/contracts.js";
import { createStudioServer } from "../src/server.js";

type Request = OperationArgs<"start_batch_population_medians">;
type Gate = Request["gates"][number];
type SampleSpec = Request["samples"][number];
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
// encodeFcs takes rows already in the file's column order; every fixture passes through it
// before writeFile and asserts an FCS 3.1 header before import (prior-milestone lesson).
function encodeFcs(rows: number[][], names: string[]): Uint8Array {
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

// Logical rows are [PE, APC, FSC]; the file column order varies per sample.
const LOGICAL = ["PE", "APC", "FSC"];
function synthetic(rows: Array<[number, number, number]>, fileOrder: string[]): Uint8Array {
	return encodeFcs(
		rows.map((row) => fileOrder.map((name) => row[LOGICAL.indexOf(name)] as number)),
		fileOrder,
	);
}

// Tiny transparent datasets with hand-sorted values; no NOT or polygon gates, so every
// population is directly enumerable.
// S1 (7 rows, odd): PE ascending 1..7, APC descending 19..13.
const rowsS1: Array<[number, number, number]> = [
	[1, 19, 100],
	[2, 18, 101],
	[3, 17, 102],
	[4, 16, 103],
	[5, 15, 104],
	[6, 14, 105],
	[7, 13, 106],
];
// S2 (6 rows, even): PE 2..12 step 2, APC 1..6. Its `big` population (APC>=16) is empty.
const rowsS2: Array<[number, number, number]> = [
	[2, 1, 200],
	[4, 2, 201],
	[6, 3, 202],
	[8, 4, 203],
	[10, 5, 204],
	[12, 6, 205],
];
// S3 (5 rows, mixed signs): PE -3..4, APC 7..11. `pos` keeps the PE>=0 boundary row.
const rowsS3: Array<[number, number, number]> = [
	[-3, 7, 300],
	[-1, 8, 301],
	[0, 9, 302],
	[2, 10, 303],
	[4, 11, 304],
];
// S5 (3 rows): one NaN APC row inside every population, so root/PE succeeds while any
// APC target fails as a selected nonfinite value.
const rowsS5: Array<[number, number, number]> = [
	[1, 5, 500],
	[2, Number.NaN, 501],
	[3, 7, 502],
];
// Uniform filler for a deterministic mid-run cancellation window: PE=3 everywhere, so any
// prefix median is 3 without enumeration.
const rowsFiller = (count: number): number[][] => Array.from({ length: count }, () => [3, 3, 7]);

// Shared two-gate recipe in deliberately shuffled request order: the nested gate precedes
// its parent, so admission must topologically sort rather than trust array order.
const GATES: Gate[] = [
	rectangle("big", "Big", "pos", ["APC"], [16], [null]),
	rectangle("pos", "Pos", null, ["PE"], [0], [null]),
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

// Exact diagnostics of the landed four-pass GPU median summary; sourceRows counts the
// streamed window rows of one pass (the summary accumulates across the four passes).
function medianDiagnostics(sourceRows: number) {
	return {
		algorithm: "gpu-radix256-exact-rank-v1",
		passCount: 4,
		precision: "exact-f32-rank-endpoints",
		scope: "selected-population-not-vendor-parity",
		zeroPolicy: "canonical-positive-zero",
		subnormalPolicy: "preserve-integer-bit-order",
		sourceRows,
	};
}

// Hand-derived rank endpoints, not implementation mirroring: lower is the
// floor((count-1)/2)-th and upper the floor(count/2)-th smallest member, 0-based.
const ranks = (count: number) => ({
	indexBase: 0,
	lower: Math.floor((count - 1) / 2),
	upper: Math.floor(count / 2),
});

function sampleEntry(
	sampleIndex: number,
	sampleId: string,
	options: {
		label?: string;
		startEvent: number;
		eventCount: number;
		count: number;
		gatePolicy: string | null;
	},
) {
	return {
		sampleIndex,
		sampleId,
		...(options.label === undefined ? {} : { label: options.label }),
		startEvent: options.startEvent,
		eventCount: options.eventCount,
		count: options.count,
		ranks: ranks(options.count),
		diagnostics: medianDiagnostics(options.eventCount),
		gateNumericalPolicy: options.gatePolicy,
		recipeHash: expect.stringMatching(HEX64),
	};
}
function row(sampleIndex: number, channelIndex: number, lower: number, upper: number) {
	return { sampleIndex, channelIndex, lower, upper };
}

function batchRequest(
	samples: SampleSpec[],
	populationId: string | null,
	channels: string[],
	gates?: Gate[],
): Request {
	// The recipe's gates are shared by every sample; the root mode uses the empty recipe.
	const resolved = gates ?? (populationId === null ? undefined : GATES);
	return {
		coordinateSpace: "stored-f32",
		populationId,
		channels,
		samples,
		...(resolved === undefined ? {} : { gates: resolved }),
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
	ids: Record<"S1" | "S2" | "S3" | "S5" | "F", string>;
	importSample: (file: string, bytes: Uint8Array) => Promise<string>;
};

async function harness(name: string): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), `flow-atlas-${name}-`));
	roots.push(root);
	const service = await createAnalysisService({ root, maxChunkBytes: 1024 });
	services.push(service);
	const importSample = async (file: string, bytes: Uint8Array): Promise<string> => {
		// Defensive fixture gate: the encoded bytes must parse as an FCS 3.1 header
		// through the real reader before any import is attempted.
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
	const ids: Record<"S1" | "S2" | "S3" | "S5" | "F", string> = {
		S1: "",
		S2: "",
		S3: "",
		S5: "",
		F: "",
	};
	ids.S1 = await importSample("medians-s1.fcs", synthetic(rowsS1, ["FSC", "PE", "APC"]));
	ids.S2 = await importSample("medians-s2.fcs", synthetic(rowsS2, ["PE", "APC", "FSC"]));
	ids.S3 = await importSample("medians-s3.fcs", synthetic(rowsS3, ["APC", "FSC", "PE"]));
	ids.S5 = await importSample("medians-s5.fcs", synthetic(rowsS5, ["PE", "APC", "FSC"]));
	ids.F = await importSample(
		"medians-filler.fcs",
		encodeFcs(rowsFiller(30_000), ["PE", "APC", "FSC"]),
	);
	await writeFile(join(root, "medians-filler.fcs"), "source replaced after import");
	return { root, service, ids, importSample };
}

let root: string, service: AnalysisService;
let ids: Record<"S1" | "S2" | "S3" | "S5" | "F", string>;
let importSample: (file: string, bytes: Uint8Array) => Promise<string>;
let mainJobId = "";
let mainReceipt: Result = {};

beforeAll(async () => {
	({ root, service, ids, importSample } = await harness("batch-medians"));
}, 60_000);
afterAll(async () => {
	for (const opened of services.splice(0)) await opened.close();
	for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
	originals.clear();
});

describe("batch population medians through the analysis service", () => {
	it("rejects invalid batch recipes atomically before any run record", async () => {
		const before = {
			runs: await readdir(join(root, ".flow-atlas", "runs")),
			outputs: await readdir(join(root, "outputs")),
		};
		// Sample IDs are content hashes and must be distinct within one batch.
		await expect(
			service.invoke("start_batch_population_medians", {
				...batchRequest([{ sampleId: ids.S1 }, { sampleId: ids.S1 }, { sampleId: ids.S2 }], "pos", [
					"PE",
				]),
			}),
		).rejects.toMatchObject({ code: "INVALID_BATCH_RECIPE" });
		// A target channel no source carries must fail admission, not the run.
		await expect(
			service.invoke(
				"start_batch_population_medians",
				batchRequest([{ sampleId: ids.S1 }], "pos", ["PE", "CD3"]),
			),
		).rejects.toMatchObject({ code: "INVALID_POPULATION_CHANNEL" });
		// The root population (null) requires the empty gate recipe; a named population
		// must be one of the recipe's gates.
		await expect(
			service.invoke(
				"start_batch_population_medians",
				batchRequest([{ sampleId: ids.S1 }], null, ["PE"], GATES),
			),
		).rejects.toMatchObject({ code: "INVALID_POPULATION_RECIPE" });
		await expect(
			service.invoke(
				"start_batch_population_medians",
				batchRequest([{ sampleId: ids.S1 }], "ghost", ["PE"]),
			),
		).rejects.toMatchObject({ code: "INVALID_POPULATION_RECIPE" });
		// Per-source windows must lie inside their own file.
		await expect(
			service.invoke(
				"start_batch_population_medians",
				batchRequest([{ sampleId: ids.S1, startEvent: 8 }], "pos", ["PE"]),
			),
		).rejects.toMatchObject({ code: "INVALID_POPULATION_RANGE" });
		// The strict schema refuses display transforms, processing arguments, and bound violations.
		const base = batchRequest([{ sampleId: ids.S1 }], "pos", ["PE"]);
		for (const extra of [
			{ inputSpace: "linearized" },
			{ acquisition: { timeStep: 0.5 } },
			{ transforms: [{ channel: "PE", type: "biexponential" }] },
			{ coordinateSpace: "display" },
			{ channels: [] },
			{ channels: Array.from({ length: 33 }, (_, i) => `C${i}`) },
			{ samples: [] },
			{ samples: Array.from({ length: 33 }, (_, i) => ({ sampleId: `s${i}` })) },
			{ samples: [{ sampleId: ids.S1, label: "" }] },
			{
				gates: Array.from({ length: 129 }, (_, i) =>
					rectangle(`g${i}`, `G${i}`, null, ["PE"], [i], [i]),
				),
			},
		]) {
			await expect(
				service.invoke("start_batch_population_medians", { ...base, ...extra }),
			).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		}
		await unchangedStores(root, before);
	});

	it("enforces the 512 sample/channel row cap on real distinct sources", async () => {
		// 17 distinct one-row sources x 32 target channels = 544 rows.
		const samples: string[] = [];
		for (let i = 0; i < 17; i++) {
			const names = Array.from({ length: 32 }, (_, j) => `C${j}`);
			samples.push(
				await importSample(`cap-${i}.fcs`, encodeFcs([names.map((_, j) => 100 * i + j)], names)),
			);
		}
		const before = {
			runs: await readdir(join(root, ".flow-atlas", "runs")),
			outputs: await readdir(join(root, "outputs")),
		};
		await expect(
			service.invoke(
				"start_batch_population_medians",
				batchRequest(
					samples.map((sampleId) => ({ sampleId })),
					null,
					Array.from({ length: 32 }, (_, j) => `C${j}`),
				),
			),
		).rejects.toMatchObject({ code: "BATCH_ROW_LIMIT" });
		await unchangedStores(root, before);
		// Dropping one source stays within the cap (16 x 32 = 512 rows) and the job succeeds.
		const under = batchRequest(
			samples.slice(0, 16).map((sampleId) => ({ sampleId })),
			null,
			Array.from({ length: 32 }, (_, j) => `C${j}`),
		);
		const submitted = (await service.invoke("start_batch_population_medians", under)) as Job;
		const job = await terminal(service, submitted.jobId);
		expect(job.state).toBe("succeeded");
		const artifact = await mediansArtifact(root, job);
		expect(artifact.summary).toMatchObject({
			sampleCount: 16,
			channelCount: 32,
			rowCount: 512,
			coordinateSpace: "stored-f32",
			populationId: null,
		});
		// Spot-check hand-known rows: sample i channel j holds the single value 100*i+j.
		const rows = (artifact.summary as { rows: Result[] }).rows;
		expect(rows[0]).toEqual(row(0, 0, 0, 0));
		expect(rows[511]).toEqual(row(15, 31, 1531, 1531));
	}, 60_000);

	it("medians three reordered-channel samples through one shared nested gate", async () => {
		const request = batchRequest(
			[
				{ sampleId: ids.S1, label: "one" },
				{ sampleId: ids.S2, label: "two" },
				{ sampleId: ids.S3, label: "three" },
			],
			"pos",
			["PE", "APC"],
		);
		const submitted = (await service.invoke("start_batch_population_medians", request)) as Job;
		const job = await terminal(service, submitted.jobId);
		// Four passes over 7+6+5 window rows: 72 event visits.
		expect(job).toMatchObject({
			state: "succeeded",
			kind: "batch-population-medians",
			progressUnit: "event-visits",
			processedEvents: 72,
			totalEvents: 72,
			request,
			inputContext: { inputSpace: "stored" },
		});
		// Hand-enumerated normalized table in request order (sample-major, channel-minor):
		// S1 pos = all 7 rows (PE 4/4, APC 16/16); S2 pos = all 6 (PE 6/8, APC 3/4);
		// S3 pos = 3 rows PE>=0 (PE 2/2, APC 10/10).
		const expected = {
			coordinateSpace: "stored-f32",
			populationId: "pos",
			channels: ["PE", "APC"],
			sampleCount: 3,
			channelCount: 2,
			rowCount: 6,
			samples: [
				sampleEntry(0, ids.S1, {
					label: "one",
					startEvent: 0,
					eventCount: 7,
					count: 7,
					gatePolicy: POLICY,
				}),
				sampleEntry(1, ids.S2, {
					label: "two",
					startEvent: 0,
					eventCount: 6,
					count: 6,
					gatePolicy: POLICY,
				}),
				sampleEntry(2, ids.S3, {
					label: "three",
					startEvent: 0,
					eventCount: 5,
					count: 3,
					gatePolicy: POLICY,
				}),
			],
			rows: [
				row(0, 0, 4, 4),
				row(0, 1, 16, 16),
				row(1, 0, 6, 8),
				row(1, 1, 3, 4),
				row(2, 0, 2, 2),
				row(2, 1, 10, 10),
			],
		};
		const artifact = await mediansArtifact(root, job);
		expect(artifact.summary).toEqual(expected);
		expect(artifact.recipe).toEqual(request);
		const receipt = (await service.invoke("get_receipt", { jobId: job.jobId })) as Result;
		expect(receipt).toMatchObject({
			schemaVersion: 1,
			operation: "batch-population-medians",
			jobId: job.jobId,
			state: "succeeded",
			input: {
				samples: [
					{ sampleIndex: 0, sha256: ids.S1 },
					{ sampleIndex: 1, sha256: ids.S2 },
					{ sampleIndex: 2, sha256: ids.S3 },
				],
			},
			inputContext: { inputSpace: "stored" },
			recipe: request,
			eventVisits: 72,
			progressUnit: "event-visits",
			output: job.result,
		});
		expect(receipt.recipeHash).toMatch(HEX64);
		expect(receipt.summary).toEqual(artifact.summary);
		// Per-sample recipe hashes bind each source's identity/window and are distinct.
		const sampleHashes = (
			receipt.summary as { samples: Array<{ recipeHash: string }> }
		).samples.map((sample) => sample.recipeHash);
		expect(new Set(sampleHashes).size).toBe(3);
		// A nested population through the same recipe on one source: `big` on S1 keeps the
		// four APC>=16 members (even count, distinct endpoints prove no midpoint averaging).
		const bigJob = await terminal(
			service,
			(
				(await service.invoke(
					"start_batch_population_medians",
					batchRequest([{ sampleId: ids.S1 }], "big", ["PE", "APC"]),
				)) as Job
			).jobId,
		);
		expect(bigJob.state).toBe("succeeded");
		expect((await mediansArtifact(root, bigJob)).summary).toEqual({
			coordinateSpace: "stored-f32",
			populationId: "big",
			channels: ["PE", "APC"],
			sampleCount: 1,
			channelCount: 2,
			rowCount: 2,
			samples: [
				sampleEntry(0, ids.S1, { startEvent: 0, eventCount: 7, count: 4, gatePolicy: POLICY }),
			],
			rows: [row(0, 0, 2, 3), row(0, 1, 17, 18)],
		});
		expect(
			JSON.parse(
				await readFile(join(root, (job.result as NonNullable<Job["result"]>).receiptPath), "utf8"),
			),
		).toEqual(receipt);
		// Every source snapshot is byte-identical after counting.
		for (const id of [ids.S1, ids.S2, ids.S3])
			expect(
				(await readFile(join(root, ".flow-atlas", "inputs", `${id}.fcs`))).equals(
					originals.get(id) as Uint8Array,
				),
			).toBe(true);
		mainJobId = submitted.jobId;
		mainReceipt = receipt;
	});

	it("follows the reversed target list and supports root mode across samples", async () => {
		// Root (null) with omitted gates: S1 root APC 16/16 PE 4/4; S3 root APC 9/9 PE 0/0.
		// The reversed channel list must be followed, not sorted.
		const request = batchRequest([{ sampleId: ids.S1 }, { sampleId: ids.S3 }], null, ["APC", "PE"]);
		const submitted = (await service.invoke("start_batch_population_medians", request)) as Job;
		const job = await terminal(service, submitted.jobId);
		expect(job).toMatchObject({
			state: "succeeded",
			processedEvents: 48,
			totalEvents: 48,
		});
		expect((await mediansArtifact(root, job)).summary).toEqual({
			coordinateSpace: "stored-f32",
			populationId: null,
			channels: ["APC", "PE"],
			sampleCount: 2,
			channelCount: 2,
			rowCount: 4,
			samples: [
				sampleEntry(0, ids.S1, { startEvent: 0, eventCount: 7, count: 7, gatePolicy: null }),
				sampleEntry(1, ids.S3, { startEvent: 0, eventCount: 5, count: 5, gatePolicy: null }),
			],
			rows: [row(0, 0, 16, 16), row(0, 1, 4, 4), row(1, 0, 9, 9), row(1, 1, 0, 0)],
		});
	});

	it("applies per-source windows with odd and even rank endpoints", async () => {
		const request = batchRequest(
			[
				{ sampleId: ids.S1, startEvent: 1, eventCount: 4 },
				{ sampleId: ids.S2, startEvent: 2, eventCount: 2 },
			],
			"pos",
			["PE", "APC"],
		);
		const submitted = (await service.invoke("start_batch_population_medians", request)) as Job;
		const job = await terminal(service, submitted.jobId);
		expect(job).toMatchObject({
			state: "succeeded",
			processedEvents: 24,
			totalEvents: 24,
		});
		// S1 window rows PE [2,3,4,5] (even: 3/4 distinct endpoints, no 3.5 midpoint) and
		// APC [15,16,17,18] (16/17); S2 window rows PE [6,8] and APC [3,4].
		expect((await mediansArtifact(root, job)).summary).toEqual({
			coordinateSpace: "stored-f32",
			populationId: "pos",
			channels: ["PE", "APC"],
			sampleCount: 2,
			channelCount: 2,
			rowCount: 4,
			samples: [
				sampleEntry(0, ids.S1, { startEvent: 1, eventCount: 4, count: 4, gatePolicy: POLICY }),
				sampleEntry(1, ids.S2, { startEvent: 2, eventCount: 2, count: 2, gatePolicy: POLICY }),
			],
			rows: [row(0, 0, 3, 4), row(0, 1, 16, 17), row(1, 0, 6, 8), row(1, 1, 3, 4)],
		});
	});

	it("fails the whole batch without artifacts when a later sample is empty or nonfinite", async () => {
		// S1 `big` succeeds (4 members); S2 `big` selects nobody -> whole batch fails.
		const emptyRequest = batchRequest([{ sampleId: ids.S1 }, { sampleId: ids.S2 }], "big", ["PE"]);
		const emptyJob = await terminal(
			service,
			((await service.invoke("start_batch_population_medians", emptyRequest)) as Job).jobId,
		);
		expect(emptyJob).toMatchObject({ state: "failed", result: undefined });
		const emptyReceipt = (await service.invoke("get_receipt", {
			jobId: emptyJob.jobId,
		})) as Result;
		expect(emptyReceipt).toMatchObject({
			state: "failed",
			recipe: emptyRequest,
			error: {
				code: "EMPTY_POPULATION",
				details: { sampleIndex: 1, sampleId: ids.S2, completedSamples: 1, phase: "run" },
			},
		});
		expect(emptyReceipt.summary).toBeUndefined();
		expect(emptyReceipt.output).toBeUndefined();
		// A zero-event window on the second source behaves identically.
		const zeroRequest = batchRequest(
			[{ sampleId: ids.S3 }, { sampleId: ids.S1, eventCount: 0 }],
			"pos",
			["PE"],
		);
		const zeroJob = await terminal(
			service,
			((await service.invoke("start_batch_population_medians", zeroRequest)) as Job).jobId,
		);
		expect(zeroJob.state).toBe("failed");
		expect(
			((await service.invoke("get_receipt", { jobId: zeroJob.jobId })) as Result).error,
		).toMatchObject({
			code: "EMPTY_POPULATION",
			details: { sampleIndex: 1, sampleId: ids.S1, completedSamples: 1, phase: "run" },
		});
		// S1 root succeeds; S5 root APC contains NaN -> typed nonfinite failure, no partial artifact.
		const finiteRequest = batchRequest([{ sampleId: ids.S1 }, { sampleId: ids.S5 }], null, ["APC"]);
		const finiteJob = await terminal(
			service,
			((await service.invoke("start_batch_population_medians", finiteRequest)) as Job).jobId,
		);
		expect(finiteJob.state).toBe("failed");
		const finiteReceipt = (await service.invoke("get_receipt", {
			jobId: finiteJob.jobId,
		})) as Result;
		expect(finiteReceipt).toMatchObject({
			state: "failed",
			recipe: finiteRequest,
			error: {
				code: "NONFINITE_POPULATION_TARGET",
				details: { sampleIndex: 1, sampleId: ids.S5, completedSamples: 1, phase: "run" },
			},
		});
		// The same S5 source keeps a finite PE target median, so the failure is target-specific.
		const peRequest = batchRequest([{ sampleId: ids.S5 }], null, ["PE"]);
		const peJob = await terminal(
			service,
			((await service.invoke("start_batch_population_medians", peRequest)) as Job).jobId,
		);
		expect(peJob.state).toBe("succeeded");
		expect((await mediansArtifact(root, peJob)).summary).toMatchObject({
			rowCount: 1,
			rows: [row(0, 0, 2, 2)],
		});
		// No failed batch published anything.
		for (const job of [emptyJob, zeroJob, finiteJob])
			expect(await readdir(join(root, "outputs"))).not.toContain(job.jobId);
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
	});

	it("cancels a long batch mid-run and leaves no artifacts", async () => {
		const request = batchRequest([{ sampleId: ids.F }], null, ["PE"]);
		const submitted = (await service.invoke("start_batch_population_medians", request)) as Job;
		// 120000 total event visits; cancel once the first pass is clearly underway.
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
		expect(
			(receipt.eventVisits as number) ?? (receipt.processedEvents as number) ?? 0,
		).toBeGreaterThanOrEqual(1000);
		expect(receipt.summary).toBeUndefined();
		expect(receipt.output).toBeUndefined();
		expect(await readdir(join(root, "outputs"))).not.toContain(submitted.jobId);
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
		// The immutable snapshot survives a cancelled batch byte-for-byte.
		expect(
			(await readFile(join(root, ".flow-atlas", "inputs", `${ids.F}.fcs`))).equals(
				originals.get(ids.F) as Uint8Array,
			),
		).toBe(true);
	}, 45_000);

	it("executes through MCP and serves the identical receipt after a host restart", async () => {
		const scoped = await harness("batch-medians-mcp");
		const token = "batch-medians-mcp-token";
		const studio = await createStudioServer({ service: scoped.service, token });
		const client = new Client({ name: "batch-medians-test", version: "1" });
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
			const request = batchRequest(
				[{ sampleId: scoped.ids.S1, label: "one" }, { sampleId: scoped.ids.S2 }],
				"pos",
				["PE"],
			);
			started = await call("start_batch_population_medians", request as unknown as Result);
			job = await terminal(scoped.service, started.jobId as string);
			expect(job.state).toBe("succeeded");
			receipt = await call("get_receipt", { jobId: started.jobId });
			expect(receipt).toMatchObject({
				operation: "batch-population-medians",
				state: "succeeded",
				recipe: request,
			});
			expect(receipt.summary).toEqual((await mediansArtifact(scoped.root, job)).summary);
			const rejected = await client.callTool({
				name: "start_batch_population_medians",
				arguments: batchRequest([{ sampleId: scoped.ids.S1 }, { sampleId: scoped.ids.S1 }], "pos", [
					"PE",
				]) as unknown as Result,
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
			kind: "batch-population-medians",
			live: false,
			phase: "complete",
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
			kind: "batch-population-medians",
			live: false,
			phase: "complete",
		});
	});
});
