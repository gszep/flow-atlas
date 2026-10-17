import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FcsFile, openFcs, writeFcs } from "@flow-atlas/fcs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAnalysisService } from "../src/analysis.js";
import { canonical } from "../src/artifact-store.js";
import {
	type BatchCountRequest,
	type BatchCountResult,
	resolveBatchCounts,
} from "../src/batch-counts.js";
import type { AnalysisService } from "../src/contracts.js";
import * as gateRunner from "../src/gate-counts.js";
import { createStudioServer } from "../src/server.js";

type Gate = BatchCountRequest["gates"][number];
type Imported = { sampleId: string; source: string; metadata: Omit<FcsFile, "data"> };
type Job = {
	jobId: string;
	state?: string;
	processedEvents?: number;
	error?: { code: string; details?: unknown };
	result?: { path: string; receiptPath: string };
};
let root: string;
let service: AnalysisService;
let studio: Awaited<ReturnType<typeof createStudioServer>>;
let client: Client;
let serial = 0;

function metadata(): Omit<FcsFile, "data"> {
	return {
		version: "FCS3.1",
		eventCount: 1,
		keywords: {},
		channels: ["x", "y", "aux"].map((name, index) => ({
			index: index + 1,
			name,
			bits: 32,
			range: 4096,
			amplification: [0, 0] as [number, number],
			gain: 1,
		})),
	};
}
async function imported(): Promise<Imported> {
	const aux = serial++;
	const name = `boundary-${aux}.fcs`;
	async function* rows() {
		yield new Float32Array([0, 0, aux]);
	}
	const parts: Uint8Array[] = [];
	for await (const part of writeFcs(metadata(), rows())) parts.push(part);
	const bytes = Buffer.concat(parts);
	await writeFile(join(root, name), bytes);
	const reply = (await service.invoke("import_fcs", { path: name })) as {
		sampleId: string;
		source: string;
	};
	const reader = await openFcs({
		size: bytes.length,
		read: async (offset, length) => bytes.subarray(offset, offset + length),
	});
	return { ...reply, metadata: reader.metadata };
}
function rectangle(id = "r"): Gate {
	return {
		id,
		name: id,
		parentId: null,
		dimensions: ["x"],
		geometry: { type: "rectangle", min: [null], max: [1] },
	};
}
async function mcp(name: string, args: Record<string, unknown>) {
	const response = await client.callTool({ name, arguments: args });
	expect(response.isError).not.toBe(true);
	const text = (response.content as Array<{ text: string }>)[0]?.text as string;
	expect(typeof text).toBe("string");
	return { text, value: JSON.parse(text) };
}
async function completed(jobId: string): Promise<Job> {
	let job: Job = { jobId };
	await vi.waitFor(
		async () => {
			job = (await service.invoke("get_job", { jobId })) as Job;
			expect(["succeeded", "failed", "cancelled"]).toContain(job.state);
		},
		{ timeout: 90_000, interval: 25 },
	);
	return job;
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "flow-atlas-batch-boundaries-"));
	service = await createAnalysisService({ root, maxChunkBytes: 1024 });
	studio = await createStudioServer({ service, token: "batch-boundaries-token" });
	client = new Client({ name: "batch-boundaries", version: "1" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${studio.url}/mcp`), {
			requestInit: { headers: { authorization: "Bearer batch-boundaries-token" } },
		}),
	);
}, 30_000);
afterAll(async () => {
	await client?.close();
	await studio?.close();
	await service?.close();
	if (root) await rm(root, { recursive: true, force: true });
});

describe("batch count size, source-integrity, and immutable-admission boundaries", () => {
	it("admits a large shared recipe with 512 rows and serves its bounded successful receipt over real MCP", async () => {
		const sources: Imported[] = [];
		for (let index = 0; index < 32; index++) sources.push(await imported());
		const square: Array<[number, number]> = [
			[-0.5, -0.5],
			[0.5, -0.5],
			[0.5, 0.5],
			[-0.5, 0.5],
		];
		const gates: Gate[] = Array.from({ length: 16 }, (_, index) => ({
			id: `p${index}`,
			name: `p${index}`,
			parentId: null,
			dimensions: ["x", "y"],
			geometry: {
				type: "polygon",
				vertices: Array.from({ length: 64 }, () =>
					square.map(([x, y]): [number, number] => [x, y]),
				).flat(),
			},
		}));
		const request: BatchCountRequest = {
			coordinateSpace: "stored-f32",
			samples: sources.map(({ sampleId }) => ({ sampleId })),
			gates,
		};
		expect(new Set(sources.map(({ sampleId }) => sampleId)).size).toBe(32);
		const requestBytes = Buffer.byteLength(canonical(request));
		expect(requestBytes).toBeGreaterThanOrEqual(45 * 1024);
		expect(requestBytes).toBeLessThanOrEqual(60 * 1024);
		const byId = new Map(sources.map((source) => [source.sampleId, source]));
		const expanded = await resolveBatchCounts(request, async (id) => ({
			id,
			metadata: (byId.get(id) as Imported).metadata,
		}));
		expect(Buffer.byteLength(canonical(expanded))).toBeGreaterThan(1024 * 1024);
		const submission = await mcp("start_batch_gate_counts", request);
		const job = await completed(submission.value.jobId as string);
		expect(job).toMatchObject({ state: "succeeded", processedEvents: 32 });
		expect(job.result).toBeDefined();
		const response = await mcp("get_receipt", { jobId: job.jobId });
		expect(Buffer.byteLength(response.text)).toBeLessThanOrEqual(256 * 1024);
		expect(response.value).toMatchObject({
			operation: "batch-gate-counts",
			state: "succeeded",
			recipe: request,
		});
		const result = response.value.summary as BatchCountResult;
		expect(result).toMatchObject({ sampleCount: 32, gateCount: 16, rowCount: 512 });
		expect(result.samples).toEqual(
			sources.map(({ sampleId }, sampleIndex) => ({
				sampleIndex,
				sampleId,
				startEvent: 0,
				eventCount: 1,
				rootCount: 1,
				recipeHash: expanded.samples[sampleIndex]?.resolved.recipeHash,
			})),
		);
		// The ray crosses the square's right edge once on each traversal. Sixty-four
		// identical traversals toggle even-odd membership 64 times, leaving it false.
		expect(result.rows).toEqual(
			Array.from({ length: 512 }, (_, index) => ({
				sampleIndex: Math.floor(index / 16),
				gateIndex: index % 16,
				count: 0,
				parentCount: 1,
				rootCount: 1,
				frequencyOfParent: 0,
				frequencyOfRoot: 0,
			})),
		);
		const artifact = JSON.parse(
			await readFile(join(root, (job.result as NonNullable<Job["result"]>).path), "utf8"),
		);
		expect(artifact.summary).toEqual(result);
		const persisted = await readFile(
			join(root, ".flow-atlas", "runs", `${job.jobId}.json`),
			"utf8",
		);
		expect(Buffer.byteLength(persisted)).toBeLessThan(1024 * 1024);
		expect(JSON.parse(persisted)).toMatchObject({ state: "succeeded" });
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
	}, 120_000);

	it("fails closed when the second pinned source is corrupted only after the first source completes", async () => {
		const first = await imported(),
			second = await imported();
		const run = gateRunner.runGateCounts;
		const entered: string[] = [],
			succeeded: string[] = [];
		let corrupted = false;
		const spy = vi.spyOn(gateRunner, "runGateCounts").mockImplementation(async (...args) => {
			const sampleId = args[2].request.sampleId;
			entered.push(sampleId);
			const result = await run(...args);
			succeeded.push(sampleId);
			if (sampleId === first.sampleId) {
				// The import response supplies the owned snapshot path. Change an unused
				// AUX payload byte only after the first real GPU result has returned.
				const path = join(root, second.source);
				const bytes = await readFile(path);
				bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 1;
				await chmod(path, 0o600);
				try {
					await writeFile(path, bytes);
				} finally {
					await chmod(path, 0o400);
				}
				corrupted = true;
			}
			return result;
		});
		try {
			const request: BatchCountRequest = {
				coordinateSpace: "stored-f32",
				samples: [{ sampleId: first.sampleId }, { sampleId: second.sampleId }],
				gates: [rectangle()],
			};
			const submitted = (await service.invoke("start_batch_gate_counts", request)) as Job;
			const job = await completed(submitted.jobId);
			expect(corrupted).toBe(true);
			expect(entered).toEqual([first.sampleId, second.sampleId]);
			expect(succeeded).toEqual([first.sampleId]);
			expect(job).toMatchObject({
				state: "failed",
				processedEvents: 1,
				error: {
					code: "INTEGRITY_ERROR",
					details: {
						sampleIndex: 1,
						sampleId: second.sampleId,
						completedSamples: 1,
						phase: "run",
						cause: { code: "INTEGRITY_ERROR" },
					},
				},
			});
			expect(job.result).toBeUndefined();
			expect(await readdir(join(root, "outputs"))).not.toContain(job.jobId);
			expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
			const response = await mcp("get_receipt", { jobId: job.jobId });
			expect(Buffer.byteLength(response.text)).toBeLessThanOrEqual(256 * 1024);
			expect(response.value).toMatchObject({
				operation: "batch-gate-counts",
				state: "failed",
				processedEvents: 1,
				recipe: request,
				error: JSON.parse(JSON.stringify(job.error)),
			});
			expect(response.value.summary).toBeUndefined();
			expect(response.value.output).toBeUndefined();
		} finally {
			spy.mockRestore();
		}
	}, 30_000);

	it("owns and freezes the full recipe before asynchronous metadata lookup can observe caller mutations", async () => {
		const a = "a".repeat(64),
			b = "b".repeat(64);
		const request: BatchCountRequest = {
			coordinateSpace: "stored-f32",
			samples: [{ sampleId: a, label: "original" }, { sampleId: b }],
			gates: [rectangle()],
		};
		const original = structuredClone(request);
		let release: (() => void) | undefined;
		const deferred = new Promise<void>((resolve) => {
			release = resolve;
		});
		const lookup = vi.fn(async (id: string) => {
			await deferred;
			return { id, metadata: metadata() };
		});
		const pending = resolveBatchCounts(request, lookup);
		expect(lookup.mock.calls).toEqual([[a]]);
		(request.samples[0] as BatchCountRequest["samples"][number]).label = "mutated";
		(request.samples[1] as BatchCountRequest["samples"][number]).sampleId = "c".repeat(64);
		request.samples.push({ sampleId: "d".repeat(64) });
		const gate = request.gates[0] as Gate;
		gate.name = "changed";
		gate.dimensions[0] = "aux";
		if (gate.geometry.type === "rectangle") gate.geometry.max[0] = 100;
		request.gates.push(rectangle("extra"));
		release?.();
		const resolved = await pending;
		const unchanged = await resolveBatchCounts(original, async (id) => ({
			id,
			metadata: metadata(),
		}));
		expect(lookup.mock.calls.map(([id]) => id)).toEqual([a, b]);
		expect(resolved.request).toEqual(original);
		expect(resolved).toEqual(unchanged);
		expect(resolved.totalEvents).toBe(2);
		expect(
			resolved.samples.map(({ sampleId, resolved: source }) => [sampleId, source.request.sampleId]),
		).toEqual([
			[a, a],
			[b, b],
		]);
		const frozen = [
			resolved,
			resolved.request,
			resolved.request.samples,
			resolved.request.samples[0],
			resolved.request.gates,
			resolved.request.gates[0],
			resolved.request.gates[0]?.geometry,
			resolved.samples,
			resolved.samples[0],
			resolved.samples[0]?.resolved,
			resolved.samples[0]?.resolved.request,
			resolved.samples[0]?.resolved.request.gates,
		];
		expect(frozen.every((value) => Object.isFrozen(value))).toBe(true);
		expect(() => {
			(resolved.request.gates[0] as Gate).name = "cannot mutate";
		}).toThrow(TypeError);
	});
});
