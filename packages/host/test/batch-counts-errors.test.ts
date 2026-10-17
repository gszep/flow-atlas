import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFcs } from "@flow-atlas/fcs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnalysisService } from "../src/analysis.js";
import * as artifacts from "../src/artifact-store.js";
import { type BatchCountRequest, resolveBatchCounts } from "../src/batch-counts.js";
import { AnalysisError, type AnalysisService } from "../src/contracts.js";
import * as gateRunner from "../src/gate-counts.js";

const roots: string[] = [];
const services: AnalysisService[] = [];

function request(sampleIds: string[]): BatchCountRequest {
	return {
		coordinateSpace: "stored-f32",
		samples: sampleIds.map((sampleId) => ({ sampleId })),
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
}

async function serviceAt(root: string): Promise<AnalysisService> {
	const service = await createAnalysisService({ root, maxChunkBytes: 1024 });
	services.push(service);
	return service;
}

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "flow-atlas-batch-errors-")));
	roots.push(root);
	return { root, service: await serviceAt(root) };
}

// Production encoding is sufficient here: these tests exercise failure lifecycle,
// not independent numerical or FCS parser correctness. Four rows keep GPU work tiny.
async function importSample(root: string, service: AnalysisService, value: number) {
	const name = `sample-${value}.fcs`;
	const parts: Uint8Array[] = [];
	for await (const part of writeFcs(
		{
			version: "FCS3.1",
			eventCount: 4,
			keywords: {},
			channels: [{ index: 1, name: "X", bits: 32, range: 1024, amplification: [0, 0], gain: 1 }],
		},
		[new Float32Array([value, value, value, value])],
	)) {
		parts.push(part);
	}
	await writeFile(join(root, name), Buffer.concat(parts));
	const imported = (await service.invoke("import_fcs", { path: name })) as { sampleId: string };
	return imported.sampleId;
}

afterEach(async () => {
	try {
		for (const service of services.splice(0)) await service.close();
	} finally {
		vi.restoreAllMocks();
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	}
});

describe("batch count error provenance and admission cancellation", () => {
	it("reports CANCELLED when real uncached metadata verification is aborted, without admitting a job", async () => {
		const { root, service: importer } = await fixture();
		const sampleId = await importSample(root, importer, 1);
		await importer.close();
		// A fresh service has no cached metadata and must load the imported snapshot.
		const service = await serviceAt(root);
		const controller = new AbortController();
		const inputPath = join(root, ".flow-atlas", "inputs", `${sampleId}.fcs`);
		const original = artifacts.fileSource;
		let verificationEntered = false;
		vi.spyOn(artifacts, "fileSource").mockImplementation(async (path, allowedRoot) => {
			const opened = await original(path, allowedRoot);
			if (path !== inputPath) return opened;
			return {
				...opened,
				async verify(expected, signal) {
					verificationEntered = true;
					// Synchronize at the real verification boundary, not a timer race or
					// an already-aborted invoke. The real verifier throws the abort reason.
					controller.abort();
					return opened.verify(expected, signal);
				},
			};
		});
		await expect(
			service.invoke("start_batch_gate_counts", request([sampleId]), controller.signal),
		).rejects.toMatchObject({ code: "CANCELLED" });
		expect(verificationEntered).toBe(true);
		expect(await readdir(join(root, ".flow-atlas", "runs"))).toEqual([]);
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
		expect(await readdir(join(root, "outputs"))).toEqual([]);
	});

	it("retains later-source ENOENT and completedSamples after a real first-sample count, without publishing partial results", async () => {
		const { root, service } = await fixture();
		const first = await importSample(root, service, 1);
		const second = await importSample(root, service, 2);
		const secondPath = join(root, ".flow-atlas", "inputs", `${second}.fcs`);
		const original = gateRunner.runGateCounts;
		let firstCompleted = false;
		const runner = vi.spyOn(gateRunner, "runGateCounts").mockImplementation(async (...args) => {
			const result = await original(...args);
			if (args[2].request.sampleId === first) {
				firstCompleted = true;
				// Both bindings have already been admitted. Remove only the second
				// invocation-owned snapshot, after the first runner closes its source.
				await rm(secondPath);
			}
			return result;
		});
		const { jobId } = (await service.invoke(
			"start_batch_gate_counts",
			request([first, second]),
		)) as {
			jobId: string;
		};
		const submitted = { jobId };
		await vi.waitFor(
			async () => {
				expect(await service.invoke("get_job", submitted)).toMatchObject({ state: "failed" });
			},
			{ timeout: 20_000, interval: 10 },
		);
		expect(firstCompleted).toBe(true);
		expect(runner.mock.calls.map((args) => args[2].request.sampleId)).toEqual([first, second]);
		const expectedError = {
			code: "ENOENT",
			details: {
				sampleIndex: 1,
				sampleId: second,
				completedSamples: 1,
				phase: "run",
				cause: { code: "ENOENT", message: expect.stringContaining("ENOENT") },
			},
		};
		expect(await service.invoke("get_job", submitted)).toMatchObject({
			state: "failed",
			processedEvents: 4,
			totalEvents: 8,
			error: expectedError,
		});
		const receipt = (await service.invoke("get_receipt", submitted)) as Record<string, unknown>;
		expect(receipt).toMatchObject({
			operation: "batch-gate-counts",
			state: "failed",
			processedEvents: 4,
			error: expectedError,
		});
		expect(receipt.summary).toBeUndefined();
		expect(receipt.output).toBeUndefined();
		expect(await readdir(join(root, "outputs"))).toEqual([]);
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
		const record = JSON.parse(
			await readFile(join(root, ".flow-atlas", "runs", `${submitted.jobId}.json`), "utf8"),
		);
		expect(record.receipt).toEqual(receipt);
		await service.close();
		const restarted = await serviceAt(root);
		expect(await restarted.invoke("get_receipt", submitted)).toEqual(receipt);
		expect(await restarted.invoke("get_job", submitted)).toMatchObject({
			state: "failed",
			live: false,
			error: expectedError,
		});
	}, 30_000);

	it("passes through lookup AbortError even when the standalone resolver has no signal", async () => {
		const reason = new DOMException("metadata lookup aborted", "AbortError");
		await expect(
			resolveBatchCounts(request(["a".repeat(64)]), async () => {
				throw reason;
			}),
		).rejects.toBe(reason);
	});

	it("preserves typed cause details when annotating a standalone resolver failure", async () => {
		const sampleId = "b".repeat(64);
		const cause = new AnalysisError("INPUT_CHANGED", "Snapshot identity changed", {
			expected: "before",
			observed: "after",
		});
		await expect(
			resolveBatchCounts(request([sampleId]), async () => {
				throw cause;
			}),
		).rejects.toMatchObject({
			code: "INPUT_CHANGED",
			details: {
				sampleIndex: 0,
				sampleId,
				completedSamples: 0,
				phase: "resolve",
				cause: { code: cause.code, message: cause.message, details: cause.details },
			},
		});
	});
});
