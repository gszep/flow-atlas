import { describe, expect, it, vi } from "vitest";
import {
	downloadPublicationFiles,
	loadPublicationDataset,
	type PublicationFile,
	type PublicationManifest,
	type PublicationProgress,
	validatePublicationManifest,
} from "../src/publication.js";

function manifest(): PublicationManifest {
	const bytes = 290739412,
		events = 3885530;
	return {
		schemaVersion: 1,
		id: "flowatlas-publication-companion-v1",
		title: "FlowAtlas publication companion dataset",
		citation: {
			title: "FlowAtlas publication",
			doi: "10.3389/fimmu.2024.1425488",
			url: "https://doi.org/10.3389/fimmu.2024.1425488",
		},
		sourceVersion: "local-companion-2026-10-25",
		sampleCount: 33,
		eventCount: events,
		totalBytes: 295841667,
		files: [
			{
				path: "workspace.wsp",
				name: "workspace.wsp",
				kind: "wsp",
				bytes: 5102255,
				sha256: "00796effe02b7a4702e136fe87132a975d06b5e65f1856a95732573e284ac70c",
			},
			...Array.from(
				{ length: 33 },
				(_, index): PublicationFile => ({
					path: `donor ${index}/sample-${index}.fcs`,
					name: `sample-${index}.fcs`,
					kind: "fcs",
					sha256: "a".repeat(64),
					bytes: index < 32 ? Math.floor(bytes / 33) : bytes - 32 * Math.floor(bytes / 33),
					events: index < 32 ? Math.floor(events / 33) : events - 32 * Math.floor(events / 33),
					channels: 19,
				}),
			),
		],
		notes: ["Paper describes 32 files; this companion copy contains 33."],
	};
}
async function entry(path: string, bytes: Uint8Array): Promise<PublicationFile> {
	const hash = Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))),
		(value) => value.toString(16).padStart(2, "0"),
	).join("");
	return {
		path,
		name: path.split("/").at(-1) as string,
		bytes: bytes.length,
		kind: path.endsWith(".wsp") ? "wsp" : "fcs",
		sha256: hash,
	};
}
const baseUrl = "https://example.test/project/index.html";

