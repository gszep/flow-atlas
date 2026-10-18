import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as compute from "@flow-atlas/compute";
import { validateWorkspace, type WorkspaceDocument } from "@flow-atlas/model";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnalysisService } from "../src/analysis.js";
import type { AnalysisService, OperationArgs } from "../src/contracts.js";
import { createStudioServer } from "../src/server.js";

type InspectArgs = OperationArgs<"inspect_workspace">;
type Group = { id: string; name: string; sampleIds: string[] };
type Result = Record<string, unknown>;

const roots: string[] = [];
const services: AnalysisService[] = [];

// CPU-only fixture: no FCS bytes are needed because the group views never touch sample
// sources. File hashes are well-formed placeholders that stay unimported on purpose.
function document(groups: Group[], revision = 4): WorkspaceDocument {
	const document: WorkspaceDocument = {
		schemaVersion: 1,
		id: "ws-groups",
		revision,
		agentEdit: { agentId: "mochi-the-kitty", revision: Math.min(2, revision) },
		samples: [
			{
				id: "s-alpha",
				file: { sha256: "a".repeat(64), basename: "one.fcs", size: 11 },
				channels: [
					{ id: "c-a", name: "A" },
					{ id: "c-b", name: "B" },
				],
			},
			// Same file hash as s-alpha, distinct logical ID: never deduplicated.
			{
				id: "s-beta",
				file: { sha256: "a".repeat(64), basename: "one.fcs", size: 11 },
				channels: [{ id: "c-c", name: "C" }],
			},
			{
				id: "s-gamma",
				file: { sha256: "b".repeat(64), basename: "two.fcs", size: 22 },
				channels: [{ id: "c-d", name: "D" }],
			},
			// Same file hash as s-gamma, distinct logical ID.
			{
				id: "s-delta",
				file: { sha256: "b".repeat(64), basename: "two.fcs", size: 22 },
				channels: [{ id: "c-e", name: "E" }],
			},
			{
				id: "s-omega",
				file: { sha256: "c".repeat(64), basename: "three.fcs", size: 33 },
				channels: [{ id: "c-f", name: "F" }],
			},
		],
		gates: [
			{
				id: "g-alpha",
				sampleId: "s-alpha",
				name: "Alpha",
				parentId: null,
				dimensions: ["c-a"],
				geometry: { type: "rectangle", min: [0], max: [1] },
			},
			{
				id: "g-gamma",
				sampleId: "s-gamma",
				name: "Gamma",
				parentId: null,
				dimensions: ["c-d"],
				geometry: { type: "rectangle", min: [0], max: [1] },
			},
		],
		groups,
		annotations: [{ id: "an1", gateId: null, text: "note" }],
	};
	validateWorkspace(document);
	return document;
}

// Overlapping groups in a declared order that differs from document.samples order.
const STUDY_GROUPS: Group[] = [
	{ id: "g-rev", name: "Reversed", sampleIds: ["s-gamma", "s-alpha"] },
	{ id: "g-overlap", name: "SharedHash", sampleIds: ["s-alpha", "s-beta"] },
	{ id: "g-empty", name: "Nobody", sampleIds: [] },
	{
		id: "g-all",
		name: "Everything",
		sampleIds: ["s-omega", "s-alpha", "s-delta", "s-gamma", "s-beta"],
	},
];

type Context = {
	root: string;
	service: AnalysisService;
	identity: { path: string; sha256: string; bytes: number };
	inputs: string[];
};

async function context(
	groups: Group[] = STUDY_GROUPS,
	file = "study.flowatlas.json",
): Promise<Context> {
	const root = await mkdtemp(join(tmpdir(), "flow-atlas-workspace-groups-"));
	roots.push(root);
	const service = await createAnalysisService({ root, maxChunkBytes: 1024 });
	services.push(service);
	const bytes = Buffer.from(JSON.stringify(document(groups)));
	await writeFile(join(root, file), bytes);
	const inputs = await readdir(join(root, ".flow-atlas", "inputs"));
	return {
		root,
		service,
		identity: {
			path: file,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			bytes: bytes.byteLength,
		},
		inputs,
	};
}

