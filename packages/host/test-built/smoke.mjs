import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readFcs, writeFcs } from "@flow-atlas/fcs";

const root = await mkdtemp(join(tmpdir(), "flow-atlas-built-"));
const token = randomBytes(24).toString("hex");
let child;
let exited;
let cleanupError;
try {
	const file = await open(join(root, "input.fcs"), "wx");
	try {
		const metadata = {
			version: "FCS3.1",
			keywords: {},
			eventCount: 2,
			channels: ["A", "B"].map((name, i) => ({
				index: i + 1,
				name,
				bits: 32,
				range: 262144,
				amplification: [0, 0],
				gain: 1,
			})),
			spill: {
				channels: ["A", "B"],
				matrix: new Float64Array([1, 0.2, 0.1, 1]),
				source: "$SPILLOVER",
			},
		};
		for await (const chunk of writeFcs(metadata, [new Float32Array([9.8, 0, 2, 20])]))
			await file.writeFile(chunk);
	} finally {
		await file.close();
	}
	const controlsFile = await open(join(root, "controls.fcs"), "wx");
	try {
		const metadata = {
			version: "FCS3.1",
			keywords: {},
			eventCount: 3,
			channels: ["A", "B"].map((name, i) => ({
				index: i + 1,
				name,
				bits: 32,
				range: 262144,
				amplification: [0, 0],
				gain: 1,
			})),
		};
		for await (const chunk of writeFcs(metadata, [new Float32Array([0, 0, 8, 2, -1, 8])]))
			await controlsFile.writeFile(chunk);
	} finally {
		await controlsFile.close();
	}
	child = spawn(
		process.execPath,
		[fileURLToPath(new URL("../dist/main.js", import.meta.url)), "--root", root],
		{ env: { ...process.env, FLOW_ATLAS_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] },
	);
	exited = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	let stderr = "";
	child.stderr.on("data", (bytes) => {
		stderr = (stderr + bytes).slice(-8192);
	});
	let pending = "";
	let startupTimer;
	const ready = await new Promise((resolve, reject) => {
		startupTimer = setTimeout(
			() => reject(new Error(`Studio startup timed out: ${stderr}`)),
			15_000,
		);
		child.stdout.on("data", (bytes) => {
			pending += bytes;
			for (let index = pending.indexOf("\n"); index >= 0; index = pending.indexOf("\n")) {
				const line = pending.slice(0, index);
				pending = pending.slice(index + 1);
				try {
					const record = JSON.parse(line);
					if (record.state === "ready") resolve(record);
				} catch {
					/* Only the ready record is protocol output. */
				}
			}
			if (pending.length > 65536) reject(new Error("Unexpected oversized startup output"));
		});
		exited.then(
			(exit) => reject(new Error(`Studio exited before ready: ${JSON.stringify(exit)} ${stderr}`)),
			reject,
		);
	}).finally(() => clearTimeout(startupTimer));
	let id = 0;
	const call = async (method, params) => {
		const response = await fetch(`${ready.url}/rpc`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
			signal: AbortSignal.timeout(20_000),
		});
		const result = await response.json();
		assert.equal(response.status, 200);
		assert.equal(result.error, undefined, JSON.stringify(result.error));
		return result.result;
	};
	const capabilities = await call("list_capabilities", {});
	assert.match(capabilities.buildId, /^[a-f0-9]{64}$/);
	const sample = await call("import_fcs", { path: "input.fcs" });
	const matrix = await call("register_compensation", { sampleId: sample.sampleId });
	const job = await call("start_fcs_export", {
		sampleId: sample.sampleId,
		compensationId: matrix.id,
	});
	let status;
	const deadline = Date.now() + 20_000;
	do {
		status = await call("get_job", { jobId: job.jobId });
		if (["succeeded", "failed", "cancelled"].includes(status.state)) break;
		if (Date.now() > deadline) throw new Error("Export did not reach a terminal state");
		await delay(10);
	} while (!["succeeded", "failed", "cancelled"].includes(status.state));
	assert.equal(status.state, "succeeded", JSON.stringify(status));
	const receipt = await call("get_receipt", { jobId: job.jobId });
	assert.equal(receipt.buildId, capabilities.buildId);
	const buffer = await readFile(join(root, status.result.path));
	const output = readFcs(
		buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
	);
	assert.equal(output.spill, undefined);
	assert.equal(output.eventCount, 2);
	const expected = [10, -2, 0, 20];
	assert.ok(output.data.every((value, i) => Math.abs(value - expected[i]) < 0.0001));
	const spectral = await call("register_unmixing", {
		sampleId: sample.sampleId,
		inputSpace: "linearized",
		detectors: ["A", "B"],
		fluorochromes: ["X"],
		matrix: [1, 2],
		residualChannel: "fit",
	});
	const spectralJob = await call("start_fcs_export", {
		sampleId: sample.sampleId,
		unmixingId: spectral.id,
		channels: ["X", "fit"],
	});
	const spectralDeadline = Date.now() + 20_000;
	let spectralStatus;
	do {
		spectralStatus = await call("get_job", { jobId: spectralJob.jobId });
		if (["succeeded", "failed", "cancelled"].includes(spectralStatus.state)) break;
		if (Date.now() > spectralDeadline) throw new Error("Spectral export did not finish");
		await delay(10);
	} while (spectralStatus.state === "queued" || spectralStatus.state === "running");
	assert.equal(spectralStatus.state, "succeeded", JSON.stringify(spectralStatus));
	const spectralBytes = await readFile(join(root, spectralStatus.result.path));
	const spectralOutput = readFcs(
		spectralBytes.buffer.slice(
			spectralBytes.byteOffset,
			spectralBytes.byteOffset + spectralBytes.byteLength,
		),
	);
	assert.deepEqual(
		spectralOutput.channels.map((channel) => channel.name),
		["X", "fit"],
	);
	assert.equal(spectralOutput.keywords.FLOWATLAS_OUTPUT_LAYOUT, "derived-only");
	assert.equal(spectralOutput.spill, undefined);
	assert.ok(Math.abs(spectralOutput.data[0] - 1.96) < 1e-4);
	assert.ok(Math.abs(spectralOutput.data[2] - 8.4) < 1e-4);
	const spectralReceipt = await call("get_receipt", { jobId: spectralJob.jobId });
	assert.equal(spectralReceipt.inputContext.inputSpace, "linearized");
	assert.equal(spectralReceipt.unmixing.diagnostics.rank, 1);
	const controls = await call("import_fcs", { path: "controls.fcs" });
	const population = (startEvent) => ({ sampleId: controls.sampleId, startEvent, eventCount: 1 });
	const estimation = await call("start_control_estimation", {
		sampleId: sample.sampleId,
		channels: ["A", "B"],
		minEvents: 1,
		controls: [
			{ primaryDetector: "B", positive: population(2), negative: population(0) },
			{ primaryDetector: "A", positive: population(1), negative: population(0) },
		],
	});
	const estimationDeadline = Date.now() + 20_000;
	let estimationStatus;
	do {
		estimationStatus = await call("get_job", { jobId: estimation.jobId });
		if (["succeeded", "failed", "cancelled"].includes(estimationStatus.state)) break;
		if (Date.now() > estimationDeadline) throw new Error("Control estimation did not finish");
		await delay(10);
	} while (estimationStatus.state === "queued" || estimationStatus.state === "running");
	assert.equal(estimationStatus.state, "succeeded", JSON.stringify(estimationStatus));
	const estimationReceipt = await call("get_receipt", { jobId: estimation.jobId });
	assert.deepEqual(estimationReceipt.estimatedMatrix.matrix, [1, 0.25, -0.125, 1]);
	assert.equal(estimationReceipt.distinctPopulationCount, 3);
	assert.equal(estimationReceipt.buildId, capabilities.buildId);
	const estimatedPreview = await call("preview_fcs", {
		sampleId: sample.sampleId,
		compensationId: estimationStatus.result.compensationId,
		limit: 1,
	});
	assert.ok(estimatedPreview);
	const countsJob = await call("start_gate_counts", {
		sampleId: sample.sampleId,
		coordinateSpace: "stored-f32",
		gates: [
			{
				id: "low-a",
				name: "Low A",
				parentId: null,
				dimensions: ["A"],
				geometry: { type: "rectangle", min: [null], max: [5] },
			},
		],
	});
	const countsDeadline = Date.now() + 20_000;
	let countsStatus;
	do {
		countsStatus = await call("get_job", { jobId: countsJob.jobId });
		if (["succeeded", "failed", "cancelled"].includes(countsStatus.state)) break;
		if (Date.now() > countsDeadline) throw new Error("Population counts did not finish");
		await delay(10);
	} while (countsStatus.state === "queued" || countsStatus.state === "running");
	assert.equal(countsStatus.state, "succeeded", JSON.stringify(countsStatus));
	const countsReceipt = await call("get_receipt", { jobId: countsJob.jobId });
	assert.equal(countsReceipt.operation, "gate-counts");
	assert.equal(countsReceipt.eventCount, 2);
	assert.equal(countsReceipt.summary.counts[0].count, 1);
	assert.equal(countsReceipt.summary.counts[0].parentCount, 2);
	assert.equal(countsReceipt.summary.counts[0].frequencyOfRoot, 0.5);
	assert.equal(countsReceipt.buildId, capabilities.buildId);
	const countsArtifact = JSON.parse(await readFile(join(root, countsStatus.result.path), "utf8"));
	assert.deepEqual(countsArtifact.summary, countsReceipt.summary);
	const batchJob = await call("start_batch_gate_counts", {
		coordinateSpace: "stored-f32",
		samples: [
			{ sampleId: sample.sampleId, label: "sample" },
			{ sampleId: controls.sampleId, label: "controls" },
		],
		gates: [
			{
				id: "low-a",
				name: "Low A",
				parentId: null,
				dimensions: ["A"],
				geometry: { type: "rectangle", min: [null], max: [5] },
			},
		],
	});
	const batchDeadline = Date.now() + 20_000;
	let batchStatus;
	do {
		batchStatus = await call("get_job", { jobId: batchJob.jobId });
		if (["succeeded", "failed", "cancelled"].includes(batchStatus.state)) break;
		if (Date.now() > batchDeadline) throw new Error("Batch population counts did not finish");
		await delay(10);
	} while (batchStatus.state === "queued" || batchStatus.state === "running");
	assert.equal(batchStatus.state, "succeeded", JSON.stringify(batchStatus));
	const batchReceipt = await call("get_receipt", { jobId: batchJob.jobId });
	assert.equal(batchReceipt.operation, "batch-gate-counts");
	assert.equal(batchReceipt.eventCount, 5);
	assert.equal(batchReceipt.summary.sampleCount, 2);
	assert.equal(batchReceipt.summary.rowCount, 2);
	assert.deepEqual(
		batchReceipt.summary.rows.map((row) => [
			row.sampleIndex,
			row.gateIndex,
			row.count,
			row.rootCount,
		]),
		[
			[0, 0, 1, 2],
			[1, 0, 2, 3],
		],
	);
	const batchArtifact = JSON.parse(await readFile(join(root, batchStatus.result.path), "utf8"));
	assert.deepEqual(batchArtifact.recipe, batchReceipt.recipe);
	assert.deepEqual(batchArtifact.summary, batchReceipt.summary);
	const medianJob = await call("start_population_medians", {
		sampleId: controls.sampleId,
		coordinateSpace: "stored-f32",
		populationId: "positive",
		channels: ["B", "A"],
		gates: [
			{
				id: "positive",
				name: "Nonnegative A",
				parentId: null,
				dimensions: ["A"],
				geometry: { type: "rectangle", min: [0], max: [null] },
			},
		],
	});
	const medianDeadline = Date.now() + 20_000;
	let medianStatus;
	do {
		medianStatus = await call("get_job", { jobId: medianJob.jobId });
		if (["succeeded", "failed", "cancelled"].includes(medianStatus.state)) break;
		if (Date.now() > medianDeadline) throw new Error("Population medians did not finish");
		await delay(10);
	} while (medianStatus.state === "queued" || medianStatus.state === "running");
	assert.equal(medianStatus.state, "succeeded", JSON.stringify(medianStatus));
	assert.equal(medianStatus.progressUnit, "event-visits");
	assert.equal(medianStatus.processedEvents, 12);
	const medianReceipt = await call("get_receipt", { jobId: medianJob.jobId });
	assert.equal(medianReceipt.operation, "population-medians");
	assert.equal(medianReceipt.summary.count, 2);
	assert.deepEqual(medianReceipt.summary.lower, [0, 0]);
	assert.deepEqual(medianReceipt.summary.upper, [2, 8]);
	assert.deepEqual(medianReceipt.summary.ranks, { indexBase: 0, lower: 0, upper: 1 });
	const medianArtifact = JSON.parse(await readFile(join(root, medianStatus.result.path), "utf8"));
	assert.deepEqual(medianArtifact.recipe, medianReceipt.recipe);
	assert.deepEqual(medianArtifact.summary, medianReceipt.summary);
	console.log(
		JSON.stringify({
			result: "passed",
			check:
				"built Node studio: compensation, acquisition/OLS, control estimation, single/batch counts and gated medians",
			inputHash: sample.sha256,
			outputHash: status.result.sha256,
		}),
	);
} finally {
	try {
		if (child) {
			child.kill("SIGTERM");
			const timeout = new AbortController();
			const stop = await Promise.race([
				exited,
				delay(10_000, null, { signal: timeout.signal })
					.then(() => null)
					.catch(() => null),
			]);
			timeout.abort();
			if (!stop) {
				child.kill("SIGKILL");
				await exited;
				cleanupError = new Error("Studio did not drain on SIGTERM");
			} else assert.equal(stop.code, 0, JSON.stringify(stop));
		}
	} catch (error) {
		cleanupError = error;
	}
	await rm(root, { recursive: true, force: true });
}
if (cleanupError) throw cleanupError;
