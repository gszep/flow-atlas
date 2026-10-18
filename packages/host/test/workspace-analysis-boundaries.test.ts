import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readHeader, writeFcs } from "@flow-atlas/fcs";
import { validateWorkspace, type WorkspaceDocument } from "@flow-atlas/model";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnalysisService } from "../src/analysis.js";
import * as artifacts from "../src/artifact-store.js";
import type { AnalysisService, OperationArgs } from "../src/contracts.js";
import { createStudioServer } from "../src/server.js";
import type { WorkspaceBinding, WorkspaceInspection } from "../src/workspace-analysis.js";

const roots: string[] = [];
const services: AnalysisService[] = [];
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function context() {
	const directory = await mkdtemp(join(tmpdir(), "flow-atlas-workspace-boundary-"));
	roots.push(directory);
	const store = await artifacts.ArtifactStore.create(directory);
	const service = await createAnalysisService({ root: directory, maxChunkBytes: 1024 });
	services.push(service);
	return { root: store.root, store, service };
}
afterEach(async () => {
	for (const service of services.splice(0)) await service.close();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function document(): WorkspaceDocument {
	return {
		schemaVersion: 1,
		id: "workspace",
		revision: 0,
		samples: [
			{
				id: "s",
				file: { sha256: "a".repeat(64), basename: "unimported.fcs", size: 123 },
				channels: [{ id: "c", name: "C0" }],
			},
		],
		gates: [
			{
				id: "g",
				sampleId: "s",
				name: "Gate",
				parentId: null,
				dimensions: ["c"],
				geometry: { type: "rectangle", min: [0], max: [1] },
			},
		],
		groups: [],
		annotations: [],
	};
}
function longText(prefix: string): string {
	return prefix + "\u0001".repeat(4096 - prefix.length);
}
async function noArtifacts(store: artifacts.ArtifactStore) {
	expect(await readdir(store.inputs)).toEqual([]);
	expect(await readdir(store.runs)).toEqual([]);
	expect(await readdir(store.outputs)).toEqual([]);
	expect(await readdir(store.temporary)).toEqual([]);
}

describe("read-only workspace admission and inspection boundaries", () => {
	it("byte-pages a human-stamped long-ID gate chain over MCP without truncation or implicit imports", async () => {
		const { root, store, service } = await context();
		const model = document();
		model.id = longText("doc-");
		const sampleId = longText("sample-");
		(model.samples[0] as WorkspaceDocument["samples"][number]).id = sampleId;
		const ids = Array.from({ length: 8 }, (_, index) => longText(`gate-${index}-`));
		model.gates = ids.map((id, index) => ({
			id,
			name: longText(`name-${index}-`),
			sampleId,
			parentId: index ? (ids[index - 1] as string) : null,
			dimensions: ["c"],
			geometry: { type: "rectangle", min: [0], max: [1] },
			author: "human-author",
			modified: "2026-10-18T00:00:00Z",
		}));
		validateWorkspace(model);
		const bytes = Buffer.from(JSON.stringify(model));
		expect(bytes.length).toBeLessThanOrEqual(1024 * 1024);
		await writeFile(join(root, "long.json"), bytes);
		const expectedSha256 = hash(bytes);
		const studio = await createStudioServer({ service, token: "workspace-boundaries-token" });
		const client = new Client({ name: "workspace-boundaries", version: "1" });
		try {
			await client.connect(
				new StreamableHTTPClientTransport(new URL(`${studio.url}/mcp`), {
					requestInit: { headers: { authorization: "Bearer workspace-boundaries-token" } },
				}),
			);
			const collected: WorkspaceInspection["items"] = [];
			const pageSizes: number[] = [];
			let offset = 0;
			for (;;) {
				const response = await client.callTool({
					name: "inspect_workspace",
					arguments: {
						path: "long.json",
						view: "gates",
						sampleId,
						offset,
						limit: 100,
						expectedRevision: 0,
						expectedSha256,
					},
				});
				expect(response.isError).not.toBe(true);
				const text = (response.content as Array<{ text: string }>)[0]?.text as string;
				expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024);
				const page = JSON.parse(text) as WorkspaceInspection;
				expect(page.document).toEqual({
					path: "long.json",
					id: model.id,
					revision: 0,
					sha256: expectedSha256,
					bytes: bytes.length,
				});
				expect(page).toMatchObject({
					view: "gates",
					sampleId,
					offset,
					total: 8,
					counts: { gates: 8 },
				});
				expect(page.capabilities).toEqual({
					workspaceEdits: false,
					coordinateSpace: "stored-f32",
					displayTransformsApplied: false,
					analyses: ["gate-counts", "population-medians"],
				});
				expect(page.items.length).toBeGreaterThan(0);
				pageSizes.push(page.items.length);
				collected.push(...page.items);
				const next = offset + page.items.length;
				expect(page.nextOffset).toBe(next < 8 ? next : null);
				if (page.nextOffset === null) break;
				offset = page.nextOffset;
			}
			expect(pageSizes.length).toBeGreaterThan(1);
			expect(pageSizes[0]).toBeLessThan(8);
			expect(collected).toEqual(
				model.gates.map((gate, index) => ({
					id: gate.id,
					name: gate.name,
					sampleId,
					parentId: gate.parentId,
					type: "rectangle",
					dependencyCount: index ? 1 : 0,
					dimensionCount: 1,
					humanFinalized: true,
				})),
			);
			await expect(
				service.invoke("inspect_workspace", {
					path: "long.json",
					view: "gates",
					offset: 2,
					expectedSha256: "0".repeat(64),
				}),
			).rejects.toMatchObject({ code: "WORKSPACE_HASH_MISMATCH" });
			expect(await readFile(join(root, "long.json"))).toEqual(bytes);
			await noArtifacts(store);
		} finally {
			await client.close();
			await studio.close();
		}
	}, 30_000);

	it("caps bytes before reading DATA and rejects encoding/model/unsupported/cycle errors without writes", async () => {
		const { root, store, service } = await context();
		const oversized = Buffer.alloc(1024 * 1024 + 1, 0x20);
		await writeFile(join(root, "large.json"), oversized);
		const fileSource = artifacts.fileSource;
		const reads = vi.fn();
		const sourceSpy = vi.spyOn(artifacts, "fileSource").mockImplementation(async (...args) => {
			const file = await fileSource(...args);
			return {
				...file,
				source: {
					size: file.source.size,
					read: async (offset, length) => {
						reads(offset, length);
						return file.source.read(offset, length);
					},
				},
			};
		});
		try {
			await expect(
				service.invoke("inspect_workspace", { path: "large.json" }),
			).rejects.toMatchObject({ code: "WORKSPACE_TOO_LARGE" });
			expect(reads).not.toHaveBeenCalled();
		} finally {
			sourceSpy.mockRestore();
		}
		const unsupported = {
			...document(),
			gates: [{ ...document().gates[0], geometry: { type: "ellipsoid" } }],
		};
		const cyclic = document();
		cyclic.gates = [
			{ ...(cyclic.gates[0] as WorkspaceDocument["gates"][number]), id: "a", parentId: "b" },
			{ ...(cyclic.gates[0] as WorkspaceDocument["gates"][number]), id: "b", parentId: "a" },
		];
		const cases: Array<[string, Uint8Array, string]> = [
			["encoding.json", new Uint8Array([0xc3, 0x28]), "WORKSPACE_ENCODING"],
			["invalid.json", Buffer.from("{}"), "INVALID_DOCUMENT"],
			["unsupported.json", Buffer.from(JSON.stringify(unsupported)), "UNSUPPORTED_CAPABILITY"],
			["cycle.json", Buffer.from(JSON.stringify(cyclic)), "CYCLE"],
		];
		for (const [path, bytes, code] of cases) {
			await writeFile(join(root, path), bytes);
			await expect(service.invoke("inspect_workspace", { path })).rejects.toMatchObject({ code });
			expect(await readFile(join(root, path))).toEqual(Buffer.from(bytes));
		}
		expect(await readFile(join(root, "large.json"))).toEqual(oversized);
		await noArtifacts(store);
	});

	it("rejects traversal, absolute paths, outside-root symlinks and directories without imports", async () => {
		const { root, store, service } = await context();
		const outside = await mkdtemp(join(tmpdir(), "flow-atlas-owned-outside-"));
		roots.push(outside);
		const bytes = Buffer.from(JSON.stringify(document()));
		await writeFile(join(root, "inside.json"), bytes);
		await writeFile(join(outside, "outside.json"), bytes);
		await symlink(join(outside, "outside.json"), join(root, "escape.json"));
		await mkdir(join(root, "directory"));
		for (const path of [
			`../${basename(outside)}/outside.json`,
			join(root, "inside.json"),
			"escape.json",
		])
			await expect(service.invoke("inspect_workspace", { path })).rejects.toMatchObject({
				code: "PATH_OUTSIDE_ROOT",
			});
		await expect(service.invoke("inspect_workspace", { path: "directory" })).rejects.toMatchObject({
			code: "INVALID_FILE",
		});
		expect(await readFile(join(root, "inside.json"))).toEqual(bytes);
		expect(await readFile(join(outside, "outside.json"))).toEqual(bytes);
		await noArtifacts(store);
	});

	it("rejects an oversized used-channel binding for a real imported 32-channel source before queuing", async () => {
		const { root, store, service } = await context();
		const names = Array.from({ length: 32 }, (_, index) => `C${index}`);
		async function* rows() {
			yield new Float32Array(names.map((_, index) => index));
		}
		const parts: Uint8Array[] = [];
		for await (const part of writeFcs(
			{
				version: "FCS3.1",
				eventCount: 1,
				keywords: {},
				channels: names.map((name, index) => ({
					index: index + 1,
					name,
					bits: 32,
					range: 4096,
					amplification: [0, 0] as [number, number],
					gain: 1,
				})),
			},
			rows(),
		))
			parts.push(part.slice());
		const fcs = Buffer.concat(parts);
		expect(readHeader(Uint8Array.from(fcs).buffer).version).toBe("FCS3.1");
		await writeFile(join(root, "actual.fcs"), fcs);
		const imported = (await service.invoke("import_fcs", { path: "actual.fcs" })) as {
			sampleId: string;
			bytes: number;
			eventCount: number;
			channelCount: number;
		};
		expect(imported).toMatchObject({ bytes: fcs.length, eventCount: 1, channelCount: 32 });
		const logical = names.map((name, index) => {
			const prefix = `logical-${index}-`;
			return { id: prefix + "x".repeat(1024 - prefix.length), name };
		});
		const model = document();
		model.samples = [
			{
				id: "s",
				file: { sha256: imported.sampleId, basename: "actual.fcs", size: fcs.length },
				channels: logical,
			},
		];
		model.gates = [];
		validateWorkspace(model);
		const bytes = Buffer.from(JSON.stringify(model));
		await writeFile(join(root, "binding.json"), bytes);
		const request: OperationArgs<"start_workspace_population_medians"> = {
			path: "binding.json",
			sampleId: "s",
			expectedRevision: 0,
			expectedSha256: hash(bytes),
			coordinateSpace: "stored-f32",
			populationId: null,
			channels: logical.map(({ id }) => id),
		};
		expect(Buffer.byteLength(artifacts.canonical(request))).toBeLessThan(64 * 1024);
		const binding: WorkspaceBinding = {
			profile: "workspace-stored-f32-admitted-snapshot-v1",
			semantics: "admitted-snapshot",
			document: {
				path: request.path,
				id: model.id,
				revision: 0,
				sha256: hash(bytes),
				bytes: bytes.length,
			},
			sample: { id: "s", sha256: imported.sampleId, bytes: fcs.length },
			channels: logical,
			coordinateSpace: "stored-f32",
			displayTransformsApplied: false,
		};
		expect(Buffer.byteLength(artifacts.canonical(binding))).toBeGreaterThan(32 * 1024);
		const inputs = await readdir(store.inputs);
		await expect(
			service.invoke("start_workspace_population_medians", request),
		).rejects.toMatchObject({ code: "WORKSPACE_BINDING_TOO_LARGE" });
		expect(await readdir(store.inputs)).toEqual(inputs);
		expect(await readdir(store.runs)).toEqual([]);
		expect(await readdir(store.outputs)).toEqual([]);
		expect(await readdir(store.temporary)).toEqual([]);
		expect(await readFile(join(root, "binding.json"))).toEqual(bytes);
	});

	it("preserves cancellation during document reads, including a simultaneous source change, and rejects mutation alone", async () => {
		const { root, store, service } = await context();
		const path = join(root, "race.json");
		const bytes = Buffer.from(JSON.stringify(document()));
		const request: OperationArgs<"start_workspace_gate_counts"> = {
			path: "race.json",
			sampleId: "s",
			coordinateSpace: "stored-f32",
			expectedRevision: 0,
			expectedSha256: hash(bytes),
		};
		const observed: Array<{ mode: string; code: unknown; aborted: boolean }> = [];
		for (const mode of ["cancel", "mutate", "cancel-and-mutate"]) {
			await writeFile(path, bytes);
			const controller = new AbortController();
			const fileSource = artifacts.fileSource;
			let closed = 0,
				checked = 0,
				reads = 0;
			const spy = vi.spyOn(artifacts, "fileSource").mockImplementation(async (...args) => {
				const file = await fileSource(...args);
				if (args[0] !== path) return file;
				return {
					...file,
					source: {
						size: file.source.size,
						read: async (offset, length) => {
							const read = await file.source.read(offset, length);
							reads++;
							if (mode !== "cancel") {
								await writeFile(path, Buffer.concat([bytes, Buffer.from(" ")]));
								await utimes(path, new Date(0), new Date(0));
							}
							if (mode !== "mutate") controller.abort();
							return read;
						},
					},
					assertUnchanged: async () => {
						checked++;
						await file.assertUnchanged();
					},
					close: async () => {
						closed++;
						await file.close();
					},
				};
			});
			try {
				const outcome = await service
					.invoke("start_workspace_gate_counts", request, controller.signal)
					.then(
						() => ({ code: "UNEXPECTED_SUCCESS" }),
						(error: unknown) => ({
							code: error instanceof Error && "code" in error ? error.code : "UNTYPED_ERROR",
						}),
					);
				observed.push({ mode, code: outcome.code, aborted: controller.signal.aborted });
				expect({ reads, checked, closed }).toEqual({ reads: 1, checked: 1, closed: 1 });
				await noArtifacts(store);
			} finally {
				spy.mockRestore();
			}
		}
		// Cancellation must not be replaced by the finally-block consistency error.
		expect(observed).toEqual([
			{ mode: "cancel", code: "CANCELLED", aborted: true },
			{ mode: "mutate", code: "INPUT_CHANGED", aborted: false },
			{ mode: "cancel-and-mutate", code: "CANCELLED", aborted: true },
		]);
	});
});
