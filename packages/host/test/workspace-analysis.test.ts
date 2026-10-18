import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHeader } from "@flow-atlas/fcs";
import { validateWorkspace, type WorkspaceDocument } from "@flow-atlas/model";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAnalysisService } from "../src/analysis.js";
import { ArtifactStore } from "../src/artifact-store.js";
import type { AnalysisService, OperationArgs } from "../src/contracts.js";
import { createStudioServer } from "../src/server.js";

type InspectArgs = OperationArgs<"inspect_workspace">;
type CountArgs = OperationArgs<"start_workspace_gate_counts">;
type MedianArgs = OperationArgs<"start_workspace_population_medians">;
type Result = Record<string, unknown>;
type Job = Result & {
	jobId: string;
	state?: string;
	processedEvents?: number;
	totalEvents?: number;
	result?: { path: string; sha256: string; bytes: number; receiptPath: string };
};
type Identity = { path: string; sha256: string; bytes: number };

const HEX64 = /^[a-f0-9]{64}$/;
const roots: string[] = [];
const services: AnalysisService[] = [];

// Independent FCS 3.1 encoder: little-endian $DATATYPE F rows behind a "|" keyword section.
// Every fixture passes through it before writeFile and asserts an FCS 3.1 header before
// import (prior-milestone lesson: never write raw row arrays).
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

// Fixture rows are authored directly in the FCS physical column order ["FSC","PE","APC"]:
// each row is [fsc, pe, apc]. The model channel order (APC, PE, FSC) differs from the
// physical order to prove ID-based name mapping rather than positional coupling.
const rowsA = (): number[][] =>
	Array.from({ length: 2 }, () => [
		[100, 3, 3],
		[101, -1, -1],
		[102, 0, 0],
		[103, 5, 2],
		[104, 2, 8],
		[105, -2, 4],
		[106, 3, -1],
		[107, 10, 10],
	]).flat();

// Workspace document fixture. c-pe carries a display-only biex transform that raw
// computation must ignore while inspection retains it. Gate request order is shuffled
// (dependents first). g-edge declares a human provenance stamp; numeric rows never do.
function buildDocument(
	files: {
		main: { sha256: string; size: number };
		tiny: { sha256: string; size: number };
	},
	revision = 7,
	quadAMin: [number, number] = [0, 0],
): WorkspaceDocument {
	const document: WorkspaceDocument = {
		schemaVersion: 1,
		id: "ws-study",
		revision,
		agentEdit: { agentId: "mochi-the-kitty", revision: Math.min(3, revision) },
		samples: [
			{
				id: "s-main",
				file: { sha256: files.main.sha256, basename: "main.fcs", size: files.main.size },
				channels: [
					{ id: "c-apc", name: "APC" },
					{
						id: "c-pe",
						name: "PE",
						transform: {
							type: "biex",
							width: -100,
							neg: 0,
							pos: 4.42,
							maxRange: 262144,
							channelRange: 4096,
							length: 1024,
						},
					},
					{ id: "c-fsc", name: "FSC" },
				],
			},
			{
				id: "s-empty",
				file: { sha256: files.tiny.sha256, basename: "tiny.fcs", size: files.tiny.size },
				channels: [{ id: "c-e", name: "PE" }],
			},
			{
				id: "s-ghost",
				file: { sha256: files.main.sha256, basename: "main.fcs", size: files.main.size },
				channels: [{ id: "c-cd3", name: "CD3" }],
			},
			{
				id: "s-bad",
				file: { sha256: files.main.sha256, basename: "main.fcs", size: files.main.size + 1 },
				channels: [{ id: "c-b", name: "PE" }],
			},
		],
		gates: [
			{
				id: "g-andA",
				sampleId: "s-main",
				name: "AndA",
				parentId: "g-all",
				dimensions: [],
				geometry: { type: "boolean", op: "and", refs: ["g-quadA", "g-edge"] },
			},
			{
				id: "g-bright",
				sampleId: "s-main",
				name: "Bright",
				parentId: "g-quadA",
				dimensions: ["c-pe", "c-apc"],
				geometry: {
					type: "polygon",
					vertices: [
						[1, 1],
						[9, 1],
						[1, 9],
					],
				},
			},
			{
				id: "g-quadA",
				sampleId: "s-main",
				name: "QuadA",
				parentId: "g-all",
				dimensions: ["c-pe", "c-apc"],
				geometry: { type: "rectangle", min: [quadAMin[0], quadAMin[1]], max: [null, null] },
			},
			{
				id: "g-edge",
				sampleId: "s-main",
				name: "Edge",
				parentId: null,
				dimensions: ["c-pe"],
				geometry: { type: "rectangle", min: [3], max: [3] },
				author: "flowjo-user",
				modified: "2026-01-01T00:00:00Z",
			},
			{
				id: "g-all",
				sampleId: "s-main",
				name: "All",
				parentId: null,
				dimensions: ["c-pe", "c-apc"],
				geometry: { type: "rectangle", min: [null, null], max: [null, null] },
			},
			{
				id: "g-cd3",
				sampleId: "s-ghost",
				name: "Cd3",
				parentId: null,
				dimensions: ["c-cd3"],
				geometry: { type: "rectangle", min: [0], max: [1] },
			},
		],
		groups: [{ id: "grp1", name: "Cohort", sampleIds: ["s-main", "s-empty"] }],
		annotations: [{ id: "an1", gateId: null, text: "study note" }],
	};
	validateWorkspace(document);
	return document;
}

