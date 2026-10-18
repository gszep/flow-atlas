import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHeader } from "@flow-atlas/fcs";
import { validateWorkspace, type WorkspaceDocument } from "@flow-atlas/model";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnalysisService } from "../src/analysis.js";
import { digest } from "../src/artifact-store.js";
import type { AnalysisService, OperationArgs } from "../src/contracts.js";
import { createStudioServer } from "../src/server.js";

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

const HEX64 = /^[a-f0-9]{64}$/;
const OPT_IN = "nearest-f32-compiled-v1" as const;
const STRICT = "strict-f32-v1" as const;
// Compiled minus original for the decimal bounds, cross-checked against the independent
// F32 decision study (Math.fround is the profile definition, the literals are facts).
const FROUND_01 = Math.fround(0.1);
const DELTA_01 = FROUND_01 - 0.1; // 1.4901161138336505e-09, positive
const POLY_DOUBLE = 1.0000000000000002;
const DELTA_POLY = 1 - POLY_DOUBLE; // -2.220446049250313e-16, negative

const roots: string[] = [];
const services: AnalysisService[] = [];

// Independent FCS 3.1 encoder: little-endian $DATATYPE F rows behind a "|" keyword section.
// Every fixture passes through it before writeFile and asserts an FCS 3.1 header before
// import. Stored event values are F32: 0.1 encodes as Math.fround(0.1) exactly.
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

// Fixture rows are [PE, APC, FSC] in physical column order.
const ROWS: Record<string, number[][]> = {
	upper: [
		[0.1, 7, 1],
		[0.05, 7, 2],
	],
	nest: [
		[0.1, 7, 1],
		[0, 7, 2],
	],
	poly: [
		[1, 1, 3],
		[1.5, 1, 4],
	],
	median: [
		[-0, 7, 5],
		[2 ** -149, 7, 6],
		[2 ** -148, 7, 7],
		[5, 7, 8],
	],
	reject: [[1, 1, 9]],
};

type SampleKey = keyof typeof ROWS;
const SAMPLE_IDS: SampleKey[] = ["upper", "nest", "poly", "median", "reject"];

function channels(prefix: string) {
	return [
		{ id: `${prefix}-pe`, name: "PE" },
		{ id: `${prefix}-apc`, name: "APC" },
	];
}

// Hand-derived original CPU references (real-number arithmetic over the strict recipe,
// never executed on the GPU): documented constants the compiled results are contrasted with.
const ORIGINAL_UPPER_COUNT = 1; // 0.05 <= 0.1; stored 0.1f = 0.10000000149011611938... > 0.1
const ORIGINAL_POLY_COUNT = 1; // only the interior point; the tie point lies left of 1.000...02

