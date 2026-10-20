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
import { join } from "node:path";
import * as compute from "@flow-atlas/compute";
import { readHeader, writeFcs } from "@flow-atlas/fcs";
import { parseWorkspace } from "@flow-atlas/model";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseXml } from "../../wsp/src/index.js";
import { createAnalysisService } from "../src/analysis.js";
import * as artifacts from "../src/artifact-store.js";
import type { AnalysisService, OperationArgs } from "../src/contracts.js";
import { createStudioServer } from "../src/server.js";

type Request = OperationArgs<"materialize_wsp_sample">;
type Result = {
	semantics: string;
	flowJoInterpretation: string;
	numericExecution: string;
	model: { sampleId: string; revision: number };
	files: Record<
		"workspace" | "source" | "provenance",
		{ path: string; sha256: string; bytes: number }
	>;
	receipt: { path: string; sha256: string; bytes: number };
	channelMapping: Array<{ id: string; name: string; wspIndex: number; fcsIndex: number }>;
	gateMapping: Array<{ id: string; sourceId: string; sourceCount: number }>;
};
const roots: string[] = [],
	services: AnalysisService[] = [];
let gpu: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	gpu = vi.spyOn(compute, "acquireDevice");
});
afterEach(async () => {
	try {
		for (const service of services.splice(0)) await service.close();
		expect(gpu).not.toHaveBeenCalled();
	} finally {
		gpu.mockRestore();
		for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
	}
});
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function xml() {
	const keywords = {
		$PAR: "2",
		$TOT: "2",
		$P1N: "Y",
		$P1B: "32",
		$P1R: "4096",
		$P2N: "X",
		$P2B: "32",
		$P2R: "4096",
	};
	return `<?xml version="1.0" encoding="UTF-8"?><Workspace version="20.0" flowJoVersion="10.7.1" extra="retained">
<SampleList><Sample><DataSet sampleID="22" uri="file:/source.fcs"/><Keywords>${Object.entries(
		keywords,
	)
		.map(([name, value]) => `<Keyword name="${name}" value="${value}"/>`)
		.join("")}</Keywords>
<Transformations><linear minRange="0" maxRange="10"><parameter name="Y"/></linear><transforms:hyperlog custom:mode="verbatim" setting="a&amp;b"><parameter name="X"/></transforms:hyperlog></Transformations>
<SampleNode sampleID="22" name="Original sample" count="2"><Subpopulations>
<Population name="Range" count="99"><Gate id="R"><RectangleGate><dimension min="0.1" max="0.7"><fcs-dimension name="X"/></dimension></RectangleGate></Gate><Subpopulations>
<Population name="Polygon" count="1"><Gate id="P" parent_id="R"><PolygonGate><dimension><fcs-dimension name="X"/></dimension><dimension><fcs-dimension name="Y"/></dimension><vertex><coordinate value="0.1"/><coordinate value="0"/></vertex><vertex><coordinate value="1"/><coordinate value="0"/></vertex><vertex><coordinate value="0"/><coordinate value="1"/></vertex></PolygonGate></Gate></Population>
</Subpopulations></Population>
<Population name="Combined" count="1"><Gate id="B"><BooleanGate><and><gateReference ref="R"/><gateReference ref="P"/></and></BooleanGate></Gate></Population>
</Subpopulations></SampleNode></Sample></SampleList><Groups><GroupNode name="All"><SampleRef sampleID="22"/></GroupNode></Groups></Workspace>`;
}
async function setup(names = ["X", "Y"], sourceXml = xml()) {
	const root = await mkdtemp(join(tmpdir(), "flow-atlas-materialize-"));
	roots.push(root);
	const service = await createAnalysisService({ root, maxChunkBytes: 1024 });
	services.push(service);
	async function* rows() {
		yield new Float32Array([0.1, 1, 0.7, 2]);
	}
	const parts: Uint8Array[] = [];
	for await (const bytes of writeFcs(
		{
			version: "FCS3.1",
			eventCount: 2,
			keywords: {},
			channels: names.map((name, i) => ({
				index: i + 1,
				name,
				bits: 32,
				range: 4096,
				amplification: [0, 0],
				gain: 1,
			})),
		},
		rows(),
	))
		parts.push(bytes.slice());
	const fcs = Buffer.concat(parts);
	expect(readHeader(Uint8Array.from(fcs).buffer).version).toBe("FCS3.1");
	await writeFile(join(root, "source.fcs"), fcs);
	const imported = (await service.invoke("import_fcs", { path: "source.fcs" })) as {
		sampleId: string;
		bytes: number;
		metadataHash: string;
	};
	const bytes = Buffer.from(sourceXml);
	await writeFile(join(root, "source.wsp"), bytes);
	const request: Request = {
		path: "source.wsp",
		expectedSha256: sha(bytes),
		expectedWspVersion: "20.0",
		wspSampleId: "22",
		sampleId: imported.sampleId,
		expectedSampleBytes: imported.bytes,
		expectedMetadataHash: imported.metadataHash,
		coordinateConvention: "preserve-xml-as-raw-v1",
		agentId: "cpu-test-agent",
	};
	return { root, service, request, bytes, fcs };
}
async function none(root: string) {
	expect(await readdir(join(root, "outputs"))).toEqual([]);
	expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
	expect(await readdir(join(root, ".flow-atlas", "runs"))).toEqual([]);
}

