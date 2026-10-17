// Built-host developer runner. The parent supervisor owns wall/stall/RSS limits.
// node --max-old-space-size=512 --max-semi-space-size=16 \
//   packages/host/bench/population-medians.mjs --tiles 1 --population triangle \
//   --workdir /path/to/temp --result /path/to/new-result.json
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
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
		population: { type: "string", default: "triangle" },
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
assert.ok(
	["root", "triangle"].includes(values.population),
	"--population must be root or triangle",
);
assert.ok(values.result, "--result JSON and its .log sidecar must both be new paths");
assert.ok(
	getHeapStatistics().heap_size_limit <= 768 * 2 ** 20,
	"Launch with --max-old-space-size=512 (V8 young-generation overhead is additional)",
);
assert.notEqual(
	process.env.FLOW_ATLAS_GPU,
	"software",
	"Software is correctness-only, not performance",
);
const tileEvents = 1024 * 1024,
	events = tiles * tileEvents,
	eventVisits = 4 * events,
	parameters = 4,
	maxChunkBytes = 4 * 2 ** 20;
const channels = ["X", "Y", "Index", "CenteredIndex"];
const populationId = values.population === "root" ? null : `g${groups - 1}-triangle`;
const gates = [];
function family(group) {
	const id = (name) => `g${group}-${name}`;
	const add = (name, parent, dimensions, geometry) => {
		gates.push({
			id: id(name),
			name: id(name),
			parentId: parent === null ? null : id(parent),
			dimensions,
			geometry,
		});
	};
	const rect = (min, max) => ({ type: "rectangle", min: [min], max: [max] });
	add("all", null, ["X"], rect(null, null));
	add("left", "all", ["X"], rect(0, 511));
	add("bottom", "all", ["Y"], rect(0, 511));
	add("quarter", "left", ["Y"], rect(0, 511));
	add("triangle", "all", ["X", "Y"], {
		type: "polygon",
		vertices: [
			[-0.5, -0.5],
			[1024, -0.5],
			[-0.5, 1024],
		],
	});
	add("union", "all", [], { type: "boolean", op: "or", refs: [id("left"), id("bottom")] });
	add("notLeft", "all", [], { type: "boolean", op: "not", refs: [id("left")] });
	add("unionMinusQuarter", "union", [], { type: "boolean", op: "not", refs: [id("quarter")] });
}
if (populationId !== null) for (let group = 0; group < groups; group++) family(group);
// No CPU sort or event-wise membership oracle. The triangle's integer lattice is
// x+y <= 1023, with sum(1..1024)=524800 points. Rows Y=0..299 contain 262350
// points; ranks 262399/262400 are Y=300, X=49/50, hence Index=307249/307250.
// Each repeated tile duplicates every value equally, leaving rank endpoints unchanged.
const expected = {
	count: populationId === null ? events : 524800 * tiles,
	lower: populationId === null ? [511, 511, 524287, -1] : [300, 300, 307249, -217039],
	upper: populationId === null ? [512, 512, 524288, 0] : [300, 300, 307250, -217038],
};
expected.ranks = {
	indexBase: 0,
	lower: Math.floor((expected.count - 1) / 2),
	upper: Math.floor(expected.count / 2),
};

const resultPath = resolve(values.result),
	logPath = `${resultPath}.log`;
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
	timings = {},
	errors = [];
let phase = "startup",
	phaseStarted = started,
	phaseEvents = 0,
	actualProgressSequence = 0,
	lastActualProgressAt = started;
