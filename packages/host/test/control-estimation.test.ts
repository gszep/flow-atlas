import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFcs } from "@flow-atlas/fcs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAnalysisService } from "../src/analysis.js";
import type { AnalysisService, OperationArgs } from "../src/contracts.js";
import { createStudioServer } from "../src/server.js";

type Request = OperationArgs<"start_control_estimation">;
type Result = Record<string, unknown>;
type Job = Result & {
	jobId: string;
	result?: { path: string; compensationId: string; sha256: string; receiptPath: string };
};
let root: string, service: AnalysisService;
let studio: Awaited<ReturnType<typeof createStudioServer>> | undefined;
let serial = 0;
const originals = new Map<string, Buffer>();

// Independent FCS encoder: rows are expressed in physical A/B/Select order,
// then permuted and gain-scaled for each acquisition file.
function synthetic(
	rows: number[][],
	names = ["A", "B", "Select"],
	gains = names.map(() => 1),
	rowNames = ["A", "B", "Select"],
): Uint8Array {
	const kw: Record<string, string> = {
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
	names.forEach((name, index) => {
		const prefix = `$P${index + 1}`;
		Object.assign(kw, {
			[`${prefix}B`]: "32",
			[`${prefix}N`]: name,
			[`${prefix}R`]: "4096",
			[`${prefix}E`]: "0,0",
			[`${prefix}G`]: `${gains[index]}`,
		});
	});
	const values = rows.flatMap((row) =>
		names.map((name, index) => (row[rowNames.indexOf(name)] as number) * (gains[index] as number)),
	);
	let begin = 0,
		text = new Uint8Array();
	for (;;) {
		kw.$BEGINDATA = `${begin}`;
		kw.$ENDDATA = `${begin + values.length * 4 - 1}`;
		text = new TextEncoder().encode(`|${Object.entries(kw).flat().join("|")}|`);
		const next = 58 + text.length;
		if (next === begin) break;
		begin = next;
	}
	const bytes = new Uint8Array(begin + values.length * 4);
	bytes.set(
		new TextEncoder().encode(
			`FCS3.1    ${[58, begin - 1, begin, bytes.length - 1, 0, 0].map((n) => `${n}`.padStart(8)).join("")}`,
		),
	);
	bytes.set(text, 58);
	const view = new DataView(bytes.buffer);
	values.forEach((value, index) => {
		view.setFloat32(begin + index * 4, value, true);
	});
	return bytes;
}
async function imported(
	rows: number[][],
	names?: string[],
	gains?: number[],
	rowNames?: string[],
): Promise<string> {
	const path = `control-${serial++}.fcs`,
		bytes = synthetic(rows, names, gains, rowNames);
	await writeFile(join(root, path), bytes);
	const result = (await service.invoke("import_fcs", { path })) as Result;
	const id = result.sampleId as string;
	expect(id).toBe(createHash("sha256").update(bytes).digest("hex"));
	originals.set(id, Buffer.from(bytes));
	// Subsequent computation must use the immutable snapshot, not this source path.
	await writeFile(join(root, path), "source replaced after import");
	return id;
}
function population(a: number, b: number): number[][] {
	return [
		[999, 999, 1],
		[a - 2, b - 2, 1],
		[-999, -999, 0],
		[999, 999, 2],
		[a + 2, b + 2, 1],
		[-999, -999, 1],
	];
}
async function recipe(linearized = false): Promise<Request> {
	const names = ["B", "Select", "A"];
	const sampleId = await imported(
		[
			[-2, 2.75, 7],
			[3, -3, 8],
		],
		undefined,
		linearized ? [2, 4, 1] : undefined,
	);
	const ids: string[] = [];
	for (const [index, [a, b]] of [
		[18, 18],
		[10, 20],
		[8, 14],
		[4, 6],
	].entries()) {
		ids.push(
			await imported(
				population(a as number, b as number),
				names,
				linearized ? [2 ** (index + 1), 1, 2 ** (index + 2)] : undefined,
			),
		);
	}
	const spec = (index: number) => ({
		sampleId: ids[index] as string,
		startEvent: 1,
		eventCount: 4,
		selection: [{ channel: "Select", min: 1, max: 1 }],
	});
	return {
		sampleId,
		channels: ["B", "A"],
		controls: [
			{ primaryDetector: "A", positive: spec(0), negative: spec(1) },
			{ primaryDetector: "B", positive: spec(2), negative: spec(3) },
		],
		minEvents: 2,
		...(linearized ? { inputSpace: "linearized" as const } : {}),
	};
}
async function completed(jobId: string): Promise<Job> {
	let job: Job = { jobId };
	await vi.waitFor(
		async () => {
			job = (await service.invoke("get_job", { jobId })) as Job;
			expect(["succeeded", "failed", "cancelled"]).toContain(job.state);
		},
		{ timeout: 20_000, interval: 10 },
	);
	return job;
}
async function estimate(request: Request): Promise<Job> {
	const submission = (await service.invoke("start_control_estimation", request)) as Job;
	return completed(submission.jobId);
}
async function receipt(job: Job): Promise<Result> {
	return (await service.invoke("get_receipt", { jobId: job.jobId })) as Result;
}
async function noArtifacts(job: Job): Promise<void> {
	expect(job.result).toBeUndefined();
	expect(await readdir(join(root, "outputs"))).not.toContain(job.jobId);
	expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
}
function maxError(actual: number[], expected: number[]): number {
	expect(actual).toHaveLength(expected.length);
	return Math.max(...actual.map((value, index) => Math.abs(value - (expected[index] as number))));
}
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "flow-atlas-controls-"));
	service = await createAnalysisService({ root, maxChunkBytes: 1024 });
});
afterAll(async () => {
	await studio?.close();
	await service?.close();
	if (root) await rm(root, { recursive: true, force: true });
});