describe("public single-sample structural WSP materialization (CPU only)", () => {
	it("maps literal-LF WSP channel and gate-axis attributes to the exact FCS space name while retaining raw XML", async () => {
		const sourceXml = xml()
			.replace('name="$P2N" value="X"', 'name="$P2N" value="X\nY"')
			.replaceAll('name="X"', 'name="X\nY"');
		const { root, service, request, bytes } = await setup(["X Y", "Y"], sourceXml);
		const result = (await service.invoke("materialize_wsp_sample", request)) as Result;
		const mapped = result.channelMapping.find(({ name }) => name === "X Y");
		expect(mapped).toMatchObject({ name: "X Y", wspIndex: 2, fcsIndex: 1 });
		const model = parseWorkspace(await readFile(join(root, result.files.workspace.path), "utf8"));
		expect(model.samples[0]?.channels.map(({ name }) => name)).toEqual(["Y", "X Y"]);
		expect(model.gates[0]?.dimensions).toEqual([mapped?.id]);
		expect(model.gates[1]?.dimensions[0]).toBe(mapped?.id);
		expect(await readFile(join(root, result.files.source.path))).toEqual(bytes);
		expect(result.files.source.sha256).toBe(sha(bytes));
		expect(await readFile(join(root, "source.wsp"))).toEqual(bytes);
		// A character reference denotes a real LF, not a normalized literal space.
		const referenced = Buffer.from(sourceXml.replaceAll('"X\nY"', '"X&#10;Y"'));
		await writeFile(join(root, "source.wsp"), referenced);
		await expect(
			service.invoke("materialize_wsp_sample", { ...request, expectedSha256: sha(referenced) }),
		).rejects.toMatchObject({ code: "WSP_CHANNEL_MISMATCH" });
		expect(await readdir(join(root, "outputs"))).toHaveLength(1);
		expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
	});
	it("preserves source doubles, unsupported transforms, original provenance and mapped DAG over MCP", async () => {
		const { root, service, request, bytes, fcs } = await setup();
		const inspected = (await service.invoke("inspect_fcs", { sampleId: request.sampleId })) as {
			metadataHash: string;
		};
		expect(inspected.metadataHash).toBe(request.expectedMetadataHash);
		const studio = await createStudioServer({ service, token: "materialization-cpu-test" });
		const client = new Client({ name: "materialization-test", version: "1" });
		try {
			await client.connect(
				new StreamableHTTPClientTransport(new URL(`${studio.url}/mcp`), {
					requestInit: { headers: { authorization: "Bearer materialization-cpu-test" } },
				}),
			);
			const response = await client.callTool({
				name: "materialize_wsp_sample",
				arguments: request,
			});
			expect(response.isError).not.toBe(true);
			const text = (response.content as Array<{ text: string }>)[0]?.text as string;
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024);
			const result = JSON.parse(text) as Result;
			expect(result).toMatchObject({
				semantics: "structural-preservation-only",
				flowJoInterpretation: "unvalidated",
				numericExecution: "not-validated",
				model: { revision: 0 },
			});
			const workspaceBytes = await readFile(join(root, result.files.workspace.path));
			const model = parseWorkspace(workspaceBytes.toString("utf8"));
			expect(workspaceBytes.length).toBeLessThanOrEqual(1024 * 1024);
			expect(model.groups).toEqual([]);
			expect(model.gates.map(({ geometry }) => geometry.type)).toEqual([
				"rectangle",
				"polygon",
				"boolean",
			]);
			expect(model.gates[0]?.geometry).toEqual({ type: "rectangle", min: [0.1], max: [0.7] });
			expect(model.gates[1]?.parentId).toBe(model.gates[0]?.id);
			expect(model.gates[2]?.geometry).toEqual({
				type: "boolean",
				op: "and",
				refs: [model.gates[0]?.id, model.gates[1]?.id],
			});
			expect(model.samples[0]?.channels.find((c) => c.name === "X")?.transform).toEqual({
				type: "unsupported",
				originalType: "hyperlog",
				element: "transforms:hyperlog",
				attributes: { "custom:mode": "verbatim", setting: "a&b" },
			});
			expect(
				model.gates.every(
					(g) =>
						!Object.hasOwn(g, "author") &&
						!Object.hasOwn(g, "modified") &&
						!Object.hasOwn(g, "count"),
				),
			).toBe(true);
			expect(
				result.channelMapping.map(({ name, wspIndex, fcsIndex }) => [name, wspIndex, fcsIndex]),
			).toEqual([
				["Y", 1, 2],
				["X", 2, 1],
			]);
			const provenance = JSON.parse(
				await readFile(join(root, result.files.provenance.path), "utf8"),
			);
			expect(provenance).toMatchObject({
				agentId: request.agentId,
				contentRevision: request.expectedSha256,
				wspFormatVersion: "20.0",
				sourceCounts: "reported-source-metadata-not-computed-truth",
				groups: { policy: "omit-all", sourceGroupCount: 1 },
			});
			expect(
				provenance.gateMapping.map((g: { sourceId: string; sourceCount: number }) => [
					g.sourceId,
					g.sourceCount,
				]),
			).toEqual([
				["R", 99],
				["P", 1],
				["B", 1],
			]);
			expect(await readFile(join(root, result.files.source.path))).toEqual(bytes);
			expect(await readFile(join(root, "source.wsp"))).toEqual(bytes);
			expect(await readFile(join(root, "source.fcs"))).toEqual(fcs);
			const hashes = await Promise.all(
				Object.values(result.files).map(
					async (file) => sha(await readFile(join(root, file.path))) === file.sha256,
				),
			);
			expect(hashes.every(Boolean)).toBe(true);
			const receiptBytes = await readFile(join(root, result.receipt.path));
			expect(sha(receiptBytes)).toBe(result.receipt.sha256);
			expect(JSON.parse(receiptBytes.toString())).toMatchObject({
				operation: "materialize_wsp_sample",
				requestHash: artifacts.digest(request),
				model: result.model,
				files: result.files,
			});
			const page = await client.callTool({
				name: "inspect_workspace",
				arguments: {
					path: result.files.workspace.path,
					view: "channels",
					sampleId: result.model.sampleId,
				},
			});
			expect(page.isError).not.toBe(true);
			expect(
				JSON.parse((page.content as Array<{ text: string }>)[0]?.text as string).items,
			).toHaveLength(2);
			const repeated = (await service.invoke("materialize_wsp_sample", request)) as Result;
			expect(repeated.model).toEqual(result.model);
			expect(repeated.files.workspace.sha256).toBe(result.files.workspace.sha256);
			expect(repeated.files.workspace.path).not.toBe(result.files.workspace.path);
			expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
		} finally {
			await client.close();
			await studio.close();
		}
	});

	it("requires convention/hash/version/source metadata guards and rejects conflicts without outputs", async () => {
		const { root, service, request } = await setup();
		const failures: Array<[Record<string, unknown>, string]> = [
			[{ sampleId: "0".repeat(64) }, "ENOENT"],
			[{ coordinateConvention: undefined }, "INVALID_PARAMS"],
			[{ expectedSha256: "0".repeat(64) }, "WSP_HASH_MISMATCH"],
			[{ expectedWspVersion: "other" }, "WSP_VERSION_CONFLICT"],
			[{ wspSampleId: "absent" }, "WSP_SAMPLE_NOT_FOUND"],
			[{ expectedSampleBytes: request.expectedSampleBytes + 1 }, "WSP_SAMPLE_MISMATCH"],
			[{ expectedMetadataHash: "0".repeat(64) }, "WSP_METADATA_MISMATCH"],
		];
		for (const [patch, code] of failures)
			await expect(
				service.invoke("materialize_wsp_sample", { ...request, ...patch }),
			).rejects.toMatchObject({ code });
		for (const changed of [
			xml().replace('name="$TOT" value="2"', 'name="$TOT" value="3"'),
			xml()
				.replace('name="$P1N" value="Y"', 'name="$P1N" value="Z"')
				.replaceAll('name="Y"', 'name="Z"'),
		]) {
			const bytes = Buffer.from(changed);
			await writeFile(join(root, "source.wsp"), bytes);
			await expect(
				service.invoke("materialize_wsp_sample", { ...request, expectedSha256: sha(bytes) }),
			).rejects.toMatchObject({ code: expect.stringMatching(/^WSP_(SAMPLE|CHANNEL)_MISMATCH$/) });
		}
		await none(root);
	});

	it("preflights selected constructs instead of accepting reader defaults or dropping gates", async () => {
		const { root, service, request } = await setup();
		const source = xml();
		const cases = [
			source.replace('min="0.1"', 'min="bad"'),
			source.replace('min="0.1"', 'min=""'),
			source.replace('min="0.1"', 'min="Infinity"'),
			source.replace('min="0.1"', 'min="-0"'),
			source.replace('parent_id="R"', 'parent_id="B"'),
			source.replace('id="P"', 'id="R"'),
			source.replace('ref="P"', 'ref="missing"'),
			source.replace("<and>", "<xor>").replace("</and>", "</xor>"),
			source.replace('ref="R"', 'ref="R" use-as-complement="true"'),
			source.replace("<dimension min=", '<dimension transformation-ref="display" min='),
			source.replace(
				'<fcs-dimension name="X"/>',
				'<fcs-dimension name="X" compensation-ref="comp"/>',
			),
			source
				.replace("<RectangleGate>", "<EllipsoidGate>")
				.replace("</RectangleGate>", "</EllipsoidGate>"),
			source.replace("</RectangleGate></Gate>", "</RectangleGate><PolygonGate/></Gate>"),
			source.replace(/<Gate id="B">[\s\S]*?<\/Gate>/, ""),
			source.replace('<coordinate value="0.1"/>', '<coordinate value="NaN"/>'),
			source.replace('<linear minRange="0"', '<linear unexpected="preserve?" minRange="0"'),
			source.replace(
				'<parameter name="X"/></transforms:hyperlog>',
				'<parameter name="X"/><unmodeled/></transforms:hyperlog>',
			),
		];
		for (const changed of cases) {
			const bytes = Buffer.from(changed);
			await writeFile(join(root, "source.wsp"), bytes);
			await expect(
				service.invoke("materialize_wsp_sample", { ...request, expectedSha256: sha(bytes) }),
			).rejects.toMatchObject({ code: "WSP_UNSUPPORTED_STRUCTURE" });
			expect(await readFile(join(root, "source.wsp"))).toEqual(bytes);
		}
		await none(root);
	});

	it("rejects untrusted XML, malformed entities/Unicode/quotes, DTDs and bounded-parser exhaustion", async () => {
		const { root, service, request } = await setup();
		const malformed = [
			'<!DOCTYPE Workspace SYSTEM "file:///etc/passwd"><Workspace/>',
			'<!DOCTYPE a [<!ENTITY x "boom">]><a>&x;</a>',
			'<a x="1" x="2"/>',
			'<a x="1" n:x="2"/>',
			'<a __proto__="x"/>',
			'<a n:constructor="x"/>',
			"<a>&unknown;</a>",
			"<a>&#0;</a>",
			"<a>&#xD800;</a>",
			"<a>&#x110000;</a>",
			"<a>&oops</a>",
			"<a>\u0000</a>",
			"<a>\ud800</a>",
			"<a/><b/>",
			"<a/>tail",
			"before<a/>",
			'<a x="unterminated/>',
			'<a x="1"y="2"/>',
			'<a x="<bad>"/>',
			"<a><!-- bad -- comment --></a>",
			"<a>".repeat(129) + "</a>".repeat(129),
			`<a>${"<b/>".repeat(100000)}</a>`,
			`<a ${Array.from({ length: 129 }, (_, i) => `x${i}="1"`).join(" ")}/>`,
		];
		// Validate string-level invalid Unicode before UTF-8 encoding can replace a lone surrogate.
		const rejected = malformed.map((value) => {
			try {
				parseXml(value, { strict: true });
				return false;
			} catch {
				return true;
			}
		});
		expect(rejected.every(Boolean)).toBe(true);
		const bytes = Buffer.from(malformed[0] as string);
		await writeFile(join(root, "source.wsp"), bytes);
		await expect(
			service.invoke("materialize_wsp_sample", { ...request, expectedSha256: sha(bytes) }),
		).rejects.toMatchObject({ code: "WSP_INVALID_XML" });
		const invalidUtf8 = Buffer.from([0xc3, 0x28]);
		await writeFile(join(root, "source.wsp"), invalidUtf8);
		await expect(
			service.invoke("materialize_wsp_sample", { ...request, expectedSha256: sha(invalidUtf8) }),
		).rejects.toMatchObject({ code: "WSP_ENCODING" });
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		await none(root);
	});

	it("confines regular files and checks the 8 MiB source ceiling before reading", async () => {
		const { root, service, request } = await setup();
		const outside = await mkdtemp(join(tmpdir(), "flow-atlas-wsp-outside-"));
		roots.push(outside);
		await writeFile(join(outside, "source.wsp"), xml());
		await symlink(join(outside, "source.wsp"), join(root, "escape.wsp"));
		for (const path of ["../outside.wsp", join(root, "source.wsp"), "escape.wsp"])
			await expect(
				service.invoke("materialize_wsp_sample", { ...request, path }),
			).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
		await mkdir(join(root, "directory"));
		await expect(
			service.invoke("materialize_wsp_sample", { ...request, path: "directory" }),
		).rejects.toMatchObject({ code: "INVALID_FILE" });
		await writeFile(join(root, "large.wsp"), Buffer.alloc(8 * 2 ** 20 + 1, 32));
		const openSource = artifacts.fileSource,
			read = vi.fn();
		const spy = vi.spyOn(artifacts, "fileSource").mockImplementation(async (...args) => {
			const file = await openSource(...args);
			return {
				...file,
				source: {
					size: file.source.size,
					read: async (offset, length) => {
						read();
						return file.source.read(offset, length);
					},
				},
			};
		});
		try {
			await expect(
				service.invoke("materialize_wsp_sample", { ...request, path: "large.wsp" }),
			).rejects.toMatchObject({ code: "WSP_TOO_LARGE" });
			expect(read).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
		await none(root);
	});

	it("preserves cancellation during source mutation, closes descriptors, and bounds concurrent materializations", async () => {
		const { root, service, request, bytes } = await setup();
		for (const mode of ["mutation", "cancel-and-mutation", "cancel"]) {
			await writeFile(join(root, "source.wsp"), bytes);
			const controller = new AbortController();
			const openSource = artifacts.fileSource;
			let closed = 0;
			const spy = vi.spyOn(artifacts, "fileSource").mockImplementation(async (...args) => {
				const file = await openSource(...args);
				return {
					...file,
					close: async () => {
						closed++;
						await file.close();
					},
					source: {
						size: file.source.size,
						read: async (offset, length) => {
							const result = await file.source.read(offset, length);
							if (mode !== "cancel") {
								await writeFile(join(root, "source.wsp"), Buffer.concat([bytes, Buffer.from(" ")]));
								await utimes(join(root, "source.wsp"), new Date(0), new Date(0));
							}
							if (mode !== "mutation") controller.abort();
							return result;
						},
					},
				};
			});
			try {
				await expect(
					service.invoke("materialize_wsp_sample", request, controller.signal),
				).rejects.toMatchObject({ code: mode === "mutation" ? "INPUT_CHANGED" : "CANCELLED" });
				expect(closed).toBe(1);
			} finally {
				spy.mockRestore();
			}
		}
		await writeFile(join(root, "source.wsp"), bytes);
		let release: (() => void) | undefined;
		const wait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const openSource = artifacts.fileSource;
		const entered = vi.fn();
		const spy = vi.spyOn(artifacts, "fileSource").mockImplementation(async (...args) => {
			entered();
			await wait;
			return openSource(...args);
		});
		const controller = new AbortController();
		const running = service.invoke("materialize_wsp_sample", request, controller.signal);
		try {
			await vi.waitFor(() => expect(entered).toHaveBeenCalled());
			await expect(service.invoke("materialize_wsp_sample", request)).rejects.toMatchObject({
				code: "BUSY",
			});
			controller.abort();
			release?.();
			await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
		} finally {
			release?.();
			spy.mockRestore();
		}
		await none(root);
	});

	it("cleans invocation-owned staging on write failure without publishing partial artifacts", async () => {
		const { root, service, request } = await setup();
		const write = artifacts.writeAll;
		let writes = 0;
		const injected = Object.assign(new Error("injected write failure"), { code: "EIO" });
		const spy = vi.spyOn(artifacts, "writeAll").mockImplementation(async (...args) => {
			if (++writes === 2) throw injected;
			return write(...args);
		});
		try {
			await expect(service.invoke("materialize_wsp_sample", request)).rejects.toMatchObject({
				code: "EIO",
				message: "injected write failure",
			});
			expect(writes).toBe(2);
		} finally {
			spy.mockRestore();
		}
		await none(root);
	});

	it("rejects Boolean cycles and output budgets before publishing, without truncating source evidence", async () => {
		const { root, service, request } = await setup();
		const cyclic = xml().replace(
			/<RectangleGate>[\s\S]*?<\/RectangleGate>/,
			'<BooleanGate><not><gateReference ref="B"/></not></BooleanGate>',
		);
		const largeProvenance = xml().replace(
			'extra="retained"',
			Array.from({ length: 5 }, (_, i) => `extra${i}="${"a".repeat(60000)}"`).join(" "),
		);
		const populations = Array.from(
			{ length: 260 },
			(_, i) =>
				`<Population name="${"n".repeat(4096)}" count="1"><Gate id="R${i}"><RectangleGate><dimension min="0.1"><fcs-dimension name="X"/></dimension></RectangleGate></Gate></Population>`,
		).join("");
		const largeModel = xml().replace(
			/<SampleNode[\s\S]*?<\/SampleNode>/,
			`<SampleNode sampleID="22" name="sample" count="2"><Subpopulations>${populations}</Subpopulations></SampleNode>`,
		);
		for (const [text, code] of [
			[cyclic, "CYCLE"],
			[largeProvenance, "RESPONSE_TOO_LARGE"],
			[largeModel, "WORKSPACE_TOO_LARGE"],
		]) {
			const bytes = Buffer.from(text as string);
			await writeFile(join(root, "source.wsp"), bytes);
			await expect(
				service.invoke("materialize_wsp_sample", { ...request, expectedSha256: sha(bytes) }),
			).rejects.toMatchObject({ code });
			expect(sha(await readFile(join(root, "source.wsp")))).toBe(sha(bytes));
			await none(root);
		}
	}, 30_000);

	it("cancels while writing owned staging and leaves no partial output", async () => {
		const { root, service, request } = await setup();
		const controller = new AbortController();
		const write = artifacts.writeAll;
		let writes = 0;
		const spy = vi.spyOn(artifacts, "writeAll").mockImplementation(async (...args) => {
			await write(...args);
			if (++writes === 1) controller.abort();
		});
		try {
			await expect(
				service.invoke("materialize_wsp_sample", request, controller.signal),
			).rejects.toMatchObject({ code: "CANCELLED" });
			expect(writes).toBe(1);
		} finally {
			spy.mockRestore();
		}
		await none(root);
	});
});
