/**
 * Explicit, experimental sample pipeline. No input is inferred or auto-corrected:
 * the operator supplies the matrix, numerical input context and raw-space gates.
 * See docs/reference/explicit-pipeline.md for usage and evidence limits.
 */
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SHA256 = /^[a-f0-9]{64}$/;
const pause = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms));

function validate(recipe) {
	if (
		recipe?.schemaVersion !== 1 ||
		recipe.acknowledgeUnvalidated !== true ||
		recipe.inputStage !== "operator-declared-raw-unverified" ||
		typeof recipe.assumptions !== "string" ||
		!recipe.assumptions.trim() ||
		typeof recipe.samplePath !== "string" ||
		typeof recipe.workspacePath !== "string" ||
		!SHA256.test(recipe.sampleSha256 ?? "") ||
		!SHA256.test(recipe.workspaceSha256 ?? "") ||
		!recipe.spillover ||
		!Array.isArray(recipe.spillover.channels) ||
		recipe.spillover.channels.length === 0 ||
		new Set(recipe.spillover.channels).size !== recipe.spillover.channels.length ||
		!Array.isArray(recipe.spillover.matrix) ||
		recipe.spillover.matrix.length !== recipe.spillover.channels.length ** 2 ||
		recipe.spillover.matrix.some((value) => !Number.isFinite(value)) ||
		!recipe.renameChannels ||
		typeof recipe.renameChannels !== "object" ||
		Array.isArray(recipe.renameChannels) ||
		Object.keys(recipe.renameChannels).length !== recipe.spillover.channels.length ||
		recipe.spillover.channels.some(
			(name) =>
				typeof name !== "string" ||
				!Object.hasOwn(recipe.renameChannels, name) ||
				typeof recipe.renameChannels[name] !== "string" ||
				!recipe.renameChannels[name],
		) ||
		new Set(Object.values(recipe.renameChannels)).size !== recipe.spillover.channels.length ||
		!Array.isArray(recipe.gates) ||
		!recipe.gates.length ||
		!Array.isArray(recipe.gateReferenceCounts) ||
		recipe.gateReferenceCounts.length !== recipe.gates.length ||
		recipe.gates.some(
			(gate, index) => !gate || gate.id !== recipe.gateReferenceCounts[index]?.id,
		) ||
		!Number.isFinite(recipe.timeStep) ||
		recipe.timeStep <= 0
	)
		throw new Error("Invalid explicit experimental recipe");
}

async function terminal(service, jobId) {
	for (let attempts = 0; attempts < 600; attempts++) {
		const job = await service.invoke("get_job", { jobId });
		if (job.state === "succeeded") return job;
		if (job.state === "failed" || job.state === "cancelled")
			throw new Error(`Pipeline job ${job.state}: ${JSON.stringify(job.error ?? {})}`);
		await pause(500);
	}
	await service.invoke("cancel_job", { jobId });
	throw new Error("Pipeline job timed out and cancellation was requested");
}

/** Source identity must already be checked for the workspace by the caller. */
export async function executePipeline(service, recipe) {
	validate(recipe);
	const input = await service.invoke("import_fcs", { path: recipe.samplePath });
	if (input.sampleId !== recipe.sampleSha256) throw new Error("Sample SHA-256 mismatch");
	const compensation = await service.invoke("register_compensation", {
		sampleId: input.sampleId,
		inputSpace: "linearized",
		acquisition: { timeStep: recipe.timeStep },
		spillover: recipe.spillover,
	});
	const exportJob = await service.invoke("start_fcs_export", {
		sampleId: input.sampleId,
		compensationId: compensation.id,
		renameChannels: recipe.renameChannels,
		outputName: "experimental-compensated.fcs",
	});
	const exported = await terminal(service, exportJob.jobId);
	const outputReceipt = await service.invoke("get_receipt", { jobId: exportJob.jobId });
	const derived = await service.invoke("import_fcs", { path: exported.result.path });
	if (derived.eventCount !== input.eventCount || derived.sampleId !== exported.result.sha256)
		throw new Error("Export identity or event count mismatch");
	const countJob = await service.invoke("start_gate_counts", {
		sampleId: derived.sampleId,
		coordinateSpace: "stored-f32",
		gates: recipe.gates,
	});
	await terminal(service, countJob.jobId);
	const gateReceipt = await service.invoke("get_receipt", { jobId: countJob.jobId });
	if (
		gateReceipt.summary?.eventCount !== input.eventCount ||
		!Array.isArray(gateReceipt.summary?.counts) ||
		gateReceipt.summary.counts.length !== recipe.gates.length ||
		gateReceipt.summary.counts.some(
			(row, index) => row.id !== recipe.gates[index].id || row.rootCount !== input.eventCount,
		)
	)
		throw new Error("Gate receipt does not cover the full declared sample");
	return {
		status: "experimental-not-validated",
		inputStage: recipe.inputStage,
		assumptions: recipe.assumptions,
		workspaceSha256: recipe.workspaceSha256,
		sourceSha256: input.sampleId,
		sourceEvents: input.eventCount,
		derivedSha256: derived.sampleId,
		derivedEvents: derived.eventCount,
		compensationId: compensation.id,
		candidateCounts: gateReceipt.summary.counts,
		providedReferenceCounts: recipe.gateReferenceCounts,
		exportReceipt: outputReceipt,
		gateReceipt,
	};
}

async function main() {
	const [rootArg, recipeArg] = process.argv.slice(2);
	if (!rootArg || !recipeArg) throw new Error("Usage: node explicit-pipeline.mjs ROOT RECIPE.json");
	const root = await realpath(rootArg);
	if ((await stat(recipeArg)).size > 1024 * 1024) throw new Error("Recipe exceeds 1 MiB");
	const recipe = JSON.parse(await readFile(recipeArg, "utf8"));
	validate(recipe);
	if (isAbsolute(recipe.workspacePath)) throw new Error("Workspace must be root-relative");
	const workspace = await realpath(resolve(root, recipe.workspacePath));
	const rel = relative(root, workspace);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
		throw new Error("Workspace must remain inside the experiment root");
	if ((await stat(workspace)).size > 16 * 1024 * 1024) throw new Error("Workspace exceeds 16 MiB");
	const digest = createHash("sha256")
		.update(await readFile(workspace))
		.digest("hex");
	if (digest !== recipe.workspaceSha256) throw new Error("Workspace SHA-256 mismatch");
	const { createAnalysisService } = await import("../dist/index.js");
	const service = await createAnalysisService({ root, maxChunkBytes: 1024 * 1024 });
	try {
		console.log(JSON.stringify(await executePipeline(service, recipe), null, 2));
	} finally {
		await service.close();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	main().catch((error) => {
		console.error(`Experimental pipeline failed: ${error.message}`);
		process.exitCode = 1;
	});
