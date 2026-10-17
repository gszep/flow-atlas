import { createHash } from "node:crypto";
import { chmod, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FcsFile, readFcs, readHeader, writeFcs } from "@flow-atlas/fcs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAnalysisService } from "../src/analysis.js";
import { ArtifactStore, writeAll } from "../src/artifact-store.js";
import { type AnalysisService, boundedJson } from "../src/contracts.js";
import { createStudioServer } from "../src/server.js";

type RecordValue = Record<string, unknown>;
type MetadataChannel = FcsFile["channels"][number];
const roots: string[] = [];
const services: AnalysisService[] = [];
const metadata = (count: number): Omit<FcsFile, "data"> => ({
	version: "FCS3.1",
	eventCount: count,
	keywords: { EXPERIMENT: "assay-A" },
	channels: ["A", "B", "FSC-A"].map((name, i) => ({
		index: i + 1,
		name,
		bits: 32,
		range: 262144,
		amplification: [0, 0],
		gain: 1,
	})),
	spill: { channels: ["A", "B"], matrix: new Float64Array([1, 0.2, 0.1, 1]), source: "$SPILLOVER" },
});
const truth = (i: number) => [(i % 17) - 8, (i % 13) - 6, i + 300];
function measured(count: number): Float32Array {
	const data = new Float32Array(count * 3);
	for (let i = 0; i < count; i++) {
		const [a = 0, b = 0, scatter = 0] = truth(i);
		data.set([a + b * 0.1, a * 0.2 + b, scatter], i * 3);
	}
	return data;
}
async function fixture(
	root: string,
	name = "sample.fcs",
	data = measured(333),
	meta = metadata(data.length / 3),
) {
	const handle = await open(join(root, name), "w");
	try {
		for await (const bytes of writeFcs(meta, [data], { chunkBytes: 512 }))
			await writeAll(handle, bytes);
	} finally {
		await handle.close();
	}
}
async function session(): Promise<{ root: string; service: AnalysisService; sampleId: string }> {
	const root = await mkdtemp(join(tmpdir(), "flow-atlas-analysis-"));
	roots.push(root);
	await fixture(root);
	const service = await createAnalysisService({ root, maxChunkBytes: 1024 });
	services.push(service);
	const result = (await service.invoke("import_fcs", { path: "sample.fcs" })) as RecordValue;
	return { root, service, sampleId: result.sampleId as string };
}
async function terminal(service: AnalysisService, jobId: string): Promise<RecordValue> {
	let result: RecordValue = {};
	await vi.waitFor(
		async () => {
			result = (await service.invoke("get_job", { jobId })) as RecordValue;
			expect(["succeeded", "failed", "cancelled"]).toContain(result.state);
		},
		{ timeout: 15_000, interval: 5 },
	);
	return result;
}
async function readOutput(root: string, job: RecordValue) {
	const output = job.result as { path: string; sha256: string };
	const bytes = await readFile(join(root, output.path));
	expect(createHash("sha256").update(bytes).digest("hex")).toBe(output.sha256);
	return readFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("agent FCS backend without GPU", () => {
	it("reserves queue capacity while admission records are being written", async () => {
		const { service, sampleId } = await session();
		let releaseRunning: () => void = () => {};
		let releaseAdmission: () => void = () => {};
		let seenRunning: () => void = () => {};
		let seenAdmission: () => void = () => {};
		const running = new Promise<void>((resolve) => {
			releaseRunning = resolve;
		});
		const admission = new Promise<void>((resolve) => {
			releaseAdmission = resolve;
		});
		const runningSeen = new Promise<void>((resolve) => {
			seenRunning = resolve;
		});
		const admissionSeen = new Promise<void>((resolve) => {
			seenAdmission = resolve;
		});
		let holdAdmission = false;
		const original = ArtifactStore.prototype.saveRun;
		const spy = vi.spyOn(ArtifactStore.prototype, "saveRun").mockImplementation(async function (
			this: ArtifactStore,
			id,
			record,
		) {
			const phase = (record as { phase: string }).phase;
			if (phase === "verifying-input") {
				seenRunning();
				await running;
			}
			if (phase === "queued" && holdAdmission) {
				seenAdmission();
				await admission;
			}
			return original.call(this, id, record);
		});
		const pending: Array<Promise<unknown>> = [];
		try {
			await service.invoke("start_fcs_export", { sampleId });
			await runningSeen;
			for (let i = 0; i < 15; i++) await service.invoke("start_fcs_export", { sampleId });
			holdAdmission = true;
			pending.push(service.invoke("start_fcs_export", { sampleId }));
			await admissionSeen;
			let outcome: string | undefined;
			const overflow = service.invoke("start_fcs_export", { sampleId });
			pending.push(overflow);
			void overflow.then(
				() => {
					outcome = "accepted";
				},
				(error: unknown) => {
					outcome = (error as { code: string }).code;
				},
			);
			await vi.waitFor(() => expect(outcome).toBe("QUEUE_FULL"), { timeout: 1000 });
		} finally {
			releaseAdmission();
			releaseRunning();
			spy.mockRestore();
			await Promise.allSettled(pending);
		}
	});
	it("drains and rejects an admission interrupted by host shutdown", async () => {
		const { root, service, sampleId } = await session();
		let release: () => void = () => {},
			entered: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const seen = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const original = ArtifactStore.prototype.saveRun;
		const spy = vi.spyOn(ArtifactStore.prototype, "saveRun").mockImplementation(async function (
			this: ArtifactStore,
			id,
			record,
		) {
			if ((record as { phase: string }).phase === "queued") {
				entered();
				await gate;
			}
			return original.call(this, id, record);
		});
		const submission = service.invoke("start_fcs_export", { sampleId });
		try {
			await seen;
			let stopped = false;
			const closing = service.close().then(() => {
				stopped = true;
			});
			await Promise.resolve();
			expect(stopped).toBe(false);
			release();
			await expect(submission).rejects.toMatchObject({ code: "CANCELLED" });
			await closing;
			expect(await readdir(join(root, "outputs"))).toEqual([]);
			expect(await readdir(join(root, ".flow-atlas", "runs"))).toEqual([]);
		} finally {
			release();
			spy.mockRestore();
			await Promise.allSettled([submission]);
		}
	});
	it("imports a hashed snapshot, pages metadata, and returns defensive results", async () => {
		const { root, service, sampleId } = await session();
		const bytes = await readFile(join(root, "sample.fcs"));
		expect(sampleId).toBe(createHash("sha256").update(bytes).digest("hex"));
		const info = (await service.invoke("inspect_fcs", {
			sampleId,
			channelOffset: 1,
			channelLimit: 1,
		})) as RecordValue;
		expect(info.channels).toEqual([expect.objectContaining({ name: "B" })]);
		((info.channels as Array<{ name: string }>)[0] as { name: string }).name = "edited";
		expect(((await service.invoke("inspect_fcs", { sampleId })) as RecordValue).channels).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "B" })]),
		);
		await writeFile(join(root, "sample.fcs"), "source replaced after import");
		const preview = (await service.invoke("preview_fcs", {
			sampleId,
			limit: 2,
			channels: ["FSC-A"],
		})) as RecordValue;
		expect(preview.rows).toEqual([[300], [301]]);
		expect(boundedJson(preview)).toContain("stored numeric values");
		await expect(service.invoke("preview_fcs", { sampleId, limit: 101 })).rejects.toMatchObject({
			code: "INVALID_PARAMS",
		});
		await expect(service.invoke("inspect_fcs", { sampleId, eventData: [] })).rejects.toMatchObject({
			code: "INVALID_PARAMS",
		});
	});
	it("exports selected events and reordered/renamed channels with a durable receipt", async () => {
		const { root, service, sampleId } = await session();
		const response = (await service.invoke("start_fcs_export", {
			sampleId,
			channels: ["B", "FSC-A", "A"],
			renameChannels: { B: "CD19" },
			startEvent: 2,
			eventCount: 121,
			keywords: { batch: "trial-2" },
			outputName: "reordered.fcs",
		})) as RecordValue;
		const job = await terminal(service, response.jobId as string);
		expect(job.state).toBe("succeeded");
		expect(job.processedEvents).toBe(121);
		const output = await readOutput(root, job);
		expect(output.channels.map((c) => c.name)).toEqual(["CD19", "FSC-A", "A"]);
		expect(output.eventCount).toBe(121);
		expect(output.spill?.channels).toEqual(["A", "CD19"]);
		expect(output.keywords.BATCH).toBe("trial-2");
		expect(output.keywords.$FIL).toBe("reordered.fcs");
		const source = measured(333);
		const expected = new Float32Array(121 * 3);
		for (let i = 0; i < 121; i++)
			expected.set(
				[
					source[(i + 2) * 3 + 1] as number,
					source[(i + 2) * 3 + 2] as number,
					source[(i + 2) * 3] as number,
				],
				i * 3,
			);
		expect(output.data).toEqual(expected);
		const receipt = (await service.invoke("get_receipt", { jobId: response.jobId })) as RecordValue;
		expect(receipt.input).toMatchObject({ sha256: sampleId });
		expect(receipt.timing).toMatchObject({
			queueMs: expect.any(Number),
			processingMs: expect.any(Number),
		});
		await service.close();
		// A committed output+receipt remains authoritative if the secondary run index was lost.
		await rm(join(root, ".flow-atlas", "runs", `${response.jobId}.json`));
		const restored = await createAnalysisService({ root });
		services.push(restored);
		expect(await restored.invoke("get_receipt", { jobId: response.jobId })).toEqual(receipt);
		expect(await restored.invoke("get_job", { jobId: response.jobId })).toMatchObject({
			state: "succeeded",
			live: false,
		});
	});
	it("keeps the sample catalog after metadata-cache eviction and pages keyword summaries", async () => {
		const { root, service, sampleId } = await session();
		for (let i = 0; i < 33; i++) {
			const meta = metadata(0);
			delete meta.spill;
			meta.keywords.WELL = `${i}`;
			await fixture(root, `well-${i}.fcs`, new Float32Array(), meta);
			await service.invoke("import_fcs", { path: `well-${i}.fcs` });
		}
		expect(await service.invoke("list_samples", { offset: 32, limit: 2 })).toMatchObject({
			total: 34,
			offset: 32,
			items: expect.any(Array),
		});
		const info = (await service.invoke("inspect_fcs", {
			sampleId,
			keywordPrefix: "experiment",
		})) as RecordValue;
		expect(info.basename).toBe("sample.fcs");
		expect(info.keywords).toEqual([
			{ key: "EXPERIMENT", value: "assay-A", truncated: false, characters: 7 },
		]);
	});
	it("keeps acquisition scaling explicit instead of compensating stored non-unit-gain values", async () => {
		const { root, service } = await session();
		const bytes = await readFile(join(root, "sample.fcs"));
		const header = readHeader(
			bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
		);
		const text = bytes.subarray(header.textStart, header.textEnd + 1).toString("utf8");
		const delimiter = text[0] as string;
		const modified = text.replace(
			`${delimiter}$P1G${delimiter}1${delimiter}`,
			`${delimiter}$P1G${delimiter}2${delimiter}`,
		);
		expect(modified).not.toBe(text);
		bytes.set(Buffer.from(modified), header.textStart);
		await writeFile(join(root, "gain.fcs"), bytes);
		const sample = (await service.invoke("import_fcs", { path: "gain.fcs" })) as RecordValue;
		await expect(
			service.invoke("register_compensation", { sampleId: sample.sampleId }),
		).rejects.toMatchObject({
			code: "ACQUISITION_SCALE_UNSUPPORTED",
			details: { channels: ["A"] },
		});
		await expect(
			service.invoke("start_fcs_export", { sampleId: sample.sampleId }),
		).rejects.toMatchObject({ code: "ACQUISITION_SCALE_UNSUPPORTED" });
	});
	it("rejects path escapes and invalid export recipes before creating jobs", async () => {
		const { root, service, sampleId } = await session();
		const outside = await mkdtemp(join(tmpdir(), "flow-atlas-outside-"));
		roots.push(outside);
		await fixture(outside);
		await symlink(outside, join(root, "outside"));
		await expect(
			service.invoke("import_fcs", { path: "outside/sample.fcs" }),
		).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
		for (const args of [
			{ outputName: "../bad.fcs" },
			{ channels: ["A"] },
			{ startEvent: 334 },
			{ renameChannels: { A: "B" } },
			{ keywords: { $TOT: "1" } },
		])
			await expect(service.invoke("start_fcs_export", { sampleId, ...args })).rejects.toThrow();
		expect(await readdir(join(root, "outputs"))).toEqual([]);
	});
	it("rejects tampered input artifacts without publishing partial output", async () => {
		const { root, service, sampleId } = await session();
		await chmod(join(root, ".flow-atlas", "inputs", `${sampleId}.fcs`), 0o600);
		await writeFile(join(root, ".flow-atlas", "inputs", `${sampleId}.fcs`), "tampered");
		const job = (await service.invoke("start_fcs_export", { sampleId })) as RecordValue;
		const result = await terminal(service, job.jobId as string);
		expect(result).toMatchObject({ state: "failed", error: { code: "INTEGRITY_ERROR" } });
		expect(await readdir(join(root, "outputs"))).toEqual([]);
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
	});
	it("cancels at a chunk boundary and persists a terminal observation", async () => {
		const { root, service, sampleId } = await session();
		const job = (await service.invoke("start_fcs_export", { sampleId })) as RecordValue;
		expect(await service.invoke("cancel_job", { jobId: job.jobId })).toMatchObject({
			accepted: true,
		});
		expect(await terminal(service, job.jobId as string)).toMatchObject({ state: "cancelled" });
		expect(await service.invoke("get_receipt", { jobId: job.jobId })).toMatchObject({
			state: "cancelled",
		});
		expect(await readdir(join(root, "outputs"))).toEqual([]);
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
	});
	it("encodes nonfinite previews explicitly and never exposes event arrays in metadata", async () => {
		const { root, service } = await session();
		const data = measured(2);
		data[0] = Number.NaN;
		data[1] = Number.POSITIVE_INFINITY;
		await fixture(root, "nonfinite.fcs", data);
		const sample = (await service.invoke("import_fcs", { path: "nonfinite.fcs" })) as RecordValue;
		const preview = (await service.invoke("preview_fcs", {
			sampleId: sample.sampleId,
			limit: 1,
		})) as RecordValue;
		expect(preview.rows).toEqual([[null, null, 300]]);
		expect(() => boundedJson(preview)).not.toThrow();
		const listing = (await service.invoke("list_samples", {})) as RecordValue;
		expect(JSON.stringify(listing)).not.toContain('"data":');
	});
	it("publishes zero-event FCS and preserves prototype-like channel names", async () => {
		const { root, service } = await session();
		const meta = metadata(0);
		delete meta.spill;
		(meta.channels[0] as MetadataChannel).name = "toString";
		await fixture(root, "empty.fcs", new Float32Array(), meta);
		const sample = (await service.invoke("import_fcs", { path: "empty.fcs" })) as RecordValue;
		const job = (await service.invoke("start_fcs_export", {
			sampleId: sample.sampleId,
			renameChannels: {},
		})) as RecordValue;
		const finished = await terminal(service, job.jobId as string);
		expect(finished.state).toBe("succeeded");
		const output = await readOutput(root, finished);
		expect(output.eventCount).toBe(0);
		expect(output.channels[0]?.name).toBe("toString");
	});
});