function buildDocument(
	files: Record<SampleKey, { sha256: string; size: number }>,
): WorkspaceDocument {
	const rect = (
		id: string,
		sampleId: string,
		name: string,
		parentId: string | null,
		dimension: string,
		min: Array<number | null>,
		max: Array<number | null>,
	) => ({
		id,
		sampleId,
		name,
		parentId,
		dimensions: [dimension],
		geometry: { type: "rectangle", min, max },
	});
	const document: WorkspaceDocument = {
		schemaVersion: 1,
		id: "ws-profile",
		revision: 5,
		agentEdit: { agentId: "mochi-the-kitty", revision: 2 },
		samples: SAMPLE_IDS.map((key, index) => ({
			id: `s-${key}`,
			file: { sha256: files[key].sha256, basename: `${key}.fcs`, size: files[key].size },
			channels: channels(`c${index}`),
		})),
		gates: [
			{
				...rect("g-dec", "s-upper", "Decimal", null, "c0-pe", [null], [0.1]),
				author: "flowjo-user",
				modified: "2026-01-01T00:00:00Z",
			},
			rect("g-parent", "s-nest", "Parent", null, "c1-pe", [null], [0.1]),
			rect("g-child", "s-nest", "Child", "g-parent", "c1-pe", [null], [0]),
			{
				id: "g-not",
				sampleId: "s-nest",
				name: "NotChild",
				parentId: "g-parent",
				dimensions: [],
				geometry: { type: "boolean", op: "not", refs: ["g-child"] },
			},
			{
				id: "g-poly",
				sampleId: "s-poly",
				name: "Poly",
				parentId: null,
				dimensions: ["c2-pe", "c2-apc"],
				geometry: {
					type: "polygon",
					vertices: [
						[POLY_DOUBLE, 0],
						[2, 0],
						[2, 2],
						[POLY_DOUBLE, 2],
					],
				},
			},
			rect("g-nonneg", "s-median", "Nonneg", null, "c3-pe", [0], [null]),
			rect("g-overflow", "s-reject", "Overflow", null, "c4-pe", [null], [1e39]),
			rect("g-underflow", "s-reject", "Underflow", null, "c4-pe", [1e-46], [null]),
			rect("g-subnormal", "s-reject", "Subnormal", null, "c4-pe", [5e-39], [null]),
			{
				id: "g-thin",
				sampleId: "s-reject",
				name: "Thin",
				parentId: null,
				dimensions: ["c4-pe", "c4-apc"],
				geometry: {
					type: "polygon",
					vertices: [
						[1, 0],
						[POLY_DOUBLE, 0],
						[1, 2],
					],
				},
			},
		],
		groups: [],
		annotations: [],
	};
	validateWorkspace(document);
	return document;
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

type Context = {
	root: string;
	service: AnalysisService;
	identity: { sha256: string };
	files: Record<SampleKey, { sha256: string; size: number }>;
};

async function context(): Promise<Context> {
	const root = await mkdtemp(join(tmpdir(), "flow-atlas-coordinate-profile-"));
	roots.push(root);
	const service = await createAnalysisService({ root, maxChunkBytes: 1024 });
	services.push(service);
	const files = {} as Record<SampleKey, { sha256: string; size: number }>;
	for (const key of SAMPLE_IDS) {
		const bytes = encodeFcs(ROWS[key], ["PE", "APC", "FSC"]);
		const header = readHeader(
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		);
		expect(header.version).toBe("FCS3.1");
		await writeFile(join(root, `${key}.fcs`), bytes);
		const imported = (await service.invoke("import_fcs", { path: `${key}.fcs` })) as Result;
		files[key] = { sha256: imported.sampleId as string, size: bytes.byteLength };
	}
	await writeFile(join(root, "study.flowatlas.json"), JSON.stringify(buildDocument(files)));
	const document = await readFile(join(root, "study.flowatlas.json"));
	return {
		root,
		service,
		identity: { sha256: createHash("sha256").update(document).digest("hex") },
		files,
	};
}

function countArgs(
	identity: { sha256: string },
	sampleId: string,
	profile?: typeof OPT_IN | typeof STRICT,
): CountArgs {
	return {
		path: "study.flowatlas.json",
		expectedRevision: 5,
		expectedSha256: identity.sha256,
		sampleId,
		coordinateSpace: "stored-f32",
		...(profile === undefined ? {} : { coordinateProfile: profile }),
	};
}

function medianArgs(
	identity: { sha256: string },
	sampleId: string,
	populationId: string | null,
	channels: string[],
	profile?: typeof OPT_IN | typeof STRICT,
): MedianArgs {
	return { ...countArgs(identity, sampleId, profile), populationId, channels };
}

afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("explicit F32 coordinate profiles through workspace analyses", () => {
	it("keeps strict admission unchanged: omitted and explicit profiles reject decimal bounds", async () => {
		const { root, service, identity } = await context();
		const before = await readdir(join(root, ".flow-atlas", "runs"));
		for (const request of [
			countArgs(identity, "s-upper"),
			countArgs(identity, "s-upper", STRICT),
		]) {
			await expect(service.invoke("start_workspace_gate_counts", request)).rejects.toMatchObject({
				code: "INVALID_GATE_RECIPE",
			});
		}
		// Unknown profiles never reach the recipe at all.
		await expect(
			service.invoke("start_workspace_gate_counts", {
				...countArgs(identity, "s-upper", OPT_IN),
				coordinateProfile: "nearest-f32-v0",
			}),
		).rejects.toMatchObject({ code: "INVALID_PARAMS" });
		expect(await readdir(join(root, ".flow-atlas", "runs"))).toEqual(before);
	});

	it("compiles an opt-in decimal upper bound with a full lossy report and hash lineage", async () => {
		const { root, service, identity, files } = await context();
		const beforeDoc = await readFile(join(root, "study.flowatlas.json"));
		const request = countArgs(identity, "s-upper", OPT_IN);
		const submitted = (await service.invoke("start_workspace_gate_counts", request)) as Job;
		const job = await terminal(service, submitted.jobId);
		expect(job).toMatchObject({
			state: "succeeded",
			kind: "workspace-gate-counts",
			processedEvents: 2,
			totalEvents: 2,
		});
		const receipt = (await service.invoke("get_receipt", { jobId: submitted.jobId })) as Result;
		// The original request and compiled recipe are distinct recipes.
		expect(receipt.recipe).toEqual(request);
		const compiled = receipt.compiledRecipe as Result;
		expect(compiled).toMatchObject({ sampleId: files.upper.sha256 });
		expect(JSON.stringify(compiled)).not.toContain("coordinateProfile");
		expect(
			(compiled as { gates: Array<{ geometry: { max: number[] } }> }).gates[0].geometry.max,
		).toEqual([FROUND_01]);
		// Full compilation report with the authorized profile facts.
		const report = receipt.coordinateCompilation as Result;
		expect(report).toMatchObject({
			profile: OPT_IN,
			semantics: "new-compiled-recipe",
			rounding: "binary32-nearest-ties-to-even",
			membershipPreservation: "not-guaranteed",
			topologyPreservation: "not-guaranteed",
			topologyValidation: "limited-structural-checks",
			lossy: true,
			changedCoordinateCount: 1,
			maxAbsoluteError: DELTA_01,
		});
		expect(report.originalRecipeHash).toMatch(HEX64);
		expect(report.compiledRecipeHash).toMatch(HEX64);
		expect(report.originalRecipeHash).not.toBe(report.compiledRecipeHash);
		// Hashes are canonical-JSON recipe hashes, never the raw document SHA. The compiled
		// report hash is exactly the hash of the receipt's compiled recipe object.
		expect(report.originalRecipeHash).not.toBe(identity.sha256);
		expect(report.compiledRecipeHash).toBe(digest(receipt.compiledRecipe));
		const gateReport = (report.gates as Result[])[0] as Result;
		expect(gateReport).toMatchObject({
			id: "g-dec",
			originalGeometry: { type: "rectangle", min: [null], max: [0.1] },
			compiledGeometry: { type: "rectangle", min: [null], max: [FROUND_01] },
			deltas: { type: "rectangle", min: [null], max: [DELTA_01] },
		});
		// Hand-derived original CPU reference: the strict recipe admits one event. The
		// compiled GPU run admits both, the documented NEW semantics.
		expect(ORIGINAL_UPPER_COUNT).toBe(1);
		const summary = receipt.summary as { counts: Result[]; rootCount: number };
		expect(summary.rootCount).toBe(2);
		expect(summary.counts[0]).toMatchObject({
			id: "g-dec",
			count: 2,
			parentCount: 2,
			frequencyOfParent: 1,
			frequencyOfRoot: 1,
		});
		// The binding marker carries the report hash and participates in the outer hash.
		const marker = (receipt.workspace as { coordinateCompilation?: Result }).coordinateCompilation;
		expect(marker).toMatchObject({
			profile: OPT_IN,
			semantics: "new-compiled-recipe",
			lossy: true,
		});
		expect(marker?.reportSha256).toBe(digest(report));
		expect(receipt.recipeHash).toBe(
			digest({
				operation: "workspace-gate-counts",
				workspace: receipt.workspace,
				analysisRecipeHash: receipt.analysisRecipeHash,
			}),
		);
		expect(receipt.input).toMatchObject({ sha256: files.upper.sha256 });
		// The artifact mirrors recipe, compiled recipe, binding and report.
		const output = job.result as NonNullable<Job["result"]>;
		const artifactBytes = await readFile(join(root, output.path));
		expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(output.sha256);
		const artifact = JSON.parse(artifactBytes.toString()) as Result;
		expect(artifact.recipe).toEqual(request);
		expect(artifact.compiledRecipe).toEqual(compiled);
		expect(artifact.workspace).toEqual(receipt.workspace);
		expect(artifact.coordinateCompilation).toEqual(report);
		expect(artifact.summary).toEqual(summary);
		// The document and its declared stamps are byte-identical after the opt-in run.
		const afterDoc = await readFile(join(root, "study.flowatlas.json"));
		expect(afterDoc.equals(beforeDoc)).toBe(true);
		expect(beforeDoc.toString()).toContain('"author":"flowjo-user"');
	});

	it("propagates a compiled parent bound through nested child and NOT membership", async () => {
		const { service, identity } = await context();
		const submitted = (await service.invoke(
			"start_workspace_gate_counts",
			countArgs(identity, "s-nest", OPT_IN),
		)) as Job;
		const job = await terminal(service, submitted.jobId);
		expect(job.state).toBe("succeeded");
		const receipt = (await service.invoke("get_receipt", { jobId: submitted.jobId })) as Result;
		const report = receipt.coordinateCompilation as Result;
		expect(report).toMatchObject({
			lossy: true,
			changedCoordinateCount: 1,
			maxAbsoluteError: DELTA_01,
		});
		const gateReports = report.gates as Result[];
		expect(gateReports.map((gate) => gate.id)).toEqual(["g-parent", "g-child", "g-not"]);
		expect((gateReports[1] as Result).deltas).toMatchObject({ min: [null], max: [0] });
		expect((gateReports[2] as Result).deltas).toBeNull();
		// Hand enumeration, original CPU reference: parent {0}=1, child {0}=1, NOT=0.
		// Compiled NEW semantics: the 0.1f event joins the parent only.
		const counts = new Map(
			(
				(receipt.summary as { counts: Result[] }).counts as Array<{
					id: string;
					count: number;
					parentCount: number;
					frequencyOfParent: number | null;
					frequencyOfRoot: number | null;
				}>
			).map((row) => [row.id, row]),
		);
		expect(counts.get("g-parent")).toMatchObject({
			count: 2,
			parentCount: 2,
			frequencyOfParent: 1,
			frequencyOfRoot: 1,
		});
		// Child membership is unchanged at 1 while its parent denominator grows 1 -> 2.
		expect(counts.get("g-child")).toMatchObject({
			count: 1,
			parentCount: 2,
			frequencyOfParent: 0.5,
		});
		// The complement within the parent moves 0 -> 1 (frequency 0 -> 0.5).
		expect(counts.get("g-not")).toMatchObject({
			count: 1,
			parentCount: 2,
			frequencyOfParent: 0.5,
		});
	});

	it("keeps the even-odd rule for a nearest-shifted polygon edge tie", async () => {
		const { service, identity } = await context();
		const submitted = (await service.invoke(
			"start_workspace_gate_counts",
			countArgs(identity, "s-poly", OPT_IN),
		)) as Job;
		const job = await terminal(service, submitted.jobId);
		expect(job.state).toBe("succeeded");
		const receipt = (await service.invoke("get_receipt", { jobId: submitted.jobId })) as Result;
		const report = receipt.coordinateCompilation as Result;
		expect(report).toMatchObject({
			lossy: true,
			changedCoordinateCount: 2,
			maxAbsoluteError: Math.abs(DELTA_POLY),
		});
		const gateReport = (report.gates as Result[])[0] as Result;
		expect(gateReport).toMatchObject({
			id: "g-poly",
			compiledGeometry: {
				type: "polygon",
				vertices: [
					[1, 0],
					[2, 0],
					[2, 2],
					[1, 2],
				],
			},
			deltas: {
				type: "polygon",
				vertices: [
					[DELTA_POLY, 0],
					[0, 0],
					[0, 0],
					[DELTA_POLY, 0],
				],
			},
		});
		// Hand-derived original CPU reference: only the interior point (1.5,1) lies inside
		// the uncompiled polygon; the tie point sits left of the 1.000...02 edge.
		expect(ORIGINAL_POLY_COUNT).toBe(1);
		// Compiled NEW semantics: the event exactly on the compiled left edge is INCLUDED by
		// the current even-odd ray rule (left ties included), not blanket-outside.
		const summary = receipt.summary as { counts: Result[] };
		expect(summary.counts[0]).toMatchObject({ id: "g-poly", count: 2, parentCount: 2 });
	});

	it("preserves selected subnormal rank endpoints and agrees with strict medians", async () => {
		const { root, service, identity } = await context();
		// Gate bounds are zero/unbounded; PE event data include -0 and subnormals.
		const optIn = await terminal(
			service,
			(
				(await service.invoke(
					"start_workspace_population_medians",
					medianArgs(identity, "s-median", "g-nonneg", ["c3-pe"], OPT_IN),
				)) as Job
			).jobId,
		);
		expect(optIn).toMatchObject({
			state: "succeeded",
			kind: "workspace-population-medians",
			progressUnit: "event-visits",
			processedEvents: 16,
			totalEvents: 16,
		});
		const optInReceipt = (await service.invoke("get_receipt", { jobId: optIn.jobId })) as Result;
		// Exact F32 coordinates compile to themselves: report present, not lossy.
		const report = optInReceipt.coordinateCompilation as Result;
		expect(report).toMatchObject({
			profile: OPT_IN,
			lossy: false,
			changedCoordinateCount: 0,
			maxAbsoluteError: 0,
		});
		expect(report.originalRecipeHash).toBe(report.compiledRecipeHash);
		expect(((report.gates as Result[])[0] as Result).deltas).toMatchObject({
			min: [0],
			max: [null],
		});
		// Canonical order 0, 2^-149, 2^-148, 5: even count ranks 1/2 are the two subnormals.
		// Flushing these selected subnormals or averaging the endpoints would change the result.
		// This does not establish bitwise preservation of every event or the sign of zero.
		expect(optInReceipt.summary).toMatchObject({
			populationId: "g-nonneg",
			coordinateSpace: "stored-f32",
			channels: ["PE"],
			count: 4,
			lower: [2 ** -149],
			upper: [2 ** -148],
			ranks: { indexBase: 0, lower: 1, upper: 2 },
		});
		// The strict profile over the identical recipe produces identical endpoints and no
		// report at all; this checks endpoint agreement, not every input event's bits.
		const strict = await terminal(
			service,
			(
				(await service.invoke(
					"start_workspace_population_medians",
					medianArgs(identity, "s-median", "g-nonneg", ["c3-pe"]),
				)) as Job
			).jobId,
		);
		expect(strict.state).toBe("succeeded");
		const strictReceipt = (await service.invoke("get_receipt", { jobId: strict.jobId })) as Result;
		expect(strictReceipt.summary).toEqual(optInReceipt.summary);
		expect(strictReceipt.coordinateCompilation).toBeUndefined();
		expect(strictReceipt.workspace).not.toHaveProperty("coordinateCompilation");
		const strictOutput = strict.result as NonNullable<Job["result"]>;
		const strictArtifact = JSON.parse(
			(await readFile(join(root, strictOutput.path))).toString(),
		) as Result;
		expect(strictArtifact.coordinateCompilation).toBeUndefined();
		expect(strictArtifact.workspace).not.toHaveProperty("coordinateCompilation");
	});

	it("rejects overflow, underflow, compiled subnormals and newly collapsed polygons before staging", async () => {
		const { root, service, identity, files } = await context();
		const before = {
			runs: await readdir(join(root, ".flow-atlas", "runs")),
			outputs: await readdir(join(root, "outputs")),
		};
		const reject = async (sampleId: string, gateId: string, reason: string) => {
			await expect(
				service.invoke("start_workspace_gate_counts", countArgs(identity, sampleId, OPT_IN)),
			).rejects.toMatchObject({
				code: "COORDINATE_COMPILATION_REJECTED",
				details: { profile: OPT_IN, gateId, reason },
			});
		};
		// g-overflow is the first recipe gate: its rejection fires before later gates.
		await reject("s-reject", "g-overflow", "overflow");
		// One pathological gate per request isolates each reason.
		const isolate = async (gate: "g-underflow" | "g-subnormal" | "g-thin", reason: string) => {
			const doc = JSON.parse(JSON.stringify(buildDocument(files))) as WorkspaceDocument;
			doc.gates = doc.gates.filter(
				(candidate) => candidate.sampleId !== "s-reject" || candidate.id === gate,
			);
			await writeFile(join(root, "isolate.flowatlas.json"), JSON.stringify(doc));
			const bytes = await readFile(join(root, "isolate.flowatlas.json"));
			await expect(
				service.invoke("start_workspace_gate_counts", {
					path: "isolate.flowatlas.json",
					expectedRevision: 5,
					expectedSha256: createHash("sha256").update(bytes).digest("hex"),
					sampleId: "s-reject",
					coordinateSpace: "stored-f32",
					coordinateProfile: OPT_IN,
				}),
			).rejects.toMatchObject({
				code: "COORDINATE_COMPILATION_REJECTED",
				details: { gateId: gate, reason },
			});
		};
		await isolate("g-underflow", "underflow-to-zero");
		await isolate("g-subnormal", "compiled-subnormal");
		await isolate("g-thin", "introduced-zero-span-polygon");
		expect(await readdir(join(root, ".flow-atlas", "runs"))).toEqual(before.runs);
		expect(await readdir(join(root, "outputs"))).toEqual(before.outputs);
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
	});

	it("executes an opt-in count over MCP and serves the identical report after a restart", async () => {
		const scoped = await context();
		const token = "coordinate-profile-mcp-token";
		const studio = await createStudioServer({ service: scoped.service, token });
		const client = new Client({ name: "coordinate-profile-test", version: "1" });
		let receipt: Result = {};
		let jobId = "";
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
			const request = countArgs(scoped.identity, "s-upper", OPT_IN) as unknown as Result;
			const started = await call("start_workspace_gate_counts", request);
			jobId = started.jobId as string;
			const job = await terminal(scoped.service, jobId);
			expect(job.state).toBe("succeeded");
			receipt = await call("get_receipt", { jobId });
			expect(receipt).toMatchObject({
				operation: "workspace-gate-counts",
				state: "succeeded",
				recipe: request,
			});
			expect((receipt.coordinateCompilation as Result).profile).toBe(OPT_IN);
			expect(
				(receipt.workspace as { coordinateCompilation?: Result }).coordinateCompilation,
			).toMatchObject({
				profile: OPT_IN,
				lossy: true,
			});
			const rejected = await client.callTool({
				name: "start_workspace_gate_counts",
				arguments: countArgs(scoped.identity, "s-upper") as unknown as Result,
			});
			expect(rejected.isError).toBe(true);
			expect(
				JSON.parse((rejected.content as Array<{ text: string }>)[0]?.text ?? "null"),
			).toMatchObject({ error: { code: "INVALID_GATE_RECIPE" } });
		} finally {
			await client.close();
			await studio.close();
		}
		await scoped.service.close();
		// A restarted host serves the identical opt-in lineage without re-running.
		const restored = await createAnalysisService({ root: scoped.root, maxChunkBytes: 1024 });
		services.push(restored);
		expect(await restored.invoke("get_receipt", { jobId })).toEqual(receipt);
		expect(await restored.invoke("get_job", { jobId })).toMatchObject({
			state: "succeeded",
			kind: "workspace-gate-counts",
			live: false,
			phase: "complete",
		});
		const restoredReport = (await restored.invoke("get_receipt", { jobId })) as Result;
		expect(restoredReport.coordinateCompilation).toEqual(receipt.coordinateCompilation);
		expect(restoredReport.recipeHash).toBe(receipt.recipeHash);
	});
});