function args(
	identity: { path: string; sha256: string },
	extra: Partial<InspectArgs> = {},
): InspectArgs {
	return { path: identity.path, expectedRevision: 4, expectedSha256: identity.sha256, ...extra };
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const service of services.splice(0)) await service.close();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("workspace group discovery views", () => {
	it("summarizes groups with counts and a null groupId marker", async () => {
		const { service, identity } = await context();
		const response = (await service.invoke(
			"inspect_workspace",
			args(identity, { view: "groups" }),
		)) as Result;
		expect(response.document).toMatchObject({
			path: "study.flowatlas.json",
			id: "ws-groups",
			revision: 4,
			sha256: identity.sha256,
			bytes: identity.bytes,
		});
		expect(response.view).toBe("groups");
		expect(response.sampleId).toBeNull();
		expect(response.groupId).toBeNull();
		expect(response.offset).toBe(0);
		expect(response.total).toBe(4);
		expect(response.nextOffset).toBeNull();
		// Global aggregate counts are unaffected by the view.
		expect(response.counts).toEqual({
			samples: 5,
			channels: 6,
			gates: 2,
			groups: 4,
			annotations: 1,
		});
		expect(response.capabilities).toMatchObject({
			workspaceEdits: false,
			coordinateSpace: "stored-f32",
			displayTransformsApplied: false,
			analyses: ["gate-counts", "population-medians"],
		});
		expect(response.items).toEqual([
			{ id: "g-rev", name: "Reversed", sampleCount: 2 },
			{ id: "g-overlap", name: "SharedHash", sampleCount: 2 },
			{ id: "g-empty", name: "Nobody", sampleCount: 0 },
			{ id: "g-all", name: "Everything", sampleCount: 5 },
		]);
	});

	it("lists group members in declared order without deduplicating shared file hashes", async () => {
		const { service, identity } = await context();
		const members = async (groupId: string) =>
			(await service.invoke(
				"inspect_workspace",
				args(identity, { view: "group-samples", groupId }),
			)) as Result;
		// Declared membership order, not document order.
		const reversed = await members("g-rev");
		expect(reversed.groupId).toBe("g-rev");
		expect(reversed.sampleId).toBeNull();
		expect((reversed.items as Result[]).map((item) => item.id)).toEqual(["s-gamma", "s-alpha"]);
		// Overlapping membership across groups is independent.
		const everything = await members("g-all");
		expect((everything.items as Result[]).map((item) => item.id)).toEqual([
			"s-omega",
			"s-alpha",
			"s-delta",
			"s-gamma",
			"s-beta",
		]);
		expect(everything.total).toBe(5);
		// s-alpha/s-beta share one file hash yet both appear: no dedupe by hash.
		const shared = await members("g-overlap");
		expect((shared.items as Result[]).map((item) => item.id)).toEqual(["s-alpha", "s-beta"]);
		expect(((shared.items as Result[])[0] as { file: { sha256: string } }).file.sha256).toBe(
			((shared.items as Result[])[1] as { file: { sha256: string } }).file.sha256,
		);
		// Same projection shape as the samples view, with per-sample gate counts.
		expect(shared.items).toEqual([
			{
				id: "s-alpha",
				file: { sha256: "a".repeat(64), basename: "one.fcs", size: 11 },
				channelCount: 2,
				gateCount: 1,
			},
			{
				id: "s-beta",
				file: { sha256: "a".repeat(64), basename: "one.fcs", size: 11 },
				channelCount: 1,
				gateCount: 0,
			},
		]);
		// An empty group returns no members without errors.
		const empty = await members("g-empty");
		expect(empty).toMatchObject({
			view: "group-samples",
			groupId: "g-empty",
			total: 0,
			items: [],
			nextOffset: null,
		});
	});

	it("rejects invalid view/filter combinations and unknown groups before any write", async () => {
		const { root, service, identity, inputs } = await context();
		for (const request of [
			// groups accepts neither filter
			args(identity, { view: "groups", sampleId: "s-alpha" }),
			args(identity, { view: "groups", groupId: "g-rev" }),
			args(identity, { view: "groups", sampleId: "s-alpha", groupId: "g-rev" }),
			// group-samples requires groupId and rejects sampleId
			args(identity, { view: "group-samples" }),
			args(identity, { view: "group-samples", sampleId: "s-alpha", groupId: "g-rev" }),
			// old views reject groupId; sample filters stay unchanged
			args(identity, { view: "samples", groupId: "g-rev" }),
			args(identity, { view: "gates", groupId: "g-rev" }),
			args(identity, { view: "channels", sampleId: "s-alpha", groupId: "g-rev" }),
		] as InspectArgs[]) {
			await expect(service.invoke("inspect_workspace", request)).rejects.toMatchObject({
				code: "INVALID_PARAMS",
			});
		}
		// Old sample filters remain intact and old responses keep their shape.
		const gates = (await service.invoke(
			"inspect_workspace",
			args(identity, { view: "gates", sampleId: "s-alpha" }),
		)) as Result;
		expect(gates.total).toBe(1);
		expect(gates).not.toHaveProperty("groupId");
		const samples = (await service.invoke(
			"inspect_workspace",
			args(identity, { view: "samples" }),
		)) as Result;
		expect(samples).not.toHaveProperty("groupId");
		// Unknown groups fail typed after the document is read.
		await expect(
			service.invoke(
				"inspect_workspace",
				args(identity, { view: "group-samples", groupId: "ghost" }),
			),
		).rejects.toMatchObject({ code: "WORKSPACE_GROUP_NOT_FOUND" });
		// Identity guards still apply to group views.
		await expect(
			service.invoke("inspect_workspace", args(identity, { view: "groups", expectedRevision: 3 })),
		).rejects.toMatchObject({ code: "WORKSPACE_REVISION_CONFLICT" });
		await expect(
			service.invoke(
				"inspect_workspace",
				args(identity, {
					view: "group-samples",
					groupId: "g-rev",
					expectedSha256: "0".repeat(64),
				}),
			),
		).rejects.toMatchObject({ code: "WORKSPACE_HASH_MISMATCH" });
		expect(await readdir(join(root, ".flow-atlas", "inputs"))).toEqual(inputs);
		expect(await readdir(join(root, ".flow-atlas", "runs"))).toEqual([]);
	});

	it("rejects dangling group references with the model's own error", async () => {
		const { root, service, identity, inputs } = await context();
		// Everything except the dangling reference is valid: dropping it parses cleanly.
		const source = document(STUDY_GROUPS);
		const valid = JSON.parse(JSON.stringify(source)) as WorkspaceDocument;
		(valid.groups[0] as Group).sampleIds = ["s-gamma"];
		validateWorkspace(valid);
		// The dangling reference itself keeps the model's typed error.
		const broken = JSON.parse(JSON.stringify(source)) as WorkspaceDocument;
		(broken.groups[0] as Group).sampleIds = ["s-gamma", "s-ghost"];
		await writeFile(join(root, "broken.flowatlas.json"), JSON.stringify(broken));
		await expect(
			service.invoke("inspect_workspace", {
				path: "broken.flowatlas.json",
				view: "groups",
				expectedRevision: 4,
				expectedSha256: identity.sha256,
			}),
		).rejects.toMatchObject({ code: "MISSING_REFERENCE" });
		expect(await readdir(join(root, ".flow-atlas", "inputs"))).toEqual(inputs);
	});

	it("byte-pages long escaped group IDs without omission or truncation", async () => {
		// 120 groups with 1016-char control-char IDs: ~6.2 KiB escaped per item and a
		// ~760 KiB document (under the 1 MiB cap), so 256 KiB pages must paginate dynamically.
		const groups: Group[] = Array.from({ length: 120 }, (_, index) => ({
			id: `g-${`${index}`.padStart(3, "0")}-${"\u0001".repeat(1010)}`,
			name: `n${index}`,
			sampleIds: [],
		}));
		const { service, identity } = await context(groups, "paged.flowatlas.json");
		const seen: string[] = [];
		let offset: number | null = 0;
		for (let page = 0; offset !== null; page++) {
			const response = (await service.invoke(
				"inspect_workspace",
				args(identity, { view: "groups", offset, limit: 100 }),
			)) as Result;
			expect(response.view).toBe("groups");
			expect(response.groupId).toBeNull();
			expect(response.total).toBe(120);
			expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(256 * 1024);
			for (const item of response.items as Array<{ id: string; sampleCount: number }>) {
				expect(item.id).toHaveLength(1016);
				expect(item.sampleCount).toBe(0);
				seen.push(item.id);
			}
			offset = response.nextOffset as number | null;
			if (page < 2) expect(offset).toEqual(expect.any(Number));
			else expect(offset).toBeNull();
			if (page > 5) throw new Error("pagination did not terminate");
		}
		// Every group appeared exactly once, in document order, with full-length IDs.
		expect(seen).toHaveLength(120);
		expect(seen).toEqual(groups.map((group) => group.id));
		// A wide group paginates its members in declared order across pages.
		const wide = await context(
			[{ id: "g-wide", name: "Wide", sampleIds: ["s-omega", "s-alpha", "s-delta"] }],
			"wide.flowatlas.json",
		);
		const first = (await wide.service.invoke(
			"inspect_workspace",
			args(wide.identity, { view: "group-samples", groupId: "g-wide", offset: 0, limit: 2 }),
		)) as Result;
		const second = (await wide.service.invoke(
			"inspect_workspace",
			args(wide.identity, {
				view: "group-samples",
				groupId: "g-wide",
				offset: first.nextOffset as number,
				limit: 2,
			}),
		)) as Result;
		expect((first.items as Result[]).map((item) => item.id)).toEqual(["s-omega", "s-alpha"]);
		expect((second.items as Result[]).map((item) => item.id)).toEqual(["s-delta"]);
		expect(second.nextOffset).toBeNull();
	});

	it("leaves the document bytes, inputs and sample catalog untouched after group calls", async () => {
		const acquired = vi.spyOn(compute, "acquireDevice").mockImplementation(async () => {
			throw new Error("Group inspection must not initialize a compute device");
		});
		const { root, service, identity, inputs } = await context();
		const before = await readFile(join(root, "study.flowatlas.json"));
		await service.invoke("inspect_workspace", args(identity, { view: "groups" }));
		await service.invoke(
			"inspect_workspace",
			args(identity, { view: "group-samples", groupId: "g-all" }),
		);
		await service.invoke("inspect_workspace", { path: "study.flowatlas.json", view: "groups" });
		const after = await readFile(join(root, "study.flowatlas.json"));
		// Native byte comparison, no slow deep compare of the full document.
		expect(after.equals(before)).toBe(true);
		expect(await readdir(join(root, ".flow-atlas", "inputs"))).toEqual(inputs);
		expect(await readdir(join(root, ".flow-atlas", "runs"))).toEqual([]);
		expect(await readdir(join(root, "outputs"))).toEqual([]);
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
		expect(await service.invoke("list_samples", {})).toMatchObject({ total: 0, items: [] });
		expect(acquired).not.toHaveBeenCalled();
	});

	it("serves group pages over MCP with typed rejections", async () => {
		const { service, identity } = await context();
		const token = "workspace-groups-mcp-token";
		const studio = await createStudioServer({ service, token });
		const client = new Client({ name: "workspace-groups-test", version: "1" });
		try {
			await client.connect(
				new StreamableHTTPClientTransport(new URL(`${studio.url}/mcp`), {
					requestInit: { headers: { authorization: `Bearer ${token}` } },
				}),
			);
			const call = async (request: InspectArgs) => {
				const response = await client.callTool({
					name: "inspect_workspace",
					arguments: request as unknown as Result,
				});
				expect(response.isError).not.toBe(true);
				return JSON.parse(
					(response.content as Array<{ text: string }>)[0]?.text ?? "null",
				) as Result;
			};
			const groups = await call(args(identity, { view: "groups" }));
			expect(groups).toMatchObject({ view: "groups", groupId: null, total: 4 });
			const members = await call(args(identity, { view: "group-samples", groupId: "g-rev" }));
			expect(members).toMatchObject({ view: "group-samples", groupId: "g-rev", total: 2 });
			expect((members.items as Result[]).map((item) => item.id)).toEqual(["s-gamma", "s-alpha"]);
			const rejected = await client.callTool({
				name: "inspect_workspace",
				arguments: args(identity, { view: "groups", groupId: "g-rev" }) as unknown as Result,
			});
			expect(rejected.isError).toBe(true);
			expect(
				JSON.parse((rejected.content as Array<{ text: string }>)[0]?.text ?? "null"),
			).toMatchObject({ error: { code: "INVALID_PARAMS" } });
		} finally {
			await client.close();
			await studio.close();
		}
	});
});