// Minimal document for the unimported-source scenario: the referenced FCS exists in the
// workspace root but no managed snapshot was ever created for it.
function lateDocument(late: { sha256: string; size: number }): WorkspaceDocument {
	const document: WorkspaceDocument = {
		schemaVersion: 1,
		id: "ws-late",
		revision: 1,
		samples: [
			{
				id: "s-late",
				file: { sha256: late.sha256, basename: "late.fcs", size: late.size },
				channels: [{ id: "c-l", name: "PE" }],
			},
		],
		gates: [
			{
				id: "g-late",
				sampleId: "s-late",
				name: "Late",
				parentId: null,
				dimensions: ["c-l"],
				geometry: { type: "rectangle", min: [0], max: [1] },
			},
		],
		groups: [],
		annotations: [],
	};
	validateWorkspace(document);
	return document;
}

// Hand-enumerated memberships for FCS A (8-row tile x2 = 16 rows) under the shared recipe:
// all=16, quadA={r0,r2,r3,r4,r7}x2=10, edge(PE=3)={r0,r6}x2=4, andA=quadA AND edge={r0}x2=2,
// bright polygon (1,1),(9,1),(1,9) with boundary ties outside = {r0,r3}x2=4.
const COUNTS: Record<string, { count: number; parentCount: number }> = {
	"g-all": { count: 16, parentCount: 16 },
	"g-quadA": { count: 10, parentCount: 16 },
	"g-edge": { count: 4, parentCount: 16 },
	"g-andA": { count: 2, parentCount: 16 },
	"g-bright": { count: 4, parentCount: 10 },
};

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

async function artifact(jobRoot: string, job: Job, name: RegExp): Promise<Result> {
	const output = job.result as NonNullable<Job["result"]>;
	const bytes = await readFile(join(jobRoot, output.path));
	expect(createHash("sha256").update(bytes).digest("hex")).toBe(output.sha256);
	expect(output.path).toMatch(name);
	return JSON.parse(bytes.toString("utf8")) as Result;
}

type Harness = {
	root: string;
	service: AnalysisService;
	main: { sha256: string; size: number };
	tiny: { sha256: string; size: number };
	inputs: string[];
};

async function harness(name: string): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), `flow-atlas-${name}-`));
	roots.push(root);
	const service = await createAnalysisService({ root, maxChunkBytes: 1024 });
	services.push(service);
	// Managed FCS snapshots through the real importer; header asserted before import.
	const importSample = async (file: string, bytes: Uint8Array): Promise<string> => {
		const header = readHeader(
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		);
		expect(header.version).toBe("FCS3.1");
		await writeFile(join(root, file), bytes);
		const imported = (await service.invoke("import_fcs", { path: file })) as Result;
		return imported.sampleId as string;
	};
	const bytesA = encodeFcs(rowsA(), ["FSC", "PE", "APC"]);
	const bytesB = encodeFcs([[0, 0, 0]], ["PE", "APC", "FSC"]);
	const main = { sha256: await importSample("main.fcs", bytesA), size: bytesA.length };
	const tiny = { sha256: await importSample("tiny.fcs", bytesB), size: bytesB.length };
	// An FCS file that exists in the workspace root but is deliberately never imported.
	await writeFile(join(root, "late.fcs"), encodeFcs([[1, 1, 1]], ["PE", "APC", "FSC"]));
	const inputs = await readdir(join(root, ".flow-atlas", "inputs"));
	return { root, service, main, tiny, inputs };
}

