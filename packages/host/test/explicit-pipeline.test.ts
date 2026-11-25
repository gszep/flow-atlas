import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { executePipeline } from "../examples/explicit-pipeline.mjs";

const source = "a".repeat(64);
const derived = "b".repeat(64);
function recipe() {
	return {
		schemaVersion: 1,
		acknowledgeUnvalidated: true,
		inputStage: "operator-declared-raw-unverified",
		assumptions: "illustrative only",
		samplePath: "sample.fcs",
		sampleSha256: source,
		workspacePath: "source.wsp",
		workspaceSha256: "c".repeat(64),
		timeStep: 0.01,
		spillover: { channels: ["A"], matrix: [1] },
		renameChannels: { A: "Comp-A" },
		gates: [{ id: "g" }],
		gateReferenceCounts: [{ id: "g", count: 2 }],
	};
}
function fake() {
	return {
		invoke: vi.fn(async (operation: string, args: Record<string, unknown>) => {
			if (operation === "import_fcs")
				return args.path === "sample.fcs"
					? { sampleId: source, eventCount: 3 }
					: { sampleId: derived, eventCount: 3 };
			if (operation === "register_compensation") return { id: "comp" };
			if (operation === "start_fcs_export") return { jobId: "export" };
			if (operation === "start_gate_counts") return { jobId: "gates" };
			if (operation === "get_job")
				return { state: "succeeded", result: { path: "outputs/result.fcs", sha256: derived } };
			if (operation === "get_receipt")
				return args.jobId === "gates"
					? { summary: { eventCount: 3, counts: [{ id: "g", count: 2, rootCount: 3 }] } }
					: {};
			throw new Error(`Unexpected operation ${operation}`);
		}),
	};
}
describe("explicit experimental FCS pipeline", () => {
	it("keeps all events, binds supplied identities and never claims validation", async () => {
		const service = fake();
		const result = await executePipeline(service, recipe());
		expect(result).toMatchObject({
			status: "experimental-not-validated",
			sourceSha256: source,
			derivedSha256: derived,
			sourceEvents: 3,
			derivedEvents: 3,
		});
		const exportArgs = service.invoke.mock.calls.find(
			([operation]) => operation === "start_fcs_export",
		)?.[1];
		expect(exportArgs).toMatchObject({ renameChannels: { A: "Comp-A" }, compensationId: "comp" });
		expect(exportArgs).not.toHaveProperty("startEvent");
		expect(exportArgs).not.toHaveProperty("eventCount");
	});
	it("fails closed before compensation if assumptions or source identity do not match", async () => {
		const service = fake();
		await expect(
			executePipeline(service, { ...recipe(), acknowledgeUnvalidated: false }),
		).rejects.toThrow(/recipe/);
		expect(service.invoke).not.toHaveBeenCalled();
		await expect(
			executePipeline(service, { ...recipe(), sampleSha256: "d".repeat(64) }),
		).rejects.toThrow(/SHA-256/);
		expect(service.invoke.mock.calls.map(([name]) => name)).toEqual(["import_fcs"]);
	});
	it("requires explicit channel mappings and a declared raw-stage hypothesis", async () => {
		const service = fake();
		await expect(executePipeline(service, { ...recipe(), renameChannels: {} })).rejects.toThrow(
			/recipe/,
		);
		await expect(
			executePipeline(service, { ...recipe(), inputStage: "already-compensated" }),
		).rejects.toThrow(/recipe/);
		expect(service.invoke).not.toHaveBeenCalled();
	});
	it("refuses a mismatched workspace before invoking the host", async () => {
		const root = await mkdtemp(join(tmpdir(), "explicit-pipeline-"));
		try {
			await writeFile(join(root, "source.wsp"), "different workspace");
			await writeFile(join(root, "recipe.json"), JSON.stringify(recipe()));
			await expect(
				promisify(execFile)(process.execPath, [
					fileURLToPath(new URL("../examples/explicit-pipeline.mjs", import.meta.url)),
					root,
					join(root, "recipe.json"),
				]),
			).rejects.toMatchObject({ stderr: expect.stringContaining("Workspace SHA-256 mismatch") });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
