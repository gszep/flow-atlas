import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { openFcs, writeFcs } from "@flow-atlas/fcs";
import { createAnalysisService } from "../dist/index.js";

const { values } = parseArgs({
	options: {
		events: { type: "string", default: "1000000" },
		workdir: { type: "string", default: tmpdir() },
		result: { type: "string" },
		keep: { type: "boolean", default: false },
	},
});
const events = Number(values.events),
	parameters = 20;
assert.ok(Number.isSafeInteger(events) && events > 0 && events <= 50_000_000);
await mkdir(values.workdir, { recursive: true });
const root = await mkdtemp(join(values.workdir, "flow-atlas-stream-bench-"));
const started = performance.now();
const timings = {};
let service;
const progress = (phase, details = {}) =>
	console.log(JSON.stringify({ phase, elapsedMs: performance.now() - started, ...details }));
const trueValue = (event, channel) =>
	channel === 0
		? (event % 200) - 100
		: channel === 1
			? (event % 100) - 50
			: (event % 1000) + channel;
try {
	progress("generating", { events, parameters, payloadBytes: events * parameters * 4 });
	const before = performance.now();
	const handle = await open(join(root, "synthetic.fcs"), "wx");
	try {
		const metadata = {
			version: "FCS3.1",
			eventCount: events,
			keywords: { EXPERIMENT: "bounded-native-fcs-benchmark" },
			channels: Array.from({ length: parameters }, (_, index) => ({
				index: index + 1,
				name: `C${index}`,
				bits: 32,
				range: 262144,
				amplification: [0, 0],
				gain: 1,
			})),
			spill: {
				channels: ["C0", "C1"],
				matrix: new Float64Array([1, 0.2, 0.1, 1]),
				source: "$SPILLOVER",
			},
		};
		async function* chunks() {
			for (let first = 0; first < events; first += 65536) {
				const count = Math.min(65536, events - first);
				const data = new Float32Array(count * parameters);
				for (let row = 0; row < count; row++) {
					const event = first + row,
						a = trueValue(event, 0),
						b = trueValue(event, 1);
					data[row * parameters] = a + b * 0.1;
					data[row * parameters + 1] = a * 0.2 + b;
					for (let col = 2; col < parameters; col++)
						data[row * parameters + col] = trueValue(event, col);
				}
				yield data;
				if (first % (65536 * 32) === 0) progress("generating", { completedEvents: first + count });
			}
		}
		for await (const bytes of writeFcs(metadata, chunks())) await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
	timings.generationMs = performance.now() - before;
	service = await createAnalysisService({ root, maxChunkBytes: 4 * 2 ** 20 });
	progress("importing");
	const importStarted = performance.now();
	const sample = await service.invoke("import_fcs", { path: "synthetic.fcs" });
	timings.importMs = performance.now() - importStarted;
	progress("preparing-gpu");
	const setup = performance.now();
	const matrix = await service.invoke("register_compensation", { sampleId: sample.sampleId });
	timings.gpuInitializationAndMatrixMs = performance.now() - setup;
	const exportStarted = performance.now();
	const job = await service.invoke("start_fcs_export", {
		sampleId: sample.sampleId,
		compensationId: matrix.id,
	});
	let state,
		last = 0;
	do {
		state = await service.invoke("get_job", { jobId: job.jobId });
		if (performance.now() - last > 1000) {
			progress("export", {
				state: state.state,
				stage: state.phase,
				processedEvents: state.processedEvents,
				rss: process.memoryUsage().rss,
			});
			last = performance.now();
		}
		if (["succeeded", "failed", "cancelled"].includes(state.state)) break;
		await delay(50);
	} while (performance.now() - exportStarted < 10 * 60_000);
	assert.equal(state.state, "succeeded", JSON.stringify(state));
	timings.exportWallMs = performance.now() - exportStarted;
	const receipt = await service.invoke("get_receipt", { jobId: job.jobId });
	assert.ok(
		!/llvmpipe|swiftshader|software/i.test(receipt.compensation.adapter),
		"Software adapters are correctness-only; do not report their throughput as a hardware benchmark",
	);
	const output = await open(join(root, state.result.path), "r");
	try {
		const reader = await openFcs({
			size: (await output.stat()).size,
			read: async (offset, length) => {
				const bytes = new Uint8Array(length);
				let done = 0;
				while (done < length) {
					const result = await output.read(bytes, done, length - done, offset + done);
					assert.ok(result.bytesRead);
					done += result.bytesRead;
				}
				return bytes;
			},
		});
		assert.equal(reader.metadata.eventCount, events);
		assert.equal(reader.metadata.channels.length, parameters);
		assert.equal(reader.metadata.spill, undefined);
		let worst = 0;
		const probes = [
			...new Set(
				[0, 1, 52427, 52428, 65535, 65536, Math.floor(events / 2), events - 1].filter(
					(v) => v < events,
				),
			),
		];
		for (const first of probes)
			for await (const chunk of reader.chunks({
				startEvent: first,
				eventCount: 1,
				chunkEvents: 1,
			})) {
				for (let col = 0; col < parameters; col++)
					worst = Math.max(worst, Math.abs(chunk.data[col] - trueValue(first, col)));
			}
		assert.ok(worst < 0.0001, `Sampled compensation difference ${worst}`);
		const peakRssBytes = process.resourceUsage().maxRSS * 1024;
		assert.ok(peakRssBytes < 2 * 2 ** 30, `Observed host RSS ${peakRssBytes} exceeds 2 GiB target`);
		const result = {
			events,
			parameters,
			payloadBytes: events * parameters * 4,
			maxChunkBytes: 4 * 2 ** 20,
			peakRssBytes,
			timings,
			operationTiming: receipt.timing,
			payloadMBPerSecond: (events * parameters * 4) / (timings.exportWallMs / 1000) / 1e6,
			sampledEvents: probes,
			sampledMaxAbsError: worst,
			inputHash: sample.sha256,
			outputHash: state.result.sha256,
			buildId: receipt.buildId,
			adapter: receipt.compensation.adapter,
			node: process.version,
			platform: process.platform,
			totalBeforeCleanupMs: performance.now() - started,
			gpuAllocationHighWater: "not instrumented",
			comparison: "Single Node/Dawn baseline; not a Rust comparison or warm-run distribution",
			cacheState: "OS/driver caches were not cleared",
		};
		if (values.result)
			await writeFile(values.result, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
		progress("complete", result);
	} finally {
		await output.close();
	}
} finally {
	await service?.close();
	if (!values.keep) await rm(root, { recursive: true, force: true });
}