describe("agent compensation workflow", () => {
	let root: string, service: AnalysisService, sampleId: string, compensationId: string;
	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "flow-atlas-gpu-analysis-"));
		await fixture(root);
		service = await createAnalysisService({ root, maxChunkBytes: 1024 });
		sampleId = ((await service.invoke("import_fcs", { path: "sample.fcs" })) as RecordValue)
			.sampleId as string;
		compensationId = ((await service.invoke("register_compensation", { sampleId })) as RecordValue)
			.id as string;
	}, 30_000);
	afterAll(async () => {
		await service?.close();
		if (root) await rm(root, { recursive: true, force: true });
	});
	it("previews and exports GPU-compensated values with explicit matrix provenance", async () => {
		const preview = (await service.invoke("preview_fcs", {
			sampleId,
			compensationId,
			limit: 3,
			channels: ["B", "A"],
		})) as RecordValue;
		const actual = preview.rows as number[][];
		expect(actual[0]?.[0]).toBeCloseTo(-6, 4);
		expect(actual[0]?.[1]).toBeCloseTo(-8, 4);
		const job = (await service.invoke("start_fcs_export", {
			sampleId,
			compensationId,
			channels: ["FSC-A", "B"],
			renameChannels: { B: "CD19" },
			startEvent: 7,
			eventCount: 129,
		})) as RecordValue;
		const finished = await terminal(service, job.jobId as string);
		expect(finished.state).toBe("succeeded");
		const output = await readOutput(root, finished);
		expect(output.spill).toBeUndefined();
		expect(output.keywords.$SPILLOVER).toBeUndefined();
		expect(output.keywords.FLOWATLAS_COMPENSATED).toBe("true");
		expect(output.keywords.FLOWATLAS_COMPENSATION_ID).toBe(compensationId);
		let worst = 0;
		for (let i = 0; i < 129; i++) {
			const t = truth(i + 7);
			worst = Math.max(
				worst,
				Math.abs((output.data[i * 2] as number) - (t[2] as number)),
				Math.abs((output.data[i * 2 + 1] as number) - (t[1] as number)),
			);
		}
		expect(worst).toBeLessThan(0.0001);
		const receipt = (await service.invoke("get_receipt", { jobId: job.jobId })) as RecordValue;
		expect(receipt.compensation).toMatchObject({
			channels: ["A", "B"],
			matrix: [1, 0.2, 0.1, 1],
			diagnostics: { source: "gpu-computation", status: 0 },
			shaderHash: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});
	it("returns numerical rejection diagnostics and retains valid registered matrices", async () => {
		await expect(
			service.invoke("register_compensation", {
				sampleId,
				spillover: { channels: ["A", "B"], matrix: [1, 1, 1, 1] },
			}),
		).rejects.toMatchObject({
			code: "NUMERICAL_REJECTION",
			details: { source: "gpu-computation", status: 1 },
		});
		expect(((await service.invoke("register_compensation", { sampleId })) as RecordValue).id).toBe(
			compensationId,
		);
	});
	it("discards an export that fails after earlier compensated chunks", async () => {
		const data = measured(333);
		data[332 * 3] = Number.NaN;
		await fixture(root, "late-error.fcs", data);
		const imported = (await service.invoke("import_fcs", {
			path: "late-error.fcs",
		})) as RecordValue;
		const matrix = (await service.invoke("register_compensation", {
			sampleId: imported.sampleId,
		})) as RecordValue;
		const job = (await service.invoke("start_fcs_export", {
			sampleId: imported.sampleId,
			compensationId: matrix.id,
		})) as RecordValue;
		const result = await terminal(service, job.jobId as string);
		expect(result).toMatchObject({
			state: "failed",
			error: { code: "NUMERICAL_REJECTION", details: { status: 4 } },
		});
		expect(result.processedEvents).toBeGreaterThan(0);
		expect(result.result).toBeUndefined();
		expect(await readdir(join(root, "outputs"))).not.toContain(job.jobId);
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
	});
});

