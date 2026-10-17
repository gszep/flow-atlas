// Run against an already built host; the parent supervisor owns wall/stall limits.
// node --max-old-space-size=512 packages/host/bench/gate-counts.mjs \
//   --tiles 1 --groups 1 --workdir /path/to/temp --result /path/to/new-result.json
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { inspect, parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
	options: {
		tiles: { type: "string", default: "4" },
		groups: { type: "string", default: "16" },
		workdir: { type: "string", default: tmpdir() },
		result: { type: "string" },
		keep: { type: "boolean", default: false },
	},
});
const tiles = Number(values.tiles),
	groups = Number(values.groups);
assert.equal(Number(process.versions.node.split(".")[0]), 24, "Use Node 24");
assert.ok(
	Number.isSafeInteger(tiles) && tiles >= 1 && tiles <= 64,
	"--tiles must be 1..64 (at most 1 GiB DATA)",
);
assert.ok(Number.isSafeInteger(groups) && groups >= 1 && groups <= 16, "--groups must be 1..16");
assert.ok(values.result, "--result must name a new JSON file; its .log sidecar must also be new");
assert.ok(
	getHeapStatistics().heap_size_limit <= 768 * 2 ** 20,
	"Launch with node --max-old-space-size=512 (V8 young-generation overhead is additional)",
);
assert.notEqual(
	process.env.FLOW_ATLAS_GPU,
	"software",
	"Software adapters are not performance measurements",
);
const events = tiles * 1024 * 1024,
	parameters = 4,
	maxChunkBytes = 4 * 2 ** 20;
const resultPath = resolve(values.result),
	logPath = `${resultPath}.log`;
// Reserve both before generating data. Never overwrite a previous result or log.
const resultFd = openSync(resultPath, "wx", 0o600);
let logFd;
try {
	logFd = openSync(logPath, "wx", 0o600);
} catch (error) {
	closeSync(resultFd);
	throw error;
}
const started = performance.now();
const phases = {},
	timings = {};
let phase = "startup",
	phaseStarted = started,
	phaseEvents = 0;
let actualProgressSequence = 0,
	lastActualProgressAt = started;
let root, service, jobId, state, receipt, summary, inputHash, outputHash;
let generatedHash, sourceBytes, adapter, buildId, shaderHash, runnerHash, builtHostHash;
let failure, caughtSignal, heartbeat, sampler;
const abort = new AbortController();
const errors = [];
const rss = () => process.memoryUsage().rss;
function sampleRss() {
	const bytes = rss();
	phases[phase] ??= {
		startMs: phaseStarted - started,
		startRssBytes: bytes,
		sampledPeakRssBytes: bytes,
		samples: 0,
	};
	const entry = phases[phase];
	entry.samples++;
	entry.endRssBytes = bytes;
	entry.sampledPeakRssBytes = Math.max(entry.sampledPeakRssBytes, bytes);
	entry.processLifetimeHighWaterBytes = process.resourceUsage().maxRSS * 1024;
}
function emit(kind, details = {}) {
	sampleRss();
	const line = `${JSON.stringify({
		kind,
		phase,
		elapsedMs: performance.now() - started,
		phaseEvents,
		actualProgressSequence,
		sinceActualProgressMs: performance.now() - lastActualProgressAt,
		rssBytes: rss(),
		...details,
	})}\n`;
	writeSync(logFd, line);
	process.stdout.write(line);
}
function enter(name) {
	sampleRss();
	phases[phase].elapsedMs = performance.now() - phaseStarted;
	phase = name;
	phaseStarted = performance.now();
	phaseEvents = 0;
	emit("phase-start");
}
function progressed(count) {
	assert.ok(count >= phaseEvents);
	if (count === phaseEvents) return;
	phaseEvents = count;
	actualProgressSequence++;
	lastActualProgressAt = performance.now();
	emit("event-progress");
}
function interrupted(signal) {
	if (caughtSignal) return;
	caughtSignal = signal;
	abort.abort(new Error(`Supervisor sent ${signal}`));
	emit("signal", { signal });
}
const sigint = () => interrupted("SIGINT"),
	sigterm = () => interrupted("SIGTERM");
