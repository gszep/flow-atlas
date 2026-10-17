import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FcsFile, openFcs, writeFcs } from "@flow-atlas/fcs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { createAnalysisService } from "../src/analysis.js";
import { canonical } from "../src/artifact-store.js";
import {
	type BatchMedianRequest,
	type BatchMedianResult,
	resolveBatchMedians,
} from "../src/batch-medians.js";
import type { AnalysisService } from "../src/contracts.js";
import { createStudioServer } from "../src/server.js";

type Gate = BatchMedianRequest["gates"][number];
type Source = { sampleId: string; metadata: Omit<FcsFile, "data"> };
type Job = {
	jobId: string;
	state?: string;
	processedEvents?: number;
	totalEvents?: number;
	warnings?: unknown[];
	result?: { path: string; receiptPath: string };
};
const channels = Array.from({ length: 16 }, (_, index) => `C${index}`);
const label = (index: number) => `sample ${index}: "α\\β"\n雪`;
function metadata(): Omit<FcsFile, "data"> {
	return {
		version: "FCS3.1",
		eventCount: 1,
		keywords: {},
		channels: channels.map((name, index) => ({
			index: index + 1,
			name,
			bits: 32,
			range: 4096,
			amplification: [0, 0] as [number, number],
			gain: 1,
		})),
	};
}
function sharedGates(): Gate[] {
	const square: Array<[number, number]> = [
		[-0.5, -0.5],
		[0.5, -0.5],
		[0.5, 0.5],
		[-0.5, 0.5],
	];
	const all: Gate = {
		id: "all",
		name: "all",
		parentId: null,
		dimensions: ["C0"],
		geometry: { type: "rectangle", min: [null], max: [null] },
	};
	return [
		all,
		...Array.from(
			{ length: 15 },
			(_, index): Gate => ({
				id: `p${index}`,
				name: `p${index}`,
				parentId: null,
				dimensions: ["C0", "C1"],
				geometry: {
					type: "polygon",
					vertices: Array.from({ length: 64 }, () =>
						square.map(([x, y]): [number, number] => [x, y]),
					).flat(),
				},
			}),
		),
	];
}
async function imported(
	root: string,
	service: AnalysisService,
	sampleIndex: number,
): Promise<Source> {
	async function* rows() {
		yield new Float32Array(channels.map((_, channelIndex) => sampleIndex + 1 + channelIndex / 16));
	}
	const parts: Uint8Array[] = [];
	for await (const bytes of writeFcs(metadata(), rows())) parts.push(bytes.slice());
	const bytes = Buffer.concat(parts);
	const name = `sample-${sampleIndex}.fcs`;
	await writeFile(join(root, name), bytes);
	const reply = (await service.invoke("import_fcs", { path: name })) as { sampleId: string };
	const reader = await openFcs({
		size: bytes.length,
		read: async (offset, length) => bytes.subarray(offset, offset + length),
	});
	return { sampleId: reply.sampleId, metadata: reader.metadata };
}
async function connect(service: AnalysisService) {
	const studio = await createStudioServer({ service, token: "batch-median-boundary-token" });
	const client = new Client({ name: "batch-median-boundaries", version: "1" });
	try {
		await client.connect(
			new StreamableHTTPClientTransport(new URL(`${studio.url}/mcp`), {
				requestInit: { headers: { authorization: "Bearer batch-median-boundary-token" } },
			}),
		);
		return { studio, client };
	} catch (error) {
		await client.close();
		await studio.close();
		throw error;
	}
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
	const response = await client.callTool({ name, arguments: args });
	expect(response.isError).not.toBe(true);
	const text = (response.content as Array<{ text: string }>)[0]?.text as string;
	expect(typeof text).toBe("string");
	return { text, value: JSON.parse(text) };
}
async function completed(service: AnalysisService, jobId: string): Promise<Job> {
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

describe("batch median shared-recipe and resolver boundaries", () => {
	it("persists a large shared recipe with 512 analytic endpoint rows and serves identical bounded MCP receipts after restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "flow-atlas-batch-median-boundary-"));
		let service: AnalysisService | undefined;
		let connection: Awaited<ReturnType<typeof connect>> | undefined;
		try {
			service = await createAnalysisService({ root, maxChunkBytes: 1024 });
			connection = await connect(service);
			const sources: Source[] = [];
			for (let index = 0; index < 32; index++) sources.push(await imported(root, service, index));
			expect(new Set(sources.map(({ sampleId }) => sampleId)).size).toBe(32);
			const request: BatchMedianRequest = {
				coordinateSpace: "stored-f32",
				populationId: "all",
				channels: [...channels],
				gates: sharedGates(),
				samples: sources.map(({ sampleId }, index) => ({ sampleId, label: label(index) })),
			};
			const requestBytes = Buffer.byteLength(canonical(request));
			expect(requestBytes).toBeGreaterThanOrEqual(45 * 1024);
			expect(requestBytes).toBeLessThanOrEqual(60 * 1024);
			expect(requestBytes).toBeLessThan(64 * 1024);
			const sourceMap = new Map(sources.map((source) => [source.sampleId, source]));
			const expanded = await resolveBatchMedians(request, async (id) => ({
				id,
				metadata: (sourceMap.get(id) as Source).metadata,
			}));
			expect(Buffer.byteLength(canonical(expanded))).toBeGreaterThan(1024 * 1024);
			expect(expanded.totalEventVisits).toBe(128);
			// Full recipes remain immutable evidence, while valid unrelated polygons
			// are pruned from each selected-population execution binding.
			expect(
				expanded.samples.map(({ resolved }) => [
					resolved.request.gates.length,
					resolved.gateBinding?.request.gates.map(({ id }) => id),
				]),
			).toEqual(Array.from({ length: 32 }, () => [16, ["all"]]));
			const submission = await call(connection.client, "start_batch_population_medians", request);
			const job = await completed(service, submission.value.jobId as string);
			expect(job).toMatchObject({ state: "succeeded", totalEvents: 128, processedEvents: 128 });
			expect(job.warnings ?? []).toEqual([]);
			expect(job.result).toBeDefined();
			const receipt = await call(connection.client, "get_receipt", { jobId: job.jobId });
			expect(Buffer.byteLength(receipt.text)).toBeLessThanOrEqual(256 * 1024);
			expect(receipt.value).toMatchObject({
				state: "succeeded",
				recipe: request,
				recipeHash: expanded.recipeHash,
			});
			const result = receipt.value.summary as BatchMedianResult;
			expect(result).toMatchObject({
				coordinateSpace: "stored-f32",
				populationId: "all",
				channels,
				sampleCount: 32,
				channelCount: 16,
				rowCount: 512,
			});
			expect(result.rows).toEqual(
				Array.from({ length: 512 }, (_, rowIndex) => {
					const sampleIndex = Math.floor(rowIndex / 16),
						channelIndex = rowIndex % 16;
					const value = sampleIndex + 1 + channelIndex / 16;
					return { sampleIndex, channelIndex, lower: value, upper: value };
				}),
			);
			expect(
				result.samples.map(
					({
						sampleIndex,
						sampleId,
						label,
						startEvent,
						eventCount,
						count,
						ranks,
						recipeHash,
						gateNumericalPolicy,
					}) => ({
						sampleIndex,
						sampleId,
						label,
						startEvent,
						eventCount,
						count,
						ranks,
						recipeHash,
						gateNumericalPolicy,
					}),
				),
			).toEqual(
				sources.map(({ sampleId }, sampleIndex) => ({
					sampleIndex,
					sampleId,
					label: label(sampleIndex),
					startEvent: 0,
					eventCount: 1,
					count: 1,
					ranks: { indexBase: 0, lower: 0, upper: 0 },
					recipeHash: expanded.samples[sampleIndex]?.resolved.recipeHash,
					gateNumericalPolicy: expanded.samples[sampleIndex]?.resolved.gateBinding?.numericalPolicy,
				})),
			);
			expect(
				result.samples.map(({ diagnostics }) => [
					diagnostics.sourceRows,
					diagnostics.passCount,
					diagnostics.precision,
				]),
			).toEqual(Array.from({ length: 32 }, () => [1, 4, "exact-f32-rank-endpoints"]));
			const artifact = await readFile(
				join(root, (job.result as NonNullable<Job["result"]>).path),
				"utf8",
			);
			expect(Buffer.byteLength(artifact)).toBeLessThanOrEqual(256 * 1024);
			expect(JSON.parse(artifact).summary).toEqual(result);
			const persisted = await readFile(
				join(root, ".flow-atlas", "runs", `${job.jobId}.json`),
				"utf8",
			);
			expect(Buffer.byteLength(persisted)).toBeLessThan(1024 * 1024);
			expect(JSON.parse(persisted)).toMatchObject({ state: "succeeded" });
			await connection.client.close();
			await connection.studio.close();
			connection = undefined;
			await service.close();
			service = undefined;
			service = await createAnalysisService({ root, maxChunkBytes: 1024 });
			connection = await connect(service);
			const restored = await call(connection.client, "get_receipt", { jobId: job.jobId });
			expect(Buffer.byteLength(restored.text)).toBeLessThanOrEqual(256 * 1024);
			expect(restored.value).toEqual(receipt.value);
		} finally {
			await connection?.client.close();
			await connection?.studio.close();
			await service?.close();
			await rm(root, { recursive: true, force: true });
		}
	}, 120_000);

	it("snapshots before metadata awaits and preserves admission AbortError, signal reasons and errno details", async () => {
		const a = "a".repeat(64),
			b = "b".repeat(64);
		const request: BatchMedianRequest = {
			coordinateSpace: "stored-f32",
			populationId: "all",
			channels: ["C0", "C1"],
			gates: sharedGates(),
			samples: [{ sampleId: a, label: "before" }, { sampleId: b }],
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
		const pending = resolveBatchMedians(request, lookup);
		expect(lookup.mock.calls).toEqual([[a]]);
		(request.samples[0] as BatchMedianRequest["samples"][number]).label = "after";
		(request.samples[1] as BatchMedianRequest["samples"][number]).sampleId = "c".repeat(64);
		request.samples.push({ sampleId: "d".repeat(64) });
		request.channels.reverse();
		request.populationId = "changed";
		(request.gates[0] as Gate).name = "changed";
		const polygon = (request.gates[1] as Gate).geometry;
		if (polygon.type === "polygon") (polygon.vertices[0] as [number, number])[0] = 100;
		release?.();
		const resolved = await pending;
		const unchanged = await resolveBatchMedians(original, async (id) => ({
			id,
			metadata: metadata(),
		}));
		expect(lookup.mock.calls.map(([id]) => id)).toEqual([a, b]);
		expect(resolved).toEqual(unchanged);
		expect(resolved.request).toEqual(original);
		const frozen = [
			resolved,
			resolved.request,
			resolved.request.samples,
			resolved.request.samples[0],
			resolved.request.channels,
			resolved.request.gates,
			resolved.request.gates[1]?.geometry,
			resolved.samples,
			resolved.samples[0],
			resolved.samples[0]?.resolved.request,
		];
		expect(frozen.every(Object.isFrozen)).toBe(true);
		expect(() => {
			resolved.request.channels[0] = "mutated";
		}).toThrow(TypeError);
		const abortError = new Error("metadata lookup aborted");
		abortError.name = "AbortError";
		await expect(
			resolveBatchMedians(original, async () => {
				throw abortError;
			}),
		).rejects.toBe(abortError);
		const controller = new AbortController(),
			reason = new Error("cancelled during metadata lookup");
		await expect(
			resolveBatchMedians(
				original,
				async (id) => {
					controller.abort(reason);
					return { id, metadata: metadata() };
				},
				controller.signal,
			),
		).rejects.toBe(reason);
		const ioError = Object.assign(new Error("fixture metadata read failed"), {
			code: "EIO",
			details: { stage: "metadata", source: "owned-fixture" },
		});
		await expect(
			resolveBatchMedians(original, async (id) => {
				if (id === b) throw ioError;
				return { id, metadata: metadata() };
			}),
		).rejects.toMatchObject({
			code: "EIO",
			details: {
				sampleIndex: 1,
				sampleId: b,
				completedSamples: 0,
				phase: "resolve",
				cause: { code: "EIO", message: ioError.message, details: ioError.details },
			},
		});
	});
});