async function writeDoc(
	root: string,
	file: string,
	document: WorkspaceDocument,
): Promise<Identity> {
	// Tests are trusted input producers: plain stringify of a validated document, never
	// production-authored stamps.
	await writeFile(join(root, file), JSON.stringify(document));
	const bytes = await readFile(join(root, file));
	return {
		path: file,
		sha256: createHash("sha256").update(bytes).digest("hex"),
		bytes: bytes.byteLength,
	};
}

function inspectArgs(identity: Identity, extra: Partial<InspectArgs> = {}): InspectArgs {
	return { path: identity.path, expectedRevision: 7, expectedSha256: identity.sha256, ...extra };
}

function countArgs(
	identity: Identity,
	sampleId: string,
	extra: Partial<CountArgs> = {},
): CountArgs {
	return {
		path: identity.path,
		expectedRevision: 7,
		expectedSha256: identity.sha256,
		sampleId,
		coordinateSpace: "stored-f32",
		...extra,
	};
}

function medianArgs(
	identity: Identity,
	sampleId: string,
	populationId: string | null,
	channels: string[],
	extra: Partial<MedianArgs> = {},
): MedianArgs {
	// Workspace medians take gate definitions from the document; the request carries only
	// the population reference and target channel IDs.
	return { ...countArgs(identity, sampleId), populationId, channels, ...extra };
}

let h: Harness;
let study: Identity;
let mainService: AnalysisService;
let mainCountJobId = "";
let mainCountReceipt: Result = {};