process.on("SIGINT", sigint);
process.on("SIGTERM", sigterm);
function recordError(error, context) {
	const full = inspect(error, { depth: null, maxArrayLength: null, maxStringLength: null });
	errors.push({ context, error: full });
	emit("error", { context, error: full });
	process.stderr.write(`${context}: ${full}\n`);
}

const gates = [],
	expected = [];
function family(group) {
	const id = (name) => `g${group}-${name}`;
	const add = (name, parent, dimensions, geometry, count, denominator) => {
		gates.push({
			id: id(name),
			name: id(name),
			parentId: parent === null ? null : id(parent),
			dimensions,
			geometry,
		});
		expected.push({
			id: id(name),
			name: id(name),
			parentId: parent === null ? null : id(parent),
			count,
			parentCount: denominator,
			rootCount: events,
			frequencyOfParent: count / denominator,
			frequencyOfRoot: count / events,
		});
	};
	const rect = (min, max) => ({ type: "rectangle", min: [min], max: [max] });
	add("all", null, ["X"], rect(null, null), events, events);
	add("left", "all", ["X"], rect(0, 511), events / 2, events);
	add("bottom", "all", ["Y"], rect(0, 511), events / 2, events);
	add("quarter", "left", ["Y"], rect(0, 511), events / 4, events / 2);
	// For integer lattice coordinates the strict diagonal x+y < 1023.5
	// is x+y <= 1023: sum(1..1024) = 524800 per complete tile.
	add(
		"triangle",
		"all",
		["X", "Y"],
		{
			type: "polygon",
			vertices: [
				[-0.5, -0.5],
				[1024, -0.5],
				[-0.5, 1024],
			],
		},
		524800 * tiles,
		events,
	);
	add(
		"union",
		"all",
		[],
		{ type: "boolean", op: "or", refs: [id("left"), id("bottom")] },
		(3 * events) / 4,
		events,
	);
	add("notLeft", "all", [], { type: "boolean", op: "not", refs: [id("left")] }, events / 2, events);
	add(
		"unionMinusQuarter",
		"union",
		[],
		{ type: "boolean", op: "not", refs: [id("quarter")] },
		events / 2,
		(3 * events) / 4,
	);
}
for (let group = 0; group < groups; group++) family(group);