let root, service, jobId, state, receipt, summary, request;
let generatedHash, inputHash, outputHash, receiptHash, sourceBytes;
let runnerHash, builtHostHash, buildId, shaderHash, adapter;
let failure, caughtSignal, heartbeat, sampler;
let verified = false;
const abort = new AbortController();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rss = () => process.memoryUsage().rss;
function writeText(fd, text) {
	const bytes = Buffer.from(text);
	let offset = 0;
	while (offset < bytes.length) {
		const written = writeSync(fd, bytes, offset, bytes.length - offset);
		assert.ok(written > 0, "Log/result write made no progress");
		offset += written;
	}
}
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
		progressUnit: phase === "generation" ? "rows" : phase === "job" ? "event-visits" : null,
		actualProgressSequence,
		sinceActualProgressMs: performance.now() - lastActualProgressAt,
		rssBytes: rss(),
		...details,
	})}\n`;
	writeText(logFd, line);
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
function progressed(count, details = {}) {
	assert.ok(Number.isSafeInteger(count) && count >= phaseEvents, "Nonmonotonic progress");
	if (count === phaseEvents) return;
	phaseEvents = count;
	actualProgressSequence++;
	lastActualProgressAt = performance.now();
	emit("event-progress", details);
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

try {
	emit("configuration", {
		tiles,
		groups,
		population: values.population,
		populationId,
		gateDefinitions: gates.length,
		expectedExecutionGateCount: populationId === null ? 0 : 2,
		events,
		eventVisits,
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
	runnerHash = sha256(await readFile(new URL(import.meta.url)));
	builtHostHash = sha256(await readFile(new URL("../dist/index.js", import.meta.url)));
	const { writeFcs } = await import("@flow-atlas/fcs");
	const { createAnalysisService } = await import("../dist/index.js");
	timings.moduleSetupMs = performance.now() - phaseStarted;
	abort.signal.throwIfAborted();
	await mkdir(values.workdir, { recursive: true });
	root = await mkdtemp(join(values.workdir, "flow-atlas-median-bench-"));
	enter("generation");
	const hash = createHash("sha256");
	const handle = await open(join(root, "synthetic.fcs"), "wx", 0o600);
	try {
		const metadata = {
			version: "FCS3.1",
			eventCount: events,
			keywords: { EXPERIMENT: "population-median-tile-scalability" },
			channels: channels.map((name, index) => ({
				index: index + 1,
				name,
				bits: 32,
				range: index < 2 ? 1024 : tileEvents,
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
					const i = first + row,
						index = i % tileEvents;
					data[row * 4] = i % 1024;
					data[row * 4 + 1] = Math.floor(i / 1024) % 1024;
					data[row * 4 + 2] = index;
					data[row * 4 + 3] = index - 524288;
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
	assert.equal(sample.sha256, inputHash);
	assert.equal(sample.bytes, sourceBytes);
	assert.equal(sample.eventCount, events);
	assert.equal(sample.channelCount, 4);
	enter("admission");
	request = { sampleId: inputHash, coordinateSpace: "stored-f32", populationId, gates, channels };
	const admissionStarted = performance.now();
	const submitted = await service.invoke("start_population_medians", request, abort.signal);
	jobId = submitted.jobId;
	timings.admissionMs = performance.now() - admissionStarted;
	enter("job");
	const pollStarted = performance.now();
	let previousState;
	for (;;) {
		abort.signal.throwIfAborted();
		state = await service.invoke("get_job", { jobId }, abort.signal);
		progressed(state.processedEvents, { progressDetail: state.progressDetail });
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
	assert.deepEqual(
		state.warnings ?? [],
		[],
		"Job persistence warnings invalidate this measurement",
	);
	timings.jobQueueMs = receipt.timing.queueMs;
	timings.computationBeforePublicationMs = receipt.timing.computationBeforePublicationMs;
	assert.ok(Number.isFinite(timings.jobQueueMs) && timings.jobQueueMs >= 0);
	assert.ok(
		Number.isFinite(timings.computationBeforePublicationMs) &&
			timings.computationBeforePublicationMs > 0,
	);
	adapter = receipt.gpu?.adapter;
	buildId = receipt.buildId;
	shaderHash = receipt.gpu?.shaderHash;
	assert.ok(typeof adapter === "string" && adapter.trim(), "Missing adapter identity");
	assert.ok(
		!/llvmpipe|lavapipe|swiftshader|software|microsoft basic|warp/i.test(adapter),
		"Software adapters cannot be labelled hardware performance",
	);
	assert.ok(buildId && /^[a-f0-9]{64}$/.test(shaderHash), "Missing build/shader identity");
	enter("verification");
	const outputBytes = await readFile(join(root, state.result.path));
	const receiptBytes = await readFile(join(root, state.result.receiptPath));
	outputHash = sha256(outputBytes);
	receiptHash = sha256(receiptBytes);
	assert.equal(outputHash, state.result.sha256);
	assert.equal(outputBytes.length, state.result.bytes);
	const artifact = JSON.parse(outputBytes.toString("utf8"));
	assert.deepEqual(JSON.parse(receiptBytes.toString("utf8")), receipt);
	assert.equal(receipt.operation, "population-medians");
	assert.equal(receipt.state, "succeeded");
	assert.equal(receipt.jobId, jobId);
	assert.equal(artifact.jobId, jobId);
	assert.equal(receipt.input.sha256, inputHash);
	assert.deepEqual(receipt.recipe, request);
	assert.deepEqual(artifact.recipe, request);
	assert.ok(/^[a-f0-9]{64}$/.test(receipt.recipeHash));
	assert.equal(artifact.recipeHash, receipt.recipeHash);
	assert.deepEqual(receipt.output, state.result);
	assert.equal(receipt.maxChunkBytes, maxChunkBytes);
	assert.equal(state.processedEvents, eventVisits);
	assert.equal(state.totalEvents, eventVisits);
	assert.equal(receipt.eventVisits, eventVisits);
	assert.equal(receipt.progressUnit, "event-visits");
	summary = artifact.summary;
	assert.deepEqual(receipt.summary, summary);
	assert.equal(summary.coordinateSpace, "stored-f32");
	assert.equal(summary.populationId, populationId);
	assert.deepEqual(summary.channels, channels);
	assert.equal(summary.count, expected.count);
	assert.deepEqual(summary.lower, expected.lower);
	assert.deepEqual(summary.upper, expected.upper);
	assert.deepEqual(summary.ranks, expected.ranks);
	assert.equal(
		summary.gateNumericalPolicy,
		populationId === null ? null : "stored-f32-finite-geometric-even-odd-bounded-v1",
	);
	assert.deepEqual(summary.diagnostics, {
		algorithm: "gpu-radix256-exact-rank-v1",
		passCount: 4,
		precision: "exact-f32-rank-endpoints",
		scope: "selected-population-not-vendor-parity",
		zeroPolicy: "canonical-positive-zero",
		subnormalPolicy: "preserve-integer-bit-order",
		sourceRows: events,
	});
	abort.signal.throwIfAborted();
	timings.verificationMs = performance.now() - phaseStarted;
	verified = true;
	emit("verified", { count: summary.count, endpoints: 8, inputHash, outputHash, receiptHash });
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
	const succeeded = verified && !failure && !caughtSignal;
	const result = {
		schemaVersion: 1,
		status: succeeded ? "succeeded" : "failed",
		measurement:
			"Single cold-service hardware run; exact F32 rank endpoints, not native MedianExact or averaged midpoints",
		tiles,
		groups,
		population: values.population,
		populationId,
		gateDefinitionCount: gates.length,
		expectedExecutionGateCount: populationId === null ? 0 : 2,
		gateScope:
			"All supplied definitions are validated; only the selected population dependency closure executes",
		channels,
		events,
		eventVisits,
		parameters,
		payloadBytes: events * 16,
		logicalDataVisitBytes: eventVisits * 16,
		sourceBytes,
		maxChunkBytes,
		generationChunkEvents: 65536,
		expected,
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
		receiptHash,
		recipeHash: receipt?.recipeHash,
		timings,
		phases,
		operationTiming: receipt?.timing ?? null,
		logicalDataVisitMBPerSecond: succeeded
			? (eventVisits * 16) / (timings.admissionThroughTerminalObservationMs / 1000) / 1e6
			: null,
		throughputScope:
			"Four logical DATA visits divided by admission-through-terminal-observation wall time. NOT measured I/O bandwidth, GPU-only time or unique input throughput. Initial pinned full-file hash verification is additional work; OS cache state is uncontrolled.",
		timingScope:
			"Receipt computation includes GPU initialization/lease, initial hash verification, four streaming/gating/rank passes, transfers and encoding before publication. No isolated kernel/setup breakdown is available. Admission/execution can overlap; polling adds observation delay.",
		peakRssBytes: process.resourceUsage().maxRSS * 1024,
		rssScope:
			"Lifetime RSS high-water includes generation/setup in this same process. Per-phase 100 ms samples are absolute RSS, not isolated job allocations or GPU VRAM; driver allocations may not be fully represented.",
		gpuAllocationHighWater: "not instrumented",
		cacheState: "OS/driver caches not cleared; no warm-run distribution",
		verified,
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
		writeText(resultFd, `${JSON.stringify(result, null, 2)}\n`);
		emit("complete", { status: result.status, resultPath, logPath });
		fsyncSync(resultFd);
		fsyncSync(logFd);
	} finally {
		closeSync(resultFd);
		closeSync(logFd);
		process.off("SIGINT", sigint);
		process.off("SIGTERM", sigterm);
	}
	if (!succeeded) process.exitCode = 1;
}