beforeAll(async () => {
	h = await harness("workspace-analysis");
	mainService = h.service;
	study = await writeDoc(h.root, "study.flowatlas.json", buildDocument(h));
}, 60_000);
afterAll(async () => {
	for (const opened of services.splice(0)) await opened.close();
	for (const dir of roots.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("workspace analysis binding through the analysis service", () => {
	it("pages samples, gates and channels with identity guards and declared stamps only", async () => {
		const samples = (await h.service.invoke("inspect_workspace", {
			path: "study.flowatlas.json",
		})) as Result;
		// Unfiltered sample view: document identity, no stamps on numeric rows.
		expect(samples.document).toMatchObject({
			path: "study.flowatlas.json",
			id: "ws-study",
			revision: 7,
			sha256: study.sha256,
			bytes: study.bytes,
		});
		expect(samples.view).toBe("samples");
		expect(samples.sampleId).toBeNull();
		expect(samples.total).toBe(4);
		expect(samples.offset).toBe(0);
		expect(samples.counts).toEqual({
			samples: 4,
			channels: 6,
			gates: 6,
			groups: 1,
			annotations: 1,
		});
		expect(samples.capabilities).toMatchObject({
			workspaceEdits: false,
			coordinateSpace: "stored-f32",
			displayTransformsApplied: false,
			analyses: ["gate-counts", "population-medians"],
		});
		const sampleItems = samples.items as Result[];
		expect(sampleItems.map((item) => item.id)).toEqual(["s-main", "s-empty", "s-ghost", "s-bad"]);
		expect(sampleItems[0]).toMatchObject({
			file: { sha256: h.main.sha256, basename: "main.fcs", size: h.main.size },
			channelCount: 3,
			gateCount: 5,
		});
		expect(sampleItems[1]).toMatchObject({ channelCount: 1, gateCount: 0 });
		// Numeric rows never carry provenance stamps.
		expect(sampleItems.some((item) => "author" in item || "modified" in item)).toBe(false);
		// Guarded gate page: correct identity passes and order is preserved.
		const paged = (await h.service.invoke(
			"inspect_workspace",
			inspectArgs(study, {
				view: "gates",
				sampleId: "s-main",
				offset: 1,
				limit: 2,
			}),
		)) as Result;
		expect(paged).toMatchObject({
			view: "gates",
			sampleId: "s-main",
			offset: 1,
			total: 5,
			nextOffset: 3,
		});
		expect((paged.items as Result[]).map((item) => item.id)).toEqual(["g-bright", "g-quadA"]);
		// Unfiltered gates view spans every sample; the final page reports a null offset.
		const allGates = (await h.service.invoke(
			"inspect_workspace",
			inspectArgs(study, { view: "gates", offset: 5 }),
		)) as Result;
		expect(allGates).toMatchObject({ total: 6, sampleId: null, nextOffset: null });
		expect((allGates.items as Result[]).map((item) => item.id)).toEqual(["g-cd3"]);
		const stamped = (await h.service.invoke(
			"inspect_workspace",
			inspectArgs(study, {
				view: "gates",
				sampleId: "s-main",
			}),
		)) as Result;
		const gateItems = stamped.items as Result[];
		const edge = gateItems.find((item) => item.id === "g-edge") as Result;
		// A declared human stamp is the only source of the finalization flag.
		expect(edge).toMatchObject({
			name: "Edge",
			parentId: null,
			type: "rectangle",
			humanFinalized: true,
		});
		const andA = gateItems.find((item) => item.id === "g-andA") as Result;
		// Boolean structure surfaces as type/dependency shape; the source keeps the refs.
		expect(andA).toMatchObject({
			parentId: "g-all",
			type: "boolean",
			dimensionCount: 0,
			dependencyCount: 3,
			humanFinalized: false,
		});
		// Channels view carries the display-only transform untouched; plain channels are null.
		const channels = (await h.service.invoke(
			"inspect_workspace",
			inspectArgs(study, {
				view: "channels",
				sampleId: "s-main",
			}),
		)) as Result;
		expect(channels).toMatchObject({ view: "channels", sampleId: "s-main", total: 3 });
		const channelItems = channels.items as Result[];
		expect(channelItems.map((item) => item.id)).toEqual(["c-apc", "c-pe", "c-fsc"]);
		expect(channelItems.find((item) => item.id === "c-pe")).toMatchObject({
			name: "PE",
			transform: { type: "biex", pos: 4.42 },
		});
		expect(channelItems.find((item) => item.id === "c-apc")).toMatchObject({
			name: "APC",
			transform: null,
		});
		expect(channelItems.some((item) => "author" in item)).toBe(false);
		// View/filter argument rules.
		await expect(
			h.service.invoke("inspect_workspace", {
				path: "study.flowatlas.json",
				view: "samples",
				sampleId: "s-main",
			}),
		).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		await expect(
			h.service.invoke("inspect_workspace", { path: "study.flowatlas.json", view: "channels" }),
		).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		await expect(
			h.service.invoke(
				"inspect_workspace",
				inspectArgs(study, { view: "channels", sampleId: "nope" }),
			),
		).rejects.toMatchObject({ code: "WORKSPACE_SAMPLE_NOT_FOUND" });
		// Guard rejections on inspection itself.
		await expect(
			h.service.invoke("inspect_workspace", { path: "study.flowatlas.json", expectedRevision: 8 }),
		).rejects.toMatchObject({ code: "WORKSPACE_REVISION_CONFLICT" });
		await expect(
			h.service.invoke("inspect_workspace", {
				path: "study.flowatlas.json",
				expectedSha256: "0".repeat(64),
			}),
		).rejects.toMatchObject({ code: "WORKSPACE_HASH_MISMATCH" });
		// Pages stay inside the response budget and inputs remain untouched.
		expect(Buffer.byteLength(JSON.stringify(samples))).toBeLessThanOrEqual(256 * 1024);
		expect(await readdir(join(h.root, ".flow-atlas", "inputs"))).toEqual(h.inputs);
	});

	it("counts nested Boolean gates through reordered model channel IDs with full lineage", async () => {
		const request = countArgs(study, "s-main");
		const submitted = (await h.service.invoke("start_workspace_gate_counts", request)) as Job;
		const job = await terminal(h.service, submitted.jobId);
		expect(job).toMatchObject({
			state: "succeeded",
			kind: "workspace-gate-counts",
			progressUnit: "events",
			processedEvents: 16,
			totalEvents: 16,
			inputContext: { inputSpace: "stored" },
		});
		const receipt = (await h.service.invoke("get_receipt", { jobId: submitted.jobId })) as Result;
		// Recipe is the original workspace request, byte for byte.
		expect(receipt.recipe).toEqual(request);
		expect(receipt.recipeHash).toMatch(HEX64);
		// The workspace binding pins the admitted document snapshot and FCS source.
		expect(receipt.workspace).toMatchObject({
			profile: "workspace-stored-f32-admitted-snapshot-v1",
			semantics: "admitted-snapshot",
			document: {
				path: "study.flowatlas.json",
				id: "ws-study",
				revision: 7,
				sha256: study.sha256,
				bytes: study.bytes,
			},
			sample: { id: "s-main", sha256: h.main.sha256, bytes: h.main.size },
			coordinateSpace: "stored-f32",
			displayTransformsApplied: false,
		});
		const bindingChannels = (receipt.workspace as { channels: Result[] }).channels;
		// Only used channel IDs are bound, in first-use order (g-bright visits c-pe first);
		// the never-gated c-fsc stays out of the computation binding.
		expect(bindingChannels.map((channel) => channel.id)).toEqual(["c-pe", "c-apc"]);
		expect(bindingChannels.map((channel) => channel.name)).toEqual(["PE", "APC"]);
		// The compiled recipe speaks FCS names and the FCS snapshot identity.
		const compiled = receipt.compiledRecipe as Result;
		expect(compiled).toMatchObject({ sampleId: h.main.sha256, coordinateSpace: "stored-f32" });
		expect(JSON.stringify(compiled)).not.toContain("c-pe");
		expect(receipt.analysisRecipeHash).toMatch(HEX64);
		// The analysis recipe hash equals a plain single-sample job over the compiled args.
		const replay = (await h.service.invoke("start_gate_counts", structuredClone(compiled))) as Job;
		expect((await terminal(h.service, replay.jobId)).state).toBe("succeeded");
		expect(
			((await h.service.invoke("get_receipt", { jobId: replay.jobId })) as Result).recipeHash,
		).toBe(receipt.analysisRecipeHash);
		// Summary is the underlying count table; hand-enumerated, order-independent.
		const summary = receipt.summary as { counts: Result[]; rootCount: number; eventCount: number };
		expect(summary).toMatchObject({ rootCount: 16, eventCount: 16, coordinateSpace: "stored-f32" });
		expect(new Set(summary.counts.map((count) => count.id))).toEqual(
			new Set(["g-all", "g-quadA", "g-edge", "g-andA", "g-bright"]),
		);
		for (const [id, expected] of Object.entries(COUNTS))
			expect(summary.counts.find((count) => count.id === id)).toMatchObject(expected);
		expect(summary.counts.find((count) => count.id === "g-andA")).toMatchObject({
			frequencyOfParent: 2 / 16,
		});
		expect(receipt.input).toMatchObject({ sha256: h.main.sha256 });
		expect(receipt.output).toEqual(job.result);
		// The artifact carries the workspace recipe, compiled recipe and binding.
		const counts = await artifact(h.root, job, /counts\.json$/);
		expect(counts).toMatchObject({
			schemaVersion: 1,
			jobId: submitted.jobId,
			recipe: request,
			recipeHash: receipt.recipeHash,
		});
		expect(counts.compiledRecipe).toEqual(compiled);
		expect(counts.workspace).toEqual(receipt.workspace);
		expect(counts.summary).toEqual(summary);
		mainCountJobId = submitted.jobId;
		mainCountReceipt = receipt;
	});

	it("computes median rank endpoints for workspace populations and the root", async () => {
		const run = async (request: MedianArgs) =>
			terminal(
				h.service,
				((await h.service.invoke("start_workspace_population_medians", request)) as Job).jobId,
			);
		// Root over all 16 rows: PE ranks 7/8 land on 2/3, APC on 2/3 (even, distinct).
		const rootRequest = medianArgs(study, "s-main", null, ["c-pe", "c-apc"]);
		const rootJob = await run(rootRequest);
		expect(rootJob).toMatchObject({
			state: "succeeded",
			kind: "workspace-population-medians",
			progressUnit: "event-visits",
			processedEvents: 64,
			totalEvents: 64,
		});
		expect((await artifact(h.root, rootJob, /medians\.json$/)).summary).toEqual({
			populationId: null,
			coordinateSpace: "stored-f32",
			channels: ["PE", "APC"],
			count: 16,
			lower: [2, 2],
			upper: [3, 3],
			ranks: { indexBase: 0, lower: 7, upper: 8 },
			diagnostics: {
				algorithm: "gpu-radix256-exact-rank-v1",
				passCount: 4,
				precision: "exact-f32-rank-endpoints",
				scope: "selected-population-not-vendor-parity",
				zeroPolicy: "canonical-positive-zero",
				subnormalPolicy: "preserve-integer-bit-order",
				sourceRows: 16,
			},
			gateNumericalPolicy: null,
		});
		// Reversed target list with a gated even population: edge has 4 members; APC
		// endpoints -1/3 straddle PE's constant 3, proving order-following.
		const edgeJob = await run(medianArgs(study, "s-main", "g-edge", ["c-apc", "c-pe"]));
		expect(edgeJob.state).toBe("succeeded");
		expect(edgeJob.processedEvents).toBe(64);
		const edgeSummary = (await artifact(h.root, edgeJob, /medians\.json$/)).summary as Result;
		expect(edgeSummary).toMatchObject({
			populationId: "g-edge",
			channels: ["APC", "PE"],
			count: 4,
			lower: [-1, 3],
			upper: [3, 3],
			ranks: { indexBase: 0, lower: 1, upper: 2 },
		});
		expect(edgeSummary.gateNumericalPolicy).toMatch(/.+/);
		// Odd window (15 rows): root endpoints coincide at rank 7; 4x15 visits.
		const oddJob = await run(
			medianArgs(study, "s-main", null, ["c-pe"], { startEvent: 0, eventCount: 15 }),
		);
		expect(oddJob).toMatchObject({ state: "succeeded", processedEvents: 60, totalEvents: 60 });
		expect((await artifact(h.root, oddJob, /medians\.json$/)).summary).toMatchObject({
			count: 15,
			lower: [2],
			upper: [2],
			ranks: { indexBase: 0, lower: 7, upper: 7 },
		});
		// Polygon child: bright has 4 members with distinct APC endpoints 2/3.
		const brightJob = await run(medianArgs(study, "s-main", "g-bright", ["c-apc"]));
		expect(brightJob.state).toBe("succeeded");
		expect((await artifact(h.root, brightJob, /medians\.json$/)).summary).toMatchObject({
			populationId: "g-bright",
			channels: ["APC"],
			count: 4,
			lower: [2],
			upper: [3],
		});
		// Root medians on the gateless sample still work (1 row, single member).
		const tinyJob = await run(medianArgs(study, "s-empty", null, ["c-e"]));
		expect(tinyJob.state).toBe("succeeded");
		expect((await artifact(h.root, tinyJob, /medians\.json$/)).summary).toMatchObject({
			populationId: null,
			count: 1,
			lower: [0],
			upper: [0],
		});
	});

	it("leaves the workspace document and its stamps byte-identical after ordinary calls", async () => {
		const before = await readFile(join(h.root, "study.flowatlas.json"));
		await h.service.invoke("inspect_workspace", { path: "study.flowatlas.json", view: "gates" });
		await terminal(
			h.service,
			((await h.service.invoke("start_workspace_gate_counts", countArgs(study, "s-main"))) as Job)
				.jobId,
		);
		await terminal(
			h.service,
			(
				(await h.service.invoke(
					"start_workspace_population_medians",
					medianArgs(study, "s-main", "g-quadA", ["c-apc"]),
				)) as Job
			).jobId,
		);
		expect(await readFile(join(h.root, "study.flowatlas.json"))).toEqual(before);
		// Declared stamps survive untouched in the file bytes.
		expect(before.toString()).toContain('"author":"flowjo-user"');
	});

	it("rejects missing samples, unimported sources and identity mismatches before admission", async () => {
		const before = {
			runs: await readdir(join(h.root, ".flow-atlas", "runs")),
			outputs: await readdir(join(h.root, "outputs")),
		};
		// Unknown model sample ID.
		await expect(
			h.service.invoke("start_workspace_gate_counts", countArgs(study, "nope")),
		).rejects.toMatchObject({ code: "WORKSPACE_SAMPLE_NOT_FOUND" });
		// The root file exists but was never imported: reject without creating an input.
		const lateBytes = await readFile(join(h.root, "late.fcs"));
		const late = {
			sha256: createHash("sha256").update(lateBytes).digest("hex"),
			size: (await stat(join(h.root, "late.fcs"))).size,
		};
		const lateIdentity = await writeDoc(h.root, "late.flowatlas.json", lateDocument(late));
		await expect(
			h.service.invoke(
				"start_workspace_gate_counts",
				countArgs(lateIdentity, "s-late", { expectedRevision: 1 }),
			),
		).rejects.toMatchObject({ code: "WORKSPACE_SAMPLE_NOT_IMPORTED" });
		expect(await readdir(join(h.root, ".flow-atlas", "inputs"))).toEqual(h.inputs);
		// Use root medians for this gateless sample so only its declared size is invalid.
		await expect(
			h.service.invoke(
				"start_workspace_population_medians",
				medianArgs(study, "s-bad", null, ["c-b"]),
			),
		).rejects.toMatchObject({ code: "WORKSPACE_SAMPLE_MISMATCH" });
		// A used gate channel name missing from the FCS snapshot.
		await expect(
			h.service.invoke("start_workspace_gate_counts", countArgs(study, "s-ghost")),
		).rejects.toMatchObject({ code: "WORKSPACE_CHANNEL_MISMATCH" });
		// Unknown target channel ID.
		await expect(
			h.service.invoke(
				"start_workspace_population_medians",
				medianArgs(study, "s-main", "g-quadA", ["c-ghost"]),
			),
		).rejects.toMatchObject({ code: "WORKSPACE_CHANNEL_NOT_FOUND" });
		// Unknown population reference and a gateless sample.
		await expect(
			h.service.invoke(
				"start_workspace_population_medians",
				medianArgs(study, "s-main", "ghost", ["c-pe"]),
			),
		).rejects.toMatchObject({ code: "WORKSPACE_GATE_NOT_FOUND" });
		await expect(
			h.service.invoke("start_workspace_gate_counts", countArgs(study, "s-empty")),
		).rejects.toMatchObject({ code: "WORKSPACE_NO_GATES" });
		// A document the model validator rejects keeps its own typed error.
		const broken = JSON.parse(JSON.stringify(buildDocument(h))) as {
			gates: Array<{ geometry: { type: string } }>;
		};
		broken.gates[0].geometry.type = "ellipse";
		await writeFile(join(h.root, "broken.flowatlas.json"), JSON.stringify(broken));
		await expect(
			h.service.invoke(
				"start_workspace_gate_counts",
				countArgs({ ...study, path: "broken.flowatlas.json" }, "s-main"),
			),
		).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
		// Admission rejected everything: no run records, outputs or staging.
		expect(await readdir(join(h.root, ".flow-atlas", "runs"))).toEqual(before.runs);
		expect(await readdir(join(h.root, "outputs"))).toEqual(before.outputs);
		expect(await readdir(join(h.root, ".flow-atlas", "tmp"))).toEqual([]);
	});

	it("rejects stale revisions and manually edited documents before admission", async () => {
		const before = await readdir(join(h.root, ".flow-atlas", "runs"));
		// Same content, wrong revision expectation.
		await expect(
			h.service.invoke(
				"start_workspace_gate_counts",
				countArgs(study, "s-main", { expectedRevision: 6 }),
			),
		).rejects.toMatchObject({ code: "WORKSPACE_REVISION_CONFLICT" });
		// Manual edit keeps the declared revision but changes the bytes: stale hash.
		const edited = buildDocument(h);
		(edited.groups[0] as { name: string }).name = "Renamed";
		await writeFile(join(h.root, "edited.flowatlas.json"), JSON.stringify(edited));
		await expect(
			h.service.invoke(
				"start_workspace_gate_counts",
				countArgs({ ...study, path: "edited.flowatlas.json" }, "s-main"),
			),
		).rejects.toMatchObject({ code: "WORKSPACE_HASH_MISMATCH" });
		expect(await readdir(join(h.root, ".flow-atlas", "runs"))).toEqual(before);
	});

	it("computes from the admitted snapshot when the document changes after capture", async () => {
		// Fresh second document at revision 1 pointing at the same managed snapshots.
		const identity = await writeDoc(h.root, "second.flowatlas.json", buildDocument(h, 1));
		const request = {
			path: "second.flowatlas.json",
			expectedRevision: 1,
			expectedSha256: identity.sha256,
			sampleId: "s-main",
			coordinateSpace: "stored-f32" as const,
		};
		// Deterministic wrapper barrier: the document is captured before the queued run
		// record is persisted, so mutating the file inside the saveRun spy happens strictly
		// after capture and strictly before execution — no timing race.
		const original = ArtifactStore.prototype.saveRun;
		const spy = vi.spyOn(ArtifactStore.prototype, "saveRun").mockImplementation(async function (
			this: ArtifactStore,
			id,
			record,
		) {
			const result = original.call(this, id, record);
			if ((record as { phase?: string }).phase === "queued") {
				// Mutate after capture: revision bump plus a geometry change that would
				// move every quadA member if the run re-read the document.
				const mutated = buildDocument(h, 2, [5, 5]);
				await writeFile(join(this.root, "second.flowatlas.json"), JSON.stringify(mutated));
			}
			return result;
		});
		try {
			const submitted = (await h.service.invoke("start_workspace_gate_counts", request)) as Job;
			const job = await terminal(h.service, submitted.jobId);
			expect(job.state).toBe("succeeded");
			const receipt = (await h.service.invoke("get_receipt", {
				jobId: submitted.jobId,
			})) as Result;
			// The admitted snapshot binding and compiled recipe are unchanged...
			expect(receipt.workspace).toMatchObject({
				profile: "workspace-stored-f32-admitted-snapshot-v1",
				document: { revision: 1, sha256: identity.sha256 },
			});
			expect(receipt.compiledRecipe).toMatchObject({ sampleId: h.main.sha256 });
			expect(JSON.stringify((receipt.compiledRecipe as { gates: Result[] }).gates)).not.toContain(
				"[5,5]",
			);
			// ...and the counts are the original hand numbers, not the mutated geometry's.
			const summary = receipt.summary as { counts: Result[] };
			expect(summary.counts.find((count) => count.id === "g-quadA")).toMatchObject({
				count: 10,
				parentCount: 16,
			});
			// The current document on disk keeps the mutation: nothing was rewritten.
			const current = JSON.parse(
				await readFile(join(h.root, "second.flowatlas.json"), "utf8"),
			) as Result;
			expect(current.revision).toBe(2);
		} finally {
			spy.mockRestore();
		}
	});

	it("refuses workspace writes, edit fields and path escapes through the strict schema", async () => {
		const before = await readdir(join(h.root, ".flow-atlas", "runs"));
		const base = countArgs(study, "s-main");
		for (const extra of [
			{ operations: [] },
			{ transaction: { expectedRevision: 7, agentId: "x", operations: [] } },
			{ agentEdit: { agentId: "x", revision: 1 } },
			{ view: "samples" },
			{ transforms: [{ channel: "PE" }] },
			{ inputSpace: "linearized" },
			{ samplePath: "main.fcs" },
		]) {
			await expect(
				h.service.invoke("start_workspace_gate_counts", { ...base, ...extra }),
			).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		}
		await expect(
			h.service.invoke("inspect_workspace", { path: "../outside.flowatlas.json" }),
		).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
		await expect(
			h.service.invoke(
				"start_workspace_gate_counts",
				countArgs({ ...study, path: "../outside.flowatlas.json" }, "s-main"),
			),
		).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
		expect(await readdir(join(h.root, ".flow-atlas", "runs"))).toEqual(before);
	});

	it("executes through MCP and serves the identical receipt after a host restart", async () => {
		const scoped = await harness("workspace-mcp");
		const document = await writeDoc(scoped.root, "study.flowatlas.json", buildDocument(scoped));
		const token = "workspace-analysis-mcp-token";
		const studio = await createStudioServer({ service: scoped.service, token });
		const client = new Client({ name: "workspace-analysis-test", version: "1" });
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
			const page = await call("inspect_workspace", {
				path: "study.flowatlas.json",
				view: "gates",
				sampleId: "s-main",
			});
			expect(page).toMatchObject({ view: "gates", sampleId: "s-main", total: 5 });
			const request = countArgs(document, "s-main");
			started = await call("start_workspace_gate_counts", request as unknown as Result);
			job = await terminal(scoped.service, started.jobId as string);
			expect(job.state).toBe("succeeded");
			receipt = await call("get_receipt", { jobId: started.jobId });
			expect(receipt).toMatchObject({
				operation: "workspace-gate-counts",
				state: "succeeded",
				recipe: request,
			});
			expect(receipt.summary).toEqual((await artifact(scoped.root, job, /counts\.json$/)).summary);
			const rejected = await client.callTool({
				name: "start_workspace_gate_counts",
				arguments: countArgs(document, "nope") as unknown as Result,
			});
			expect(rejected.isError).toBe(true);
			expect(
				JSON.parse((rejected.content as Array<{ text: string }>)[0]?.text ?? "null"),
			).toMatchObject({ error: { code: "WORKSPACE_SAMPLE_NOT_FOUND" } });
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
			kind: "workspace-gate-counts",
			live: false,
			phase: "complete",
			processedEvents: 16,
			totalEvents: 16,
			result: job.result,
		});
	}, 30_000);

	it("serves the durable main workspace receipt after the host restarts", async () => {
		await mainService.close();
		const restored = await createAnalysisService({ root: h.root, maxChunkBytes: 1024 });
		services.push(restored);
		expect(await restored.invoke("get_receipt", { jobId: mainCountJobId })).toEqual(
			mainCountReceipt,
		);
		expect(await restored.invoke("get_job", { jobId: mainCountJobId })).toMatchObject({
			state: "succeeded",
			kind: "workspace-gate-counts",
			live: false,
			phase: "complete",
		});
	});
});
