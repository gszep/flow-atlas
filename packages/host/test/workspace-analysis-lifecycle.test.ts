import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFcs } from "@flow-atlas/fcs";
import { validateWorkspace, type WorkspaceDocument } from "@flow-atlas/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnalysisService } from "../src/analysis.js";
import { ArtifactStore, digest } from "../src/artifact-store.js";
import type { AnalysisService, OperationArgs } from "../src/contracts.js";
import * as gateRunner from "../src/gate-counts.js";
import type { WorkspaceBinding } from "../src/workspace-analysis.js";

type Job = {
	jobId: string;
	state: string;
	result?: { path: string; sha256: string; receiptPath: string };
};
const roots: string[] = [];
const services: AnalysisService[] = [];
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

async function serviceAt(root: string) {
	const service = await createAnalysisService({ root, maxChunkBytes: 1024 });
	services.push(service);
	return service;
}

async function fixture(eventCount: number) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "flow-atlas-workspace-lifecycle-")));
	roots.push(root);
	const service = await serviceAt(root);
	const parts: Uint8Array[] = [];
	// Real FCS encoding/import. These tests target lifecycle, not parser independence.
	for await (const part of writeFcs(
		{
			version: "FCS3.1",
			eventCount,
			keywords: {},
			channels: [{ index: 1, name: "X", bits: 32, range: 1024, amplification: [0, 0], gain: 1 }],
		},
		[Float32Array.from({ length: eventCount }, (_, i) => i + 1)],
	))
		parts.push(part);
	const sourceBytes = Buffer.concat(parts);
	await writeFile(join(root, "source.fcs"), sourceBytes);
	const { sampleId } = (await service.invoke("import_fcs", { path: "source.fcs" })) as {
		sampleId: string;
	};
	const geometry = { type: "rectangle", min: [1], max: [null] } as const;
	const model: WorkspaceDocument = {
		schemaVersion: 1,
		id: "workspace-lifecycle",
		revision: 7,
		samples: [
			{
				id: "model-sample",
				file: { sha256: sampleId, basename: "source.fcs", size: sourceBytes.length },
				channels: [{ id: "model-x", name: "X", transform: { type: "linear", gain: 2 } }],
			},
		],
		gates: [
			{
				id: "model-all",
				sampleId: "model-sample",
				name: "All positive X",
				parentId: null,
				dimensions: ["model-x"],
				geometry: { type: geometry.type, min: [...geometry.min], max: [...geometry.max] },
				author: "fixture-human",
				modified: "2026-10-18T00:00:00Z",
			},
		],
		groups: [],
		annotations: [
			{
				id: "note",
				gateId: "model-all",
				text: "Human-authored fixture annotation",
				author: "fixture-human",
				modified: "2026-10-18T00:00:00Z",
			},
		],
	};
	validateWorkspace(model);
	const documentBytes = Buffer.from(`${JSON.stringify(model, null, 2)}\n`);
	const path = "workspace.flowatlas.json";
	await writeFile(join(root, path), documentBytes);
	const request: OperationArgs<"start_workspace_gate_counts"> = {
		path,
		expectedRevision: model.revision,
		expectedSha256: sha256(documentBytes),
		sampleId: "model-sample",
		coordinateSpace: "stored-f32",
	};
	const binding: WorkspaceBinding = {
		profile: "workspace-stored-f32-admitted-snapshot-v1",
		semantics: "admitted-snapshot",
		document: {
			path,
			id: model.id,
			revision: model.revision,
			sha256: request.expectedSha256,
			bytes: documentBytes.length,
		},
		sample: { id: "model-sample", sha256: sampleId, bytes: sourceBytes.length },
		channels: [{ id: "model-x", name: "X" }],
		coordinateSpace: "stored-f32",
		displayTransformsApplied: false,
	};
	const compiled = {
		sampleId,
		coordinateSpace: "stored-f32",
		gates: [
			{
				id: "model-all",
				name: "All positive X",
				parentId: null,
				dimensions: ["X"],
				geometry,
			},
		],
	};
	return { root, service, request, binding, compiled, documentBytes, sourceBytes, sampleId };
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

function expectLineage(
	receipt: Record<string, unknown>,
	operation: string,
	binding: WorkspaceBinding,
	request: unknown,
	compiledRecipe: unknown,
) {
	expect(receipt.workspace).toEqual(binding);
	expect(receipt.recipe).toEqual(request);
	expect(receipt.compiledRecipe).toEqual(compiledRecipe);
	expect(receipt.analysisRecipeHash).toMatch(/^[a-f0-9]{64}$/);
	expect(receipt.recipeHash).toBe(
		digest({ operation, workspace: binding, analysisRecipeHash: receipt.analysisRecipeHash }),
	);
}

afterEach(async () => {
	try {
		for (const service of services.splice(0)) await service.close();
	} finally {
		vi.restoreAllMocks();
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	}
});