describe("control-derived compensation through the host", () => {
	it("rejects a target temporal detector even when controls treat it as an ordinary gain-scaled channel", async () => {
		const sampleId = await imported([[1, 1, 1]], undefined, [2, 1, 1]);
		const positive = await imported([[2, 1, 1]], undefined, [2, 1, 1]);
		const negative = await imported([[0, 1, 1]], undefined, [2, 1, 1]);
		const before = await readdir(join(root, ".flow-atlas", "runs"));
		await expect(
			service.invoke("start_control_estimation", {
				sampleId,
				inputSpace: "linearized",
				acquisition: { timeChannel: "A", timeStep: 0.5 },
				channels: ["A"],
				controls: [
					{
						primaryDetector: "A",
						positive: { sampleId: positive },
						negative: { sampleId: negative },
					},
				],
				minEvents: 1,
			}),
		).rejects.toMatchObject({ code: "INVALID_CONTROL_CHANNEL" });
		expect(await readdir(join(root, ".flow-atlas", "runs"))).toEqual(before);
	});

	it.each([1e100, 1e-100])(
		"rejects nonrepresentable F32 separation %s before admission",
		async (minPrimarySeparation) => {
			const request = { ...(await recipe()), minPrimarySeparation };
			const before = await readdir(join(root, ".flow-atlas", "runs"));
			await expect(service.invoke("start_control_estimation", request)).rejects.toMatchObject({
				code: "INVALID_CONTROL_POLICY",
			});
			expect(await readdir(join(root, ".flow-atlas", "runs"))).toEqual(before);
		},
	);

	it.each([
		{ endpoint: 1.0000001192092896, omitted: false },
		{ endpoint: 1.0000000031710769e-30, omitted: true },
	])(
		"fails oversized expanded receipts before publication and serves failure over MCP (omitted=$omitted)",
		async ({ endpoint, omitted }) => {
			const channels = Array.from({ length: 32 }, (_, index) => `D${index}`);
			const timeChannel = "T".repeat(50_000);
			const targetNames = [...channels, timeChannel],
				sourceNames = [...channels, "Time"];
			const sampleId = await imported(
				[[...channels.map(() => endpoint), 0]],
				targetNames,
				undefined,
				targetNames,
			);
			const controls: Request["controls"] = [];
			for (const [index, primaryDetector] of channels.entries()) {
				const negative = await imported(
					[[...channels.map(() => endpoint), index * 2]],
					sourceNames,
					undefined,
					sourceNames,
				);
				const positive = await imported(
					[
						[
							...channels.map((_, detector) => (detector === index ? endpoint * 2 : endpoint)),
							index * 2 + 1,
						],
					],
					sourceNames,
					undefined,
					sourceNames,
				);
				controls.push({
					primaryDetector,
					positive: { sampleId: positive },
					negative: { sampleId: negative },
				});
			}
			expect(
				new Set(
					controls.flatMap((control) => [control.positive.sampleId, control.negative.sampleId]),
				).size,
			).toBe(64);
			const request: Request = {
				sampleId,
				channels,
				controls,
				inputSpace: "linearized",
				acquisition: { timeChannel },
				minEvents: 1,
			};
			expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(64 * 1024);
			studio ??= await createStudioServer({ service, token: "control-receipt-test-token" });
			const client = new Client({ name: "control-receipt-test", version: "1" });
			try {
				await client.connect(
					new StreamableHTTPClientTransport(new URL(`${studio.url}/mcp`), {
						requestInit: { headers: { authorization: "Bearer control-receipt-test-token" } },
					}),
				);
				const submitted = await client.callTool({
					name: "start_control_estimation",
					arguments: request,
				});
				expect(submitted.isError).not.toBe(true);
				const submission = JSON.parse(
					(submitted.content as Array<{ text: string }>)[0]?.text as string,
				) as Job;
				const job = await completed(submission.jobId);
				expect(job).toMatchObject({ state: "failed", error: { code: "RESPONSE_TOO_LARGE" } });
				await noArtifacts(job);
				const response = await client.callTool({
					name: "get_receipt",
					arguments: { jobId: job.jobId },
				});
				expect(response.isError).not.toBe(true);
				const text = (response.content as Array<{ text: string }>)[0]?.text as string;
				expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024);
				const evidence = JSON.parse(text) as Result;
				expect(evidence).toMatchObject({
					operation: "control-estimation",
					state: "failed",
					jobId: job.jobId,
					recipe: request,
					error: { code: "RESPONSE_TOO_LARGE" },
				});
				if (omitted) {
					expect(evidence.completedPopulationCount).toBe(64);
					expect(evidence.evidenceOmitted).toEqual(expect.any(String));
					expect(evidence.populations).toBeUndefined();
					expect(evidence.candidate).toBeUndefined();
				} else {
					expect(evidence.populations).toHaveLength(64);
					expect(evidence.evidenceOmitted).toBeUndefined();
				}
				expect(evidence.output).toBeUndefined();
			} finally {
				await client.close();
			}
		},
		30_000,
	);

	it.each([false, true])(
		"estimates even selected medians and exports independent numerics (linearized=%s)",
		async (linearized) => {
			const request = await recipe(linearized),
				job = await estimate(request);
			expect(job.state).toBe("succeeded");
			const output = job.result as NonNullable<Job["result"]>;
			const encoded = await readFile(join(root, output.path));
			expect(createHash("sha256").update(encoded).digest("hex")).toBe(output.sha256);
			const matrix = JSON.parse(encoded.toString()) as Result;
			expect(matrix).toMatchObject({
				compensationId: output.compensationId,
				channels: ["B", "A"],
				matrix: [1, 0.5, -0.25, 1],
			});
			const evidence = await receipt(job);
			expect(evidence).toMatchObject({
				operation: "control-estimation",
				state: "succeeded",
				input: { sha256: request.sampleId, role: "application-target-metadata" },
				recipe: request,
				distinctPopulationCount: 4,
				eventVisits: 64,
				progressUnit: "event-visits",
				estimationDiagnostics: { source: "gpu-computation", minEvents: 2 },
			});
			expect(JSON.parse(await readFile(join(root, output.receiptPath), "utf8"))).toEqual(evidence);
			const populations = evidence.populations as Result[];
			expect(
				populations.map((p) => ({
					sampleId: p.sampleId,
					count: p.count,
					startEvent: p.startEvent,
					eventCount: p.eventCount,
					lower: p.lower,
					upper: p.upper,
				})),
			).toEqual([
				{
					sampleId: request.controls[0]?.positive.sampleId,
					count: 2,
					startEvent: 1,
					eventCount: 4,
					lower: [16, 16],
					upper: [20, 20],
				},
				{
					sampleId: request.controls[0]?.negative.sampleId,
					count: 2,
					startEvent: 1,
					eventCount: 4,
					lower: [18, 8],
					upper: [22, 12],
				},
				{
					sampleId: request.controls[1]?.positive.sampleId,
					count: 2,
					startEvent: 1,
					eventCount: 4,
					lower: [12, 6],
					upper: [16, 10],
				},
				{
					sampleId: request.controls[1]?.negative.sampleId,
					count: 2,
					startEvent: 1,
					eventCount: 4,
					lower: [4, 2],
					upper: [8, 6],
				},
			]);
			expect(evidence.controls).toEqual(
				request.controls.map((control, index) => ({
					primaryDetector: control.primaryDetector,
					positiveId: populations[index * 2]?.populationId,
					negativeId: populations[index * 2 + 1]?.populationId,
				})),
			);
			if (linearized)
				expect(new Set(populations.map((p) => (p.acquisition as Result).parameterHash)).size).toBe(
					4,
				);
			else expect(populations.map((p) => p.acquisition)).toEqual([null, null, null, null]);
			const preview = (await service.invoke("preview_fcs", {
				sampleId: request.sampleId,
				compensationId: output.compensationId,
				channels: ["A", "B", "Select"],
			})) as Result;
			expect(maxError((preview.rows as number[][]).flat(), [-3, 2, 7, 4, -2, 8])).toBeLessThan(
				1e-5,
			);
			const exportSubmission = (await service.invoke("start_fcs_export", {
				sampleId: request.sampleId,
				compensationId: output.compensationId,
			})) as Job;
			const exported = await completed(exportSubmission.jobId);
			expect(exported.state).toBe("succeeded");
			const bytes = await readFile(
				join(root, (exported.result as NonNullable<Job["result"]>).path),
			);
			const fcs = readFcs(
				bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
			);
			expect(maxError(Array.from(fcs.data), [-3, 2, 7, 4, -2, 8])).toBeLessThan(1e-5);
			expect(await receipt(exported)).toMatchObject({
				recipe: { compensationId: output.compensationId },
				compensation: {
					channels: ["B", "A"],
					matrix: [1, 0.5, -0.25, 1],
					estimation: {
						jobId: job.jobId,
						recipeHash: evidence.recipeHash,
						receiptPath: output.receiptPath,
					},
				},
			});
			const unchanged = await Promise.all(
				[...originals].map(async ([id, original]) =>
					(await readFile(join(root, ".flow-atlas", "inputs", `${id}.fcs`))).equals(original),
				),
			);
			expect(unchanged.every(Boolean)).toBe(true);
		},
		30_000,
	);

	it.each(["support", "empty", "nonfinite", "singular", "separation"])(
		"rejects %s without publishing matrix artifacts",
		async (kind) => {
			const request = await recipe();
			const first = request.controls[0] as Request["controls"][number];
			if (kind === "support") request.minEvents = 3;
			if (kind === "empty") first.positive.selection = [{ channel: "Select", min: 3, max: null }];
			if (kind === "nonfinite")
				first.positive = {
					sampleId: await imported([
						[Number.NaN, 1, 1],
						[2, 3, 1],
					]),
				};
			if (kind === "singular") {
				const positive = await imported([
						[8, 8, 1],
						[12, 12, 1],
					]),
					negative = await imported([
						[0, 0, 1],
						[0, 0, 1],
					]);
				request.controls = ["A", "B"].map((primaryDetector) => ({
					primaryDetector,
					positive: { sampleId: positive },
					negative: { sampleId: negative },
				}));
			}
			if (kind === "separation") request.minPrimarySeparation = 9;
			const job = await estimate(request);
			const code =
				kind === "empty"
					? "EMPTY_CONTROL_SELECTION"
					: kind === "nonfinite"
						? "NONFINITE_CONTROL_TARGET"
						: kind === "singular"
							? "NUMERICAL_REJECTION"
							: "CONTROL_ESTIMATION_REJECTED";
			expect(job).toMatchObject({ state: "failed", error: { code } });
			expect(await receipt(job)).toMatchObject({
				state: "failed",
				operation: "control-estimation",
				recipe: request,
				error: { code },
			});
			await noArtifacts(job);
		},
	);

	it("cancels an admitted estimation without publishing a matrix", async () => {
		const request = await recipe();
		// Many small chunks leave a deterministic cancellation window without a large fixture.
		const large = await imported(Array.from({ length: 8192 }, (_, i) => [18 + (i % 2), 18, 1]));
		(request.controls[0] as Request["controls"][number]).positive = { sampleId: large };
		const submission = (await service.invoke("start_control_estimation", request)) as Job;
		expect(await service.invoke("cancel_job", { jobId: submission.jobId })).toMatchObject({
			accepted: true,
		});
		const job = await completed(submission.jobId);
		expect(job.state).toBe("cancelled");
		expect(await receipt(job)).toMatchObject({
			state: "cancelled",
			operation: "control-estimation",
			recipe: request,
		});
		await noArtifacts(job);
	});
});