try {
	emit("configuration", {
		tiles,
		groups,
		gates: gates.length,
		events,
		payloadBytes: events * 16,
		maxChunkBytes,
		resultPath,
		logPath,
		heapSizeLimitBytes: getHeapStatistics().heap_size_limit,
	});
	heartbeat = setInterval(
		() => emit("heartbeat", { note: "Liveness only; not evidence of event progress" }),
		1000,
	);
	sampler = setInterval(sampleRss, 100);
	enter("module-setup");
	runnerHash = createHash("sha256")
		.update(await readFile(new URL(import.meta.url)))
		.digest("hex");
	builtHostHash = createHash("sha256")
		.update(await readFile(new URL("../dist/index.js", import.meta.url)))
		.digest("hex");
	const { writeFcs } = await import("@flow-atlas/fcs");
	const { createAnalysisService } = await import("../dist/index.js");
	timings.moduleSetupMs = performance.now() - phaseStarted;
	abort.signal.throwIfAborted();
	await mkdir(values.workdir, { recursive: true });
	root = await mkdtemp(join(values.workdir, "flow-atlas-gate-bench-"));
	enter("generation");
	const hash = createHash("sha256");
	const handle = await open(join(root, "synthetic.fcs"), "wx", 0o600);
	try {
		const metadata = {
			version: "FCS3.1",
			eventCount: events,
			keywords: { EXPERIMENT: "gate-count-tile-scalability" },
			channels: ["X", "Y", "AuxA", "AuxB"].map((name, index) => ({
				index: index + 1,
				name,
				bits: 32,
				range: 1024,
				amplification: [0, 0],
				gain: 1,
			})),
		};
		async function* chunks() {
			for (let first = 0; first < events; first += 65536) {
				abort.signal.throwIfAborted();
				const count = Math.min(65536, events - first);
				const data = new Float32Array(count * parameters);
				for (let row = 0; row < count; row++) {
					const i = first + row;
					data[row * 4] = i % 1024;
					data[row * 4 + 1] = Math.floor(i / 1024) % 1024;
					data[row * 4 + 2] = (i % 256) / 4;
					data[row * 4 + 3] = (i % 128) - 64;
				}
				yield data;
				progressed(first + count);
			}
		}
		for await (const bytes of writeFcs(metadata, chunks())) {
			abort.signal.throwIfAborted();
			await handle.writeFile(bytes);
			hash.update(bytes);
		}
		await handle.sync();
		await handle.chmod(0o400);
		sourceBytes = (await handle.stat()).size;
	} finally {
		await handle.close();
	}
	generatedHash = hash.digest("hex");
	timings.generationMs = performance.now() - phaseStarted;
	enter("service-setup");
	service = await createAnalysisService({ root, maxChunkBytes });
	timings.serviceSetupMs = performance.now() - phaseStarted;
	enter("import");
	const sample = await service.invoke("import_fcs", { path: "synthetic.fcs" }, abort.signal);
	timings.importMs = performance.now() - phaseStarted;
	inputHash = sample.sampleId;
	assert.equal(inputHash, generatedHash);
	enter("admission");
	const admissionStarted = performance.now();
	const submitted = await service.invoke(
		"start_gate_counts",
		{ sampleId: inputHash, coordinateSpace: "stored-f32", gates },
		abort.signal,
	);
	jobId = submitted.jobId;
	timings.admissionMs = performance.now() - admissionStarted;
	enter("job");
	const pollStarted = performance.now();
	let previousState;
	for (;;) {
		abort.signal.throwIfAborted();
		state = await service.invoke("get_job", { jobId }, abort.signal);
		progressed(state.processedEvents);
		const nextState = `${state.state}:${state.phase}`;
		if (nextState !== previousState) {
			emit("job-state", { state: state.state, stage: state.phase });
			previousState = nextState;
		}
		if (["succeeded", "failed", "cancelled"].includes(state.state)) break;
		await delay(100, undefined, { signal: abort.signal });
	}
	timings.jobPollingMs = performance.now() - pollStarted;
	timings.admissionThroughTerminalObservationMs = performance.now() - admissionStarted;
	receipt = await service.invoke("get_receipt", { jobId });
	assert.equal(state.state, "succeeded", JSON.stringify({ state, receipt }));
	timings.jobQueueMs = receipt.timing.queueMs;
	timings.computationBeforePublicationMs = receipt.timing.computationBeforePublicationMs;
	assert.equal(receipt.operation, "gate-counts");
	assert.ok(Number.isFinite(timings.jobQueueMs) && timings.jobQueueMs >= 0);
	assert.ok(
		Number.isFinite(timings.computationBeforePublicationMs) &&
			timings.computationBeforePublicationMs >= 0,
	);
	adapter = receipt.gpu?.adapter;
	buildId = receipt.buildId;
	shaderHash = receipt.gpu?.shaderHash;
	assert.ok(typeof adapter === "string" && adapter.trim(), "Missing adapter identity");
	assert.ok(
		!/llvmpipe|lavapipe|swiftshader|software|microsoft basic|warp/i.test(adapter),
		"Software adapters cannot be labelled hardware performance",
	);
	assert.ok(buildId && shaderHash, "Missing build/shader identity");
	enter("verification");
	const outputBytes = await readFile(join(root, state.result.path));
	outputHash = createHash("sha256").update(outputBytes).digest("hex");
	assert.equal(outputHash, state.result.sha256);
	const artifact = JSON.parse(outputBytes.toString("utf8"));
	summary = artifact.summary;
	assert.equal(artifact.sampleId, inputHash);
	assert.equal(artifact.recipeHash, receipt.recipeHash);
	assert.equal(summary.coordinateSpace, "stored-f32");
	assert.equal(summary.startEvent, 0);
	assert.equal(summary.eventCount, events);
	assert.equal(summary.rootCount, events);
	assert.equal(state.processedEvents, events);
	assert.equal(receipt.eventCount, events);
	assert.deepEqual(
		summary.counts,
		expected,
		"Every gate row, denominator and frequency must match the analytic tile counts",
	);
	assert.deepEqual(receipt.summary, summary);
	timings.verificationMs = performance.now() - phaseStarted;
	emit("verified", { checkedRows: expected.length, inputHash, outputHash });
} catch (error) {
	failure = error;
	recordError(error, "benchmark");
} finally {
	enter("cleanup");
	if ((failure || caughtSignal) && service && jobId) {
		try {
			emit("cancelling", { jobId });
			await service.invoke("cancel_job", { jobId });
		} catch (error) {
			recordError(error, "cancel_job");
		}
	}
	try {
		await service?.close();
	} catch (error) {
		failure ??= error;
		recordError(error, "service.close");
	}
	// Preserve structured failures before removing invocation-owned artifacts.
	if (root && jobId) {
		try {
			const persisted = await readFile(join(root, ".flow-atlas", "runs", `${jobId}.json`), "utf8");
			emit("persisted-job", { record: JSON.parse(persisted) });
		} catch (error) {
			failure ??= error;
			recordError(error, "read-final-job-record");
		}
	}
	if (root && !values.keep) {
		try {
			await rm(root, { recursive: true, force: true });
		} catch (error) {
			failure ??= error;
			recordError(error, "remove-owned-workdir");
		}
	}
	clearInterval(heartbeat);
	clearInterval(sampler);
	sampleRss();
	phases[phase].elapsedMs = performance.now() - phaseStarted;
	timings.cleanupMs = phases[phase].elapsedMs;
	timings.totalMs = performance.now() - started;
	const result = {
		schemaVersion: 1,
		status: failure || caughtSignal ? "failed" : "succeeded",
		measurement:
			"Single cold-service hardware run; not a warm-run distribution or vendor parity claim",
		tiles,
		groups,
		gateCount: gates.length,
		events,
		parameters,
		payloadBytes: events * 16,
		sourceBytes,
		maxChunkBytes,
		generationChunkEvents: 65536,
		node: process.version,
		platform: process.platform,
		heapSizeLimitBytes: getHeapStatistics().heap_size_limit,
		buildId,
		shaderHash,
		adapter,
		runnerHash,
		builtHostHash,
		inputHash,
		generatedHash,
		outputHash,
		recipeHash: receipt?.recipeHash,
		timings,
		phases,
		operationTiming: receipt?.timing ?? null,
		timingScope:
			"Receipt computation includes GPU initialization/lease, hash verification, streaming, dispatch/readback and artifact encoding before publication. No isolated setup/kernel timing is available. Polling includes observation delay; admission and job execution may overlap.",
		peakRssBytes: process.resourceUsage().maxRSS * 1024,
		rssScope:
			"Same-process lifetime high-water includes generation and module setup. Per-phase 100 ms RSS samples are absolute RSS, not isolated job allocation or GPU VRAM; native/driver allocations may not be fully reflected.",
		gpuAllocationHighWater: "not instrumented",
		cacheState: "OS/driver caches not cleared",
		checkedRows: summary && !failure ? expected.length : 0,
		summary,
		job: state,
		receipt,
		errors,
		signal: caughtSignal ?? null,
		retainedWorkdir: values.keep ? root : null,
		resultPath,
		logPath,
	};
	try {
		writeSync(resultFd, `${JSON.stringify(result, null, 2)}\n`);
		emit("complete", { status: result.status, resultPath, logPath });
	} finally {
		closeSync(resultFd);
		closeSync(logFd);
		process.off("SIGINT", sigint);
		process.off("SIGTERM", sigterm);
	}
	if (failure || caughtSignal) process.exitCode = 1;
}