describe("workspace analysis cancellation and publication recovery", () => {
	it("retains admitted and compiled lineage after real workspace count cancellation without touching the document", async () => {
		const { root, service, request, binding, compiled, documentBytes, sourceBytes, sampleId } =
			await fixture(600);
		const admitted = Promise.withResolvers<string>();
		const original = gateRunner.runGateCounts;
		let cancellation: Promise<void> | undefined;
		let cancellationReply: unknown;
		let cancellationError: unknown;
		let boundaryCount = 0;
		vi.spyOn(gateRunner, "runGateCounts").mockImplementation(async (...args) => {
			const jobId = await admitted.promise;
			const [kernels, store, resolved, maxBinding, chunkBytes, signal, progress] = args;
			return original(kernels, store, resolved, maxBinding, chunkBytes, signal, (count) => {
				progress(count);
				if (!cancellation) {
					boundaryCount = count;
					cancellation = service.invoke("cancel_job", { jobId }).then(
						(reply) => {
							cancellationReply = reply;
						},
						(error: unknown) => {
							cancellationError = error;
						},
					);
				}
			});
		});
		try {
			const { jobId } = (await service.invoke("start_workspace_gate_counts", request)) as Job;
			admitted.resolve(jobId);
			const job = await terminal(service, jobId);
			await cancellation;
			expect(cancellation).toBeDefined();
			expect(cancellationError).toBeUndefined();
			expect(cancellationReply).toMatchObject({ jobId, accepted: true });
			expect(boundaryCount).toBe(256); // 1024-byte decoded ceiling / one F32 channel.
			expect(job).toMatchObject({
				state: "cancelled",
				kind: "workspace-gate-counts",
				processedEvents: 256,
				totalEvents: 600,
				progressUnit: "events",
				request,
				workspace: binding,
			});
			expect(job.result).toBeUndefined();
			const receipt = (await service.invoke("get_receipt", { jobId })) as Record<string, unknown>;
			expect(receipt).toMatchObject({
				operation: "workspace-gate-counts",
				state: "cancelled",
				processedEvents: 256,
				progressUnit: "events",
			});
			expectLineage(receipt, "workspace-gate-counts", binding, request, compiled);
			expect(receipt.summary).toBeUndefined();
			expect(receipt.output).toBeUndefined();
			expect(await readdir(join(root, "outputs"))).toEqual([]);
			expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
			expect(await readFile(join(root, request.path))).toEqual(documentBytes);
			expect(await readFile(join(root, ".flow-atlas", "inputs", `${sampleId}.fcs`))).toEqual(
				sourceBytes,
			);
			const persisted = JSON.parse(
				await readFile(join(root, ".flow-atlas", "runs", `${jobId}.json`), "utf8"),
			);
			expect(persisted.receipt).toEqual(json(receipt));
		} finally {
			admitted.resolve("");
			await cancellation;
		}
	}, 30_000);

	it("recovers a published workspace median after terminal persistence fails and the original document is deleted", async () => {
		const {
			root,
			service,
			request: countRequest,
			binding,
			compiled,
			documentBytes,
		} = await fixture(4);
		const request: OperationArgs<"start_workspace_population_medians"> = {
			...countRequest,
			populationId: "model-all",
			channels: ["model-x"],
		};
		const compiledRecipe = { ...compiled, populationId: "model-all", channels: ["X"] };
		const original = ArtifactStore.prototype.saveRun;
		const injected = Object.assign(new Error("injected workspace terminal record failure"), {
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
				status.kind === "workspace-population-medians" &&
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
		const { jobId } = (await service.invoke("start_workspace_population_medians", request)) as Job;
		const job = await terminal(service, jobId);
		expect(failures).toBe(1);
		expect(job).toMatchObject({
			state: "succeeded",
			kind: "workspace-population-medians",
			progressUnit: "event-visits",
			processedEvents: 16,
			totalEvents: 16,
			workspace: binding,
			warnings: [{ code: "EIO", message: injected.message }],
		});
		const receipt = (await service.invoke("get_receipt", { jobId })) as Record<string, unknown>;
		expectLineage(receipt, "workspace-population-medians", binding, request, compiledRecipe);
		expect(receipt).toMatchObject({
			operation: "workspace-population-medians",
			state: "succeeded",
			eventVisits: 16,
			progressUnit: "event-visits",
			summary: { populationId: "model-all", channels: ["X"], count: 4, lower: [2], upper: [3] },
		});
		expect(publishedAtFailure).toEqual(json(receipt));
		const output = job.result as NonNullable<Job["result"]>;
		const bytes = await readFile(join(root, output.path));
		expect(sha256(bytes)).toBe(output.sha256);
		const artifact = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
		expectLineage(artifact, "workspace-population-medians", binding, request, compiledRecipe);
		expect(artifact.summary).toEqual(receipt.summary);
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
		expect(await readFile(join(root, request.path))).toEqual(documentBytes);
		const stale = JSON.parse(
			await readFile(join(root, ".flow-atlas", "runs", `${jobId}.json`), "utf8"),
		);
		expect(stale.state).toBe("running");
		save.mockRestore();
		// Only the test deletes the source document, after checking byte-for-byte nonmutation.
		await rm(join(root, request.path));
		await service.close();
		const restarted = await serviceAt(root);
		expect(await restarted.invoke("get_receipt", { jobId })).toEqual(json(receipt));
		expect(await restarted.invoke("get_job", { jobId })).toMatchObject({
			state: "succeeded",
			kind: "workspace-population-medians",
			live: false,
			phase: "complete",
			progressUnit: "event-visits",
			processedEvents: 16,
			totalEvents: 16,
			request,
			workspace: binding,
			result: output,
		});
	}, 30_000);
});
