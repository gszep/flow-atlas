import { readback, upload } from "@flow-atlas/compute";
import type { BrowserCache } from "./browser-cache.js";
import type { ComputationRecord } from "./computation.js";
import {
	bytesHash,
	PUBLICATION_EMBED_OPTIONS,
	type PublicationManifest,
	rawCacheKey,
} from "./publication.js";
import type { LoadedWorkspace } from "./workspace.js";

declare const __FLOW_ATLAS_ENGINE_ID__: string;
const HEAD = "map:current";
const MAX_BYTES = 512 * 2 ** 20;
const READBACK_CHUNK_BYTES = 4 * 2 ** 20;

/** Keep temporary GPU staging small even when a cached channel contains millions of rows. */
async function readCacheBuffer(
	device: GPUDevice,
	buffer: GPUBuffer,
	bytes: number,
): Promise<ArrayBuffer> {
	const output = new Uint32Array(bytes / 4);
	for (let offset = 0; offset < bytes; offset += READBACK_CHUNK_BYTES) {
		const length = Math.min(READBACK_CHUNK_BYTES, bytes - offset);
		const chunk = await readback(device, buffer, Uint32Array, length, offset);
		output.set(chunk, offset / 4);
	}
	return output.buffer;
}
type Metadata = Pick<
	LoadedWorkspace,
	| "n"
	| "sourceEventCount"
	| "sampling"
	| "channels"
	| "channelPresent"
	| "embedChannels"
	| "samples"
	| "populations"
	| "words"
	| "conditions"
	| "batches"
	| "bounds"
>;
interface CachedHead {
	version: 1;
	key: string;
	metadata: Metadata;
	computation: ComputationRecord;
	buffers: Array<{ slot: string; key: string; bytes: number; sha256: string }>;
	metadataHash: string;
}
const hashObject = (value: unknown) =>
	bytesHash(new TextEncoder().encode(JSON.stringify(value)).buffer);
const strings = (value: unknown): value is string[] =>
	Array.isArray(value) &&
	value.length <= 128 &&
	value.every((x) => typeof x === "string" && x.length > 0 && x.length <= 4096);

export async function workspaceCacheKey(
	manifest: PublicationManifest,
	windowBytes: number,
	engine = __FLOW_ATLAS_ENGINE_ID__,
): Promise<string> {
	return hashObject({
		format: 1,
		engine,
		files: manifest.files,
		profile: PUBLICATION_EMBED_OPTIONS,
		projection: "all-source-events",
		windowBytes,
	});
}

function bufferLayout(metadata: Metadata): Array<[string, number]> {
	return [
		...metadata.channels.map((_, index): [string, number] => [`channel:${index}`, metadata.n * 4]),
		["sampleId", metadata.n * 4],
		["labels", metadata.n * metadata.words * 4],
		["embedding", metadata.n * 8],
	];
}

/** Cache is a best-effort local optimization, never an independently verified scientific receipt. */
export function validCacheMetadata(
	value: unknown,
	manifest: PublicationManifest,
): value is Metadata {
	if (!value || typeof value !== "object") return false;
	const m = value as Metadata;
	if (
		m.n !== manifest.eventCount ||
		m.sourceEventCount !== m.n ||
		m.sampling !== null ||
		!strings(m.channels) ||
		!m.channels.length ||
		new Set(m.channels).size !== m.channels.length ||
		!strings(m.populations) ||
		!strings(m.conditions) ||
		!strings(m.batches) ||
		m.words !== Math.max(1, Math.ceil(m.populations.length / 32))
	)
		return false;
	if (
		!Array.isArray(m.embedChannels) ||
		!m.embedChannels.length ||
		new Set(m.embedChannels).size !== m.embedChannels.length ||
		!m.embedChannels.every((i) => Number.isSafeInteger(i) && i >= 0 && i < m.channels.length)
	)
		return false;
	if (
		!m.bounds ||
		!Object.values(m.bounds).every(Number.isFinite) ||
		!(m.bounds.minX < m.bounds.maxX) ||
		!(m.bounds.minY < m.bounds.maxY)
	)
		return false;
	if (!Array.isArray(m.samples) || m.samples.length !== manifest.sampleCount) return false;
	let offset = 0;
	const names = new Set<string>();
	for (const sample of m.samples) {
		const source = manifest.files.find(
			(file) => file.kind === "fcs" && file.name === sample.basename,
		);
		if (
			!source ||
			names.has(sample.basename) ||
			sample.count !== source.events ||
			sample.sourceCount !== source.events ||
			sample.offset !== offset ||
			sample.sourceOffset !== offset ||
			!strings(sample.groups) ||
			!Array.isArray(sample.gateCounts) ||
			sample.gateCounts.length > 1024
		)
			return false;
		names.add(sample.basename);
		offset += sample.count;
		if (
			!sample.gateCounts.every(
				(gate) =>
					typeof gate.name === "string" &&
					Number.isSafeInteger(gate.count) &&
					gate.count >= 0 &&
					gate.count <= sample.count,
			)
		)
			return false;
	}
	if (
		offset !== m.n ||
		!Array.isArray(m.channelPresent) ||
		m.channelPresent.length !== m.channels.length
	)
		return false;
	for (const ranges of m.channelPresent) {
		if (!Array.isArray(ranges) || ranges.length > m.samples.length) return false;
		let end = 0;
		for (const range of ranges) {
			if (
				!Number.isSafeInteger(range.start) ||
				!Number.isSafeInteger(range.count) ||
				range.start < end ||
				range.count < 0 ||
				range.start + range.count > m.n
			)
				return false;
			end = range.start + range.count;
		}
	}
	return bufferLayout(m).reduce((sum, [, bytes]) => sum + bytes, 0) <= MAX_BYTES;
}

