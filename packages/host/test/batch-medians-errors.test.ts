import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnalysisService } from "../src/analysis.js";
import { ArtifactStore } from "../src/artifact-store.js";
import type { AnalysisService, OperationArgs } from "../src/contracts.js";
import * as medianRunner from "../src/population-medians.js";

type Request = OperationArgs<"start_batch_population_medians">;
type Job = {
	jobId: string;
	state: string;
	result?: { path: string; sha256: string; receiptPath: string };
	warnings?: unknown[];
};
const roots: string[] = [];
const services: AnalysisService[] = [];
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

// Independent one-channel FCS 3.1 bytes. Each source has four finite X values;
// separate values make distinct immutable sample IDs without large fixtures.
function synthetic(first: number): Uint8Array {
	const keywords: Record<string, string> = {
		$BEGINANALYSIS: "0",
		$ENDANALYSIS: "0",
		$BEGINSTEXT: "0",
		$ENDSTEXT: "0",
		$BYTEORD: "1,2,3,4",
		$DATATYPE: "F",
		$MODE: "L",
		$NEXTDATA: "0",
		$PAR: "1",
		$TOT: "4",
		$P1B: "32",
		$P1N: "X",
		$P1R: "1024",
		$P1E: "0,0",
		$P1G: "1",
	};
	let begin = 0;
	let text = new Uint8Array();
	for (;;) {
		keywords.$BEGINDATA = `${begin}`;
		keywords.$ENDDATA = `${begin + 15}`;
		text = new TextEncoder().encode(`|${Object.entries(keywords).flat().join("|")}|`);
		const next = 58 + text.length;
		if (next === begin) break;
		begin = next;
	}
	const bytes = new Uint8Array(begin + 16);
	bytes.set(
		new TextEncoder().encode(
			`FCS3.1    ${[58, begin - 1, begin, bytes.length - 1, 0, 0]
				.map((value) => `${value}`.padStart(8))
				.join("")}`,
		),
	);
	bytes.set(text, 58);
	const view = new DataView(bytes.buffer);
	for (let row = 0; row < 4; row++) view.setFloat32(begin + row * 4, first + row, true);
	return bytes;
}

async function serviceAt(root: string): Promise<AnalysisService> {
	const service = await createAnalysisService({ root, maxChunkBytes: 1024 });
	services.push(service);
	return service;
}

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "flow-atlas-batch-median-errors-")));
	roots.push(root);
	const service = await serviceAt(root);
	const importSample = async (value: number) => {
		const bytes = synthetic(value);
		const name = `sample-${value}.fcs`;
		await writeFile(join(root, name), bytes);
		const { sampleId } = (await service.invoke("import_fcs", { path: name })) as {
			sampleId: string;
		};
		return { sampleId, bytes, path: join(root, ".flow-atlas", "inputs", `${sampleId}.fcs`) };
	};
	const first = await importSample(1);
	const second = await importSample(10);
	const request: Request = {
		coordinateSpace: "stored-f32",
		populationId: "all",
		channels: ["X"],
		samples: [first, second].map(({ sampleId }) => ({ sampleId })),
		gates: [
			{
				id: "all",
				name: "All finite X",
				parentId: null,
				dimensions: ["X"],
				geometry: { type: "rectangle", min: [null], max: [null] },
			},
		],
	};
	return { root, service, first, second, request };
}

async function terminal(service: AnalysisService, jobId: string): Promise<Job> {
	let job: Job = { jobId, state: "queued" };
	await vi.waitFor(
		async () => {
			job = (await service.invoke("get_job", { jobId })) as Job;
			expect(["succeeded", "failed", "cancelled"]).toContain(job.state);
		},
		{ timeout: 20_000, interval: 10 },
	);
	return job;
}

afterEach(async () => {
	try {
		for (const service of services.splice(0)) await service.close();
	} finally {
		vi.restoreAllMocks();
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	}
});