it("executes the real compensation/export backend through MCP and observes the same job over RPC", async () => {
	const { root, service, sampleId } = await session();
	const token = "analysis-integration-token";
	const server = await createStudioServer({ service, token });
	const client = new Client({ name: "wet-lab-test", version: "1" });
	try {
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
				requestInit: { headers: { authorization: `Bearer ${token}` } },
			}),
		);
		const call = async (name: string, args: RecordValue) => {
			const result = await client.callTool({ name, arguments: args });
			expect(result.isError).not.toBe(true);
			const first = (result.content as Array<{ type: string; text: string }>)[0];
			expect(first?.type).toBe("text");
			return JSON.parse(first?.text ?? "null") as RecordValue;
		};
		const matrix = await call("register_compensation", { sampleId });
		const started = await call("start_fcs_export", {
			sampleId,
			compensationId: matrix.id,
			eventCount: 12,
		});
		const finished = await terminal(service, started.jobId as string);
		expect(finished.state).toBe("succeeded");
		const response = await fetch(`${server.url}/rpc`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "get_receipt",
				params: { jobId: started.jobId },
			}),
		});
		const body = (await response.json()) as { result: RecordValue };
		expect(body.result).toMatchObject({
			jobId: started.jobId,
			state: "succeeded",
			input: { sha256: sampleId },
		});
		const output = await readOutput(root, finished);
		expect(output.data[0]).toBeCloseTo(-8, 4);
		expect(output.data[1]).toBeCloseTo(-6, 4);
	} finally {
		await client.close();
		await server.close();
	}
}, 30_000);