export async function restoreWorkspaceCache(
	cache: BrowserCache,
	key: string,
	manifest: PublicationManifest,
	device: GPUDevice,
): Promise<{ workspace: LoadedWorkspace; computation: ComputationRecord } | null> {
	let head: CachedHead;
	const arrays = new Map<string, ArrayBuffer>();
	try {
		head = (await cache.get(HEAD)) as CachedHead;
		if (
			head?.version !== 1 ||
			head.key !== key ||
			!validCacheMetadata(head.metadata, manifest) ||
			!head.computation ||
			head.computation.projectedEventCount !== manifest.eventCount ||
			head.computation.renderedEventCount !== manifest.eventCount
		)
			return null;
		const { metadataHash, ...payload } = head;
		if ((await hashObject(payload)) !== metadataHash) return null;
		const layout = bufferLayout(head.metadata);
		if (!Array.isArray(head.buffers) || head.buffers.length !== layout.length) return null;
		for (const [slot, bytes] of layout) {
			const entry = head.buffers.find((buffer) => buffer.slot === slot);
			if (!entry || entry.bytes !== bytes || !/^map-data:[a-f0-9-]+:[\w:]+$/.test(entry.key))
				return null;
			const blob = await cache.get(entry.key);
			if (!(blob instanceof Blob) || blob.size !== bytes) return null;
			const data = await blob.arrayBuffer();
			if ((await bytesHash(data)) !== entry.sha256) return null;
			arrays.set(slot, data);
		}
	} catch {
		return null;
	}
	// All metadata and byte hashes are checked before allocating any device buffers.
	const buffers = new Map<string, GPUBuffer>();
	try {
		for (const [slot, data] of arrays)
			buffers.set(slot, upload(device, new Uint32Array(data), `cached:${slot}`));
		await device.queue.onSubmittedWorkDone();
		const workspace: LoadedWorkspace = {
			...head.metadata,
			channelBuffers: head.metadata.channels.map(
				(_, i) => buffers.get(`channel:${i}`) as GPUBuffer,
			),
			sampleId: buffers.get("sampleId") as GPUBuffer,
			labels: buffers.get("labels") as GPUBuffer,
			embedding: buffers.get("embedding") as GPUBuffer,
			som: null,
			bmu: null,
		};
		return { workspace, computation: head.computation };
	} catch (error) {
		for (const buffer of buffers.values()) buffer.destroy();
		throw error;
	}
}

export async function saveWorkspaceCache(
	cache: BrowserCache,
	key: string,
	manifest: PublicationManifest,
	device: GPUDevice,
	workspace: LoadedWorkspace,
	computation: ComputationRecord,
	onFailure?: (reason: string) => void,
): Promise<boolean> {
	const metadata: Metadata = structuredClone({
		n: workspace.n,
		sourceEventCount: workspace.sourceEventCount,
		sampling: workspace.sampling,
		channels: workspace.channels,
		channelPresent: workspace.channelPresent,
		embedChannels: workspace.embedChannels,
		samples: workspace.samples,
		populations: workspace.populations,
		words: workspace.words,
		conditions: workspace.conditions,
		batches: workspace.batches,
		bounds: workspace.bounds,
	});
	if (!validCacheMetadata(metadata, manifest)) {
		onFailure?.("Map cache metadata rejected");
		return false;
	}
	const generation = crypto.randomUUID(),
		written: string[] = [];
	try {
		const buffers: CachedHead["buffers"] = [];
		for (const [slot, bytes] of bufferLayout(metadata)) {
			const buffer = slot.startsWith("channel:")
				? workspace.channelBuffers[Number(slot.split(":")[1])]
				: slot === "sampleId"
					? workspace.sampleId
					: slot === "labels"
						? workspace.labels
						: workspace.embedding;
			if (!buffer) throw new Error("Missing cache buffer");
			const data = await readCacheBuffer(device, buffer, bytes),
				storageKey = `map-data:${generation}:${slot}`;
			written.push(storageKey);
			if (!(await cache.put(storageKey, new Blob([data]))))
				throw new Error("Cache write unavailable");
			buffers.push({
				slot,
				key: storageKey,
				bytes,
				sha256: await bytesHash(data),
			});
		}
		const payload = {
			version: 1 as const,
			key,
			metadata,
			computation: structuredClone(computation),
			buffers,
		};
		if (!(await cache.put(HEAD, { ...payload, metadataHash: await hashObject(payload) })))
			throw new Error("Cache commit unavailable");
		// Keep only current raw files and this complete derived result. Partial/missing cache
		// generations from another tab are misses and are never restored as partial maps.
		await cache.retain(new Set([HEAD, ...written, ...manifest.files.map(rawCacheKey)]));
		return true;
	} catch (error) {
		onFailure?.(error instanceof Error ? error.message : String(error));
		await Promise.all(written.map((name) => cache.remove(name).catch(() => {})));
		return false;
	}
}