describe("batch median source failures and atomic publication", () => {
	it.each([
		["removal", "ENOENT"],
		["corruption", "INTEGRITY_ERROR"],
	] as const)(
		"retains later-source %s provenance after the first real four-pass summary",
		async (mode, code) => {
			const { root, service, first, second, request } = await fixture();
			const original = medianRunner.runPopulationMedians;
			let firstCompleted = false;
			const runner = vi
				.spyOn(medianRunner, "runPopulationMedians")
				.mockImplementation(async (...args) => {
					const result = await original(...args);
					if (args[2].request.sampleId === first.sampleId) {
						firstCompleted = true;
						// Both metadata bindings are admitted, but source 2 has not opened yet.
						if (mode === "removal") await rm(second.path);
						else {
							const damaged = second.bytes.slice();
							new DataView(damaged.buffer).setFloat32(damaged.length - 4, 99, true);
							await chmod(second.path, 0o600);
							await writeFile(second.path, damaged);
							await chmod(second.path, 0o400);
						}
					}
					return result;
				});
			const { jobId } = (await service.invoke("start_batch_population_medians", request)) as Job;
			const job = await terminal(service, jobId);
			expect(firstCompleted).toBe(true);
			expect(runner.mock.calls.map((args) => args[2].request.sampleId)).toEqual([
				first.sampleId,
				second.sampleId,
			]);
			const error = {
				code,
				details: {
					sampleIndex: 1,
					sampleId: second.sampleId,
					completedSamples: 1,
					phase: "run",
					cause: { code, message: expect.any(String) },
				},
			};
			expect(job).toMatchObject({
				state: "failed",
				kind: "batch-population-medians",
				progressUnit: "event-visits",
				processedEvents: 16,
				totalEvents: 32,
				error,
			});
			expect(job.result).toBeUndefined();
			const receipt = (await service.invoke("get_receipt", { jobId })) as Record<string, unknown>;
			expect(receipt).toMatchObject({
				operation: "batch-population-medians",
				state: "failed",
				progressUnit: "event-visits",
				processedEvents: 16,
				error,
			});
			expect(receipt.summary).toBeUndefined();
			expect(receipt.output).toBeUndefined();
			expect(await readdir(join(root, "outputs"))).toEqual([]);
			expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
			const record = JSON.parse(
				await readFile(join(root, ".flow-atlas", "runs", `${jobId}.json`), "utf8"),
			);
			expect(record.receipt).toEqual(json(receipt));
			await service.close();
			const restarted = await serviceAt(root);
			expect(await restarted.invoke("get_receipt", { jobId })).toEqual(json(receipt));
		},
		30_000,
	);

	it("cancels through cancel_job during the second source's pass 1 without publishing a partial table", async () => {
		const { root, service, first, second, request } = await fixture();
		const admitted = Promise.withResolvers<string>();
		const original = medianRunner.runPopulationMedians;
		const completed: string[] = [];
		let cancellation: Promise<void> | undefined;
		let cancellationReply: unknown;
		let cancellationError: unknown;
		vi.spyOn(medianRunner, "runPopulationMedians").mockImplementation(async (...args) => {
			// A public admission result supplies the ID; never inspect service internals.
			const jobId = await admitted.promise;
			const [kernels, store, resolved, maxBinding, chunkBytes, signal, progress] = args;
			const result = await original(
				kernels,
				store,
				resolved,
				maxBinding,
				chunkBytes,
				signal,
				(delta, pass) => {
					progress(delta, pass);
					if (resolved.request.sampleId === second.sampleId && pass === 1 && !cancellation) {
						// Real cancellation aborts synchronously; retain/drain its response promise.
						cancellation = service.invoke("cancel_job", { jobId }).then(
							(reply) => {
								cancellationReply = reply;
							},
							(error: unknown) => {
								cancellationError = error;
							},
						);
					}
				},
			);
			completed.push(resolved.request.sampleId);
			return result;
		});
		try {
			const { jobId } = (await service.invoke("start_batch_population_medians", request)) as Job;
			admitted.resolve(jobId);
			const job = await terminal(service, jobId);
			await cancellation;
			expect(cancellation).toBeDefined();
			expect(cancellationError).toBeUndefined();
			expect(cancellationReply).toMatchObject({ jobId, accepted: true });
			expect(completed).toEqual([first.sampleId]);
			// First source: 4*4 visits. Second: two completed four-row passes (0 and 1).
			expect(job).toMatchObject({
				state: "cancelled",
				kind: "batch-population-medians",
				processedEvents: 24,
				totalEvents: 32,
				progressUnit: "event-visits",
				progressDetail: {
					sampleIndex: 1,
					sampleId: second.sampleId,
					pass: 1,
					populationId: "all",
					sampleProcessedVisits: 8,
				},
			});
			expect(job.result).toBeUndefined();
			const receipt = (await service.invoke("get_receipt", { jobId })) as Record<string, unknown>;
			expect(receipt).toMatchObject({
				operation: "batch-population-medians",
				state: "cancelled",
				processedEvents: 24,
				progressUnit: "event-visits",
			});
			expect(receipt.summary).toBeUndefined();
			expect(receipt.output).toBeUndefined();
			expect(await readdir(join(root, "outputs"))).toEqual([]);
			expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
			expect(new Uint8Array(await readFile(first.path))).toEqual(first.bytes);
			expect(new Uint8Array(await readFile(second.path))).toEqual(second.bytes);
		} finally {
			admitted.resolve("");
			await cancellation;
		}
	}, 30_000);

	it("recovers the identical published median receipt after terminal saveRun fails", async () => {
		const { root, service, request } = await fixture();
		const original = ArtifactStore.prototype.saveRun;
		const injected = Object.assign(new Error("injected batch median terminal record failure"), {
			code: "EIO",
		});
		let failures = 0;
		let publishedAtFailure: unknown;
		const save = vi.spyOn(ArtifactStore.prototype, "saveRun").mockImplementation(async function (
			this: ArtifactStore,
			id,
			record,
		) {
			const status = record as { kind?: string; state?: string };
			if (
				this.root === root &&
				status.kind === "batch-population-medians" &&
				status.state === "succeeded"
			) {
				publishedAtFailure = JSON.parse(
					await readFile(join(root, "outputs", id, "receipt.json"), "utf8"),
				);
				failures++;
				throw injected;
			}
			return original.call(this, id, record);
		});
		const { jobId } = (await service.invoke("start_batch_population_medians", request)) as Job;
		const job = await terminal(service, jobId);
		expect(failures).toBe(1);
		expect(job).toMatchObject({
			state: "succeeded",
			kind: "batch-population-medians",
			processedEvents: 32,
			totalEvents: 32,
			progressUnit: "event-visits",
			warnings: [{ code: "EIO", message: injected.message }],
		});
		const receipt = await service.invoke("get_receipt", { jobId });
		expect(publishedAtFailure).toEqual(json(receipt));
		expect(receipt).toMatchObject({
			operation: "batch-population-medians",
			state: "succeeded",
			eventVisits: 32,
			progressUnit: "event-visits",
			summary: {
				rowCount: 2,
				rows: [
					{ sampleIndex: 0, channelIndex: 0, lower: 2, upper: 3 },
					{ sampleIndex: 1, channelIndex: 0, lower: 11, upper: 12 },
				],
			},
		});
		const output = job.result as NonNullable<Job["result"]>;
		const artifactBytes = await readFile(join(root, output.path));
		expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(output.sha256);
		expect((await readdir(join(root, "outputs", jobId))).sort()).toEqual([
			"medians.json",
			"receipt.json",
		]);
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
		const stale = JSON.parse(
			await readFile(join(root, ".flow-atlas", "runs", `${jobId}.json`), "utf8"),
		);
		expect(stale.state).toBe("running");
		save.mockRestore();
		await service.close();
		const restarted = await serviceAt(root);
		expect(await restarted.invoke("get_receipt", { jobId })).toEqual(json(receipt));
		expect(await restarted.invoke("get_job", { jobId })).toMatchObject({
			state: "succeeded",
			kind: "batch-population-medians",
			live: false,
			phase: "complete",
			processedEvents: 32,
			totalEvents: 32,
			progressUnit: "event-visits",
			result: output,
		});
	}, 30_000);
});
