import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFcs } from "@flow-atlas/fcs";
import { expect, it, vi } from "vitest";
import { createAnalysisService } from "../src/analysis.js";
import { ArtifactStore } from "../src/artifact-store.js";
import type { AnalysisService } from "../src/contracts.js";

it("recovers published counts after terminal run-record persistence fails", async () => {
	const root = await mkdtemp(join(tmpdir(), "flow-atlas-count-publication-"));
	let service: AnalysisService | undefined;
	try {
		const file = await open(join(root, "input.fcs"), "wx");
		try {
			for await (const bytes of writeFcs(
				{
					version: "FCS3.1",
					keywords: {},
					eventCount: 3,
					channels: [{ index: 1, name: "A", bits: 32, range: 100, gain: 1, amplification: [0, 0] }],
				},
				[new Float32Array([1, 2, 3])],
			))
				await file.writeFile(bytes);
		} finally {
			await file.close();
		}
		service = await createAnalysisService({ root });
		const sample = (await service.invoke("import_fcs", { path: "input.fcs" })) as {
			sampleId: string;
		};
		const save = ArtifactStore.prototype.saveRun;
		const failure = vi.spyOn(ArtifactStore.prototype, "saveRun").mockImplementation(async function (
			this: ArtifactStore,
			id,
			value,
		) {
			if ((value as { state?: string }).state === "succeeded")
				throw new Error("injected terminal record failure");
			return save.call(this, id, value);
		});
		const job = (await service.invoke("start_gate_counts", {
			sampleId: sample.sampleId,
			coordinateSpace: "stored-f32",
			gates: [
				{
					id: "high",
					name: "High",
					parentId: null,
					dimensions: ["A"],
					geometry: { type: "rectangle", min: [2], max: [null] },
				},
			],
		})) as { jobId: string };
		await vi.waitFor(
			async () => {
				const status = (await service?.invoke("get_job", { jobId: job.jobId })) as {
					state: string;
					warnings?: unknown[];
				};
				expect(status.state).toBe("succeeded");
				expect(status.warnings).toHaveLength(1);
			},
			{ timeout: 10_000, interval: 5 },
		);
		const receipt = (await service.invoke("get_receipt", { jobId: job.jobId })) as {
			summary: { counts: { count: number }[] };
		};
		expect(receipt.summary.counts[0]?.count).toBe(2);
		failure.mockRestore();
		await service.close();
		service = await createAnalysisService({ root });
		expect(await service.invoke("get_receipt", { jobId: job.jobId })).toEqual(receipt);
		expect(await service.invoke("get_job", { jobId: job.jobId })).toMatchObject({
			state: "succeeded",
			kind: "gate-counts",
			live: false,
			processedEvents: 3,
		});
	} finally {
		vi.restoreAllMocks();
		await service?.close();
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);
