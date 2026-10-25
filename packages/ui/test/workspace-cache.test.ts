import { expect, it, vi } from "vitest";
import type { BrowserCache } from "../src/browser-cache.js";
import { bytesHash, type PublicationManifest } from "../src/publication.js";
import {
	restoreWorkspaceCache,
	validCacheMetadata,
	workspaceCacheKey,
} from "../src/workspace-cache.js";

const manifest = {
	eventCount: 2,
	sampleCount: 1,
	files: [
		{
			name: "a.fcs",
			path: "a.fcs",
			kind: "fcs",
			events: 2,
			channels: 1,
			bytes: 8,
			sha256: "a".repeat(64),
		},
	],
} as PublicationManifest;
function metadata() {
	return {
		n: 2,
		sourceEventCount: 2,
		sampling: null,
		channels: ["X"],
		channelPresent: [[{ start: 0, count: 2 }]],
		embedChannels: [0],
		samples: [
			{
				name: "a",
				basename: "a.fcs",
				offset: 0,
				count: 2,
				sourceOffset: 0,
				sourceCount: 2,
				groups: [],
				gateCounts: [],
			},
		],
		populations: [],
		words: 1,
		conditions: [],
		batches: [],
		bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
	};
}
it("invalidates computed results for changed input, engine, or window settings", async () => {
	const first = await workspaceCacheKey(manifest, 128, "engine-a");
	expect(await workspaceCacheKey(manifest, 128, "engine-a")).toBe(first);
	expect(await workspaceCacheKey(manifest, 128, "engine-b")).not.toBe(first);
	expect(await workspaceCacheKey(manifest, 64, "engine-a")).not.toBe(first);
	expect(
		await workspaceCacheKey(
			{ ...manifest, files: manifest.files.map((f) => ({ ...f, sha256: "b".repeat(64) })) },
			128,
			"engine-a",
		),
	).not.toBe(first);
});
it("does not accept a sampled or misbound map as the full dataset", () => {
	expect(validCacheMetadata(metadata(), manifest)).toBe(true);
	expect(validCacheMetadata({ ...metadata(), n: 1 }, manifest)).toBe(false);
	expect(validCacheMetadata({ ...metadata(), sampling: { selectedEventCount: 2 } }, manifest)).toBe(
		false,
	);
	const wrong = metadata();
	wrong.samples[0] = {
		...wrong.samples[0],
		basename: "wrong.fcs",
	} as (typeof wrong.samples)[number];
	expect(validCacheMetadata(wrong, manifest)).toBe(false);
});
it("rejects a corrupt computed buffer before GPU allocation", async () => {
	const entries = new Map<string, unknown>();
	const zero = new ArrayBuffer(8),
		sha256 = await bytesHash(zero);
	const payload = {
		version: 1,
		key: "expected",
		metadata: metadata(),
		computation: { projectedEventCount: 2, renderedEventCount: 2 },
		buffers: [
			{ slot: "channel:0", key: "map-data:aaaa:channel:0", bytes: 8, sha256 },
			{ slot: "sampleId", key: "map-data:aaaa:sampleId", bytes: 8, sha256 },
			{ slot: "labels", key: "map-data:aaaa:labels", bytes: 8, sha256 },
			{ slot: "embedding", key: "map-data:aaaa:embedding", bytes: 16, sha256 },
		],
	};
	entries.set("map:current", {
		...payload,
		metadataHash: await bytesHash(new TextEncoder().encode(JSON.stringify(payload)).buffer),
	});
	entries.set("map-data:aaaa:channel:0", new Blob([new Uint32Array([999, 999])]));
	const cache: BrowserCache = {
		get: async (key) => entries.get(key),
		put: async () => false,
		remove: async () => {},
		retain: async () => {},
	};
	const device = { createBuffer: vi.fn() } as unknown as GPUDevice;
	expect(await restoreWorkspaceCache(cache, "expected", manifest, device)).toBeNull();
	expect(device.createBuffer).not.toHaveBeenCalled();
});