describe("publication manifest and bounded verified transport (mock payloads only)", () => {
	it("accepts the agreed complete companion manifest without requiring optional per-file metadata", () => {
		const input = manifest();
		expect(validatePublicationManifest(input)).toEqual(input);
		for (const file of input.files) {
			delete file.events;
			delete file.channels;
		}
		expect(validatePublicationManifest(input).files).toHaveLength(34);
	});
	it.each([
		"../a.fcs",
		"/a.fcs",
		"https://evil.test/a.fcs",
		"a/../b.fcs",
		"a/%2e%2e/b.fcs",
		"a\\b.fcs",
		"a//b.fcs",
		"a.fcs?q=1",
		"a.fcs#fragment",
		"a\u0000.fcs",
	])("rejects unsafe path %s", (path) => {
		const input = manifest();
		(input.files[1] as PublicationFile).path = path;
		expect(() => validatePublicationManifest(input)).toThrow(/Publication dataset/);
	});
	it("rejects duplicate names, unsupported extensions, size/hash/count inconsistencies", () => {
		const changes: Array<(input: PublicationManifest) => void> = [
			(input) => {
				input.files[2] = { ...(input.files[1] as PublicationFile) };
			},
			(input) => {
				const file = input.files[1] as PublicationFile;
				file.path = "x.html";
				file.name = "x.html";
			},
			(input) => {
				(input.files[1] as PublicationFile).bytes = 64 * 2 ** 20 + 1;
			},
			(input) => {
				(input.files[1] as PublicationFile).bytes = 0;
			},
			(input) => {
				(input.files[1] as PublicationFile).sha256 = "not-a-hash";
			},
			(input) => {
				(input.files[0] as PublicationFile).sha256 = "a".repeat(64);
			},
			(input) => {
				input.sampleCount = 32;
			},
			(input) => {
				input.eventCount--;
			},
			(input) => {
				input.totalBytes--;
			},
			(input) => {
				(input.files[1] as PublicationFile).events = 1;
			},
			(input) => {
				input.files.pop();
			},
		];
		const rejected = changes.map((change) => {
			const input = manifest();
			change(input);
			try {
				validatePublicationManifest(input);
				return false;
			} catch {
				return true;
			}
		});
		expect(rejected.every(Boolean)).toBe(true);
	});
	it("uses at most two GETs, segment-encoded relative URLs, complete hashes and exact byte progress", async () => {
		const payloads = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])];
		const files = await Promise.all([
			entry("donor A/a.fcs", payloads[0] as Uint8Array),
			entry("workspace.wsp", payloads[1] as Uint8Array),
			entry("other/c.fcs", payloads[2] as Uint8Array),
		]);
		let active = 0,
			peak = 0;
		const progress: PublicationProgress[] = [];
		const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const index = files.findIndex((file) =>
				String(input).endsWith(file.path.split("/").map(encodeURIComponent).join("/")),
			);
			expect(init).toMatchObject({ method: "GET", credentials: "omit", redirect: "error" });
			active++;
			peak = Math.max(peak, active);
			const data = payloads[index] as Uint8Array;
			return new Response(
				new ReadableStream({
					async start(controller) {
						await new Promise((resolve) => setTimeout(resolve, 5));
						controller.enqueue(data);
						controller.close();
						active--;
					},
				}),
				{ headers: { "content-length": String(data.length) } },
			);
		});
		const loaded = await downloadPublicationFiles(
			{ files, totalBytes: 6 },
			{ baseUrl, fetch: fetcher as typeof fetch, onProgress: (value) => progress.push(value) },
		);
		expect(peak).toBe(2);
		expect(active).toBe(0);
		expect(loaded.map((file) => file.name)).toEqual(files.map((file) => file.name));
		expect(fetcher.mock.calls[0]?.[0].toString()).toBe(
			"https://example.test/project/publication/donor%20A/a.fcs",
		);
		expect(
			await Promise.all(
				loaded.map(async (file) => Array.from(new Uint8Array(await file.arrayBuffer()))),
			),
		).toEqual(payloads.map((data) => Array.from(data)));
		expect(progress.at(-1)).toEqual({
			phase: "files",
			fileCount: 3,
			verifiedFiles: 3,
			downloadedBytes: 6,
			totalBytes: 6,
		});
	});
	it.each(["length", "hash"])(
		"aborts and drains its sibling fetch on %s failure without returning a subset",
		async (mode) => {
			const files = [
				await entry("a.fcs", new Uint8Array([1, 2])),
				await entry("b.fcs", new Uint8Array([3, 4])),
			];
			let cancelled = 0;
			const signals: AbortSignal[] = [];
			const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				signals.push(init?.signal as AbortSignal);
				if (String(input).endsWith("a.fcs"))
					return new Response(mode === "length" ? new Uint8Array([1]) : new Uint8Array([8, 9]));
				return new Response(
					new ReadableStream({
						cancel() {
							cancelled++;
						},
					}),
				);
			});
			await expect(
				downloadPublicationFiles(
					{ files, totalBytes: 4 },
					{ baseUrl, fetch: fetcher as typeof fetch },
				),
			).rejects.toThrow(mode === "length" ? /byte length/ : /SHA-256/);
			expect(cancelled).toBe(1);
			expect(signals.every((signal) => signal.aborted)).toBe(true);
			expect(fetcher).toHaveBeenCalledTimes(2);
		},
	);
	it("cancels a pending stream on caller abort and preserves the abort reason", async () => {
		const file = await entry("a.fcs", new Uint8Array([1]));
		const controller = new AbortController(),
			reason = new Error("caller cancelled");
		let cancelled = 0;
		const fetcher = vi.fn(
			async () =>
				new Response(
					new ReadableStream({
						cancel() {
							cancelled++;
						},
					}),
				),
		);
		const pending = downloadPublicationFiles(
			{ files: [file], totalBytes: 1 },
			{ baseUrl, fetch: fetcher, signal: controller.signal },
		);
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		expect(cancelled).toBe(1);
	});
	it("fetches only the manifest when its validation fails", async () => {
		const input = manifest();
		input.sampleCount = 32;
		const fetcher = vi.fn(async () => new Response(JSON.stringify(input)));
		await expect(loadPublicationDataset({ baseUrl, fetch: fetcher })).rejects.toThrow(/totals/);
		expect(fetcher).toHaveBeenCalledExactlyOnceWith(
			new URL("https://example.test/project/publication/manifest.json"),
			expect.objectContaining({ method: "GET" }),
		);
	});
});
