import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FcsChannel, readFcs } from "@flow-atlas/fcs";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAnalysisService } from "../src/analysis.js";
import type { AnalysisService } from "../src/contracts.js";
import { createStudioServer } from "../src/server.js";

type Result = Record<string, unknown>;
function synthetic(
	channels: FcsChannel[],
	values: number[],
	timestep: number,
	integer = false,
	extraKeywords: Record<string, string | null> = {},
): Uint8Array {
	const bytesPerValue = integer ? 2 : 4;
	const kw: Record<string, string> = {
		$BEGINANALYSIS: "0",
		$ENDANALYSIS: "0",
		$BEGINSTEXT: "0",
		$ENDSTEXT: "0",
		$BYTEORD: "1,2,3,4",
		$DATATYPE: integer ? "I" : "F",
		$MODE: "L",
		$NEXTDATA: "0",
		$PAR: `${channels.length}`,
		$TOT: `${values.length / channels.length}`,
		$TIMESTEP: `${timestep}`,
	};
	for (const [key, value] of Object.entries(extraKeywords)) {
		if (value === null) delete kw[key];
		else kw[key] = value;
	}
	channels.forEach((c, index) => {
		const p = `$P${index + 1}`;
		Object.assign(kw, {
			[`${p}B`]: `${bytesPerValue * 8}`,
			[`${p}N`]: c.name,
			[`${p}R`]: `${c.range}`,
			[`${p}E`]: c.amplification.join(","),
			[`${p}G`]: `${c.gain}`,
		});
	});
	let begin = 0,
		text = new Uint8Array();
	for (;;) {
		kw.$BEGINDATA = `${begin}`;
		kw.$ENDDATA = `${begin + values.length * bytesPerValue - 1}`;
		text = new TextEncoder().encode(`|${Object.entries(kw).flat().join("|")}|`);
		const next = 58 + text.length;
		if (next === begin) break;
		begin = next;
	}
	const bytes = new Uint8Array(begin + values.length * bytesPerValue);
	bytes.set(
		new TextEncoder().encode(
			`FCS3.1    ${[58, begin - 1, begin, bytes.length - 1, 0, 0].map((v) => `${v}`.padStart(8)).join("")}`,
		),
	);
	bytes.set(text, 58);
	const view = new DataView(bytes.buffer);
	values.forEach((value, i) => {
		if (integer) view.setUint16(begin + i * 2, value, true);
		else view.setFloat32(begin + i * 4, value, true);
	});
	return bytes;
}
const channel = (
	name: string,
	index: number,
	gain = 1,
	amplification: [number, number] = [0, 0],
): FcsChannel => ({ name, index, bits: 32, range: 4096, gain, amplification });
const abundance = (event: number) => [(event % 7) - 3, (event % 5) - 2];
function mixtures(count: number, gains: number[]): number[] {
	return Array.from({ length: count }, (_, event) => {
		const [a = 0, b = 0] = abundance(event);
		return [
			(a + 0.125 * b) * (gains[0] as number),
			(0.25 * a + b) * (gains[1] as number),
			(0.5 * a + 0.75 * b) * (gains[2] as number),
			event * 4,
		];
	}).flat();
}
let root: string, service: AnalysisService, sampleId: string, logId: string, unitId: string;
let studio: Awaited<ReturnType<typeof createStudioServer>>, client: Client;
const reference = {
	detectors: ["D2", "D0", "D1"],
	fluorochromes: ["F0", "F1"],
	matrix: [0.5, 1, 0.25, 0.75, 0.125, 1],
	residualChannel: "fit",
	outputRanges: [100, 200],
	residualRange: 10,
};
async function completed(jobId: string): Promise<Result> {
	let result: Result = {};
	await vi.waitFor(
		async () => {
			result = (await service.invoke("get_job", { jobId })) as Result;
			expect(["succeeded", "failed", "cancelled"]).toContain(result.state);
		},
		{ timeout: 15_000, interval: 5 },
	);
	return result;
}
async function readOutput(job: Result) {
	const bytes = await readFile(join(root, (job.result as { path: string }).path));
	return readFcs(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "flow-atlas-processing-"));
	const channels = [
		channel("D0", 1, 2),
		channel("D1", 2, 4),
		channel("D2", 3, 8),
		channel("Time", 4, 100),
	];
	await writeFile(join(root, "mixed.fcs"), synthetic(channels, mixtures(179, [2, 4, 8]), 0.25));
	await writeFile(
		join(root, "unit.fcs"),
		synthetic(
			channels.map((c) => ({ ...c, gain: 1 })),
			mixtures(179, [1, 1, 1]),
			0.25,
		),
	);
	const log = channel("Log", 1, 1, [4, 2]);
	log.range = 1024;
	await writeFile(
		join(root, "log.fcs"),
		synthetic([log, channel("Time", 2, 100)], [0, 0, 256, 20, 512, 100, 768, 200], 0.01, true),
	);
	service = await createAnalysisService({ root, maxChunkBytes: 1024 });
	sampleId = ((await service.invoke("import_fcs", { path: "mixed.fcs" })) as Result)
		.sampleId as string;
	unitId = ((await service.invoke("import_fcs", { path: "unit.fcs" })) as Result)
		.sampleId as string;
	logId = ((await service.invoke("import_fcs", { path: "log.fcs" })) as Result).sampleId as string;
	await service.invoke("preview_fcs", { sampleId: logId, inputSpace: "linearized", limit: 1 });
	studio = await createStudioServer({ service, token: "processing-test-token" });
	client = new Client({ name: "processing-test", version: "1" });
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${studio.url}/mcp`), {
			requestInit: { headers: { authorization: "Bearer processing-test-token" } },
		}),
	);
}, 30_000);
afterAll(async () => {
	await client?.close();
	await studio?.close();
	await service?.close();
	if (root) await rm(root, { recursive: true, force: true });
});

describe("explicit input-space and output-layout contracts", () => {
	it("resolves time aliases explicitly and removes stale aliases after linearization", async () => {
		await writeFile(
			join(root, "time-alias.fcs"),
			synthetic([channel("Time", 1)], [8], 0.25, false, { $TIMESTEP: null, TIMESTEP: "0.25" }),
		);
		const imported = (await service.invoke("import_fcs", { path: "time-alias.fcs" })) as Result;
		const job = (await service.invoke("start_fcs_export", {
			sampleId: imported.sampleId,
			inputSpace: "linearized",
		})) as Result;
		const result = await completed(job.jobId as string);
		expect(result.state).toBe("succeeded");
		const output = await readOutput(result);
		expect(output.data[0]).toBe(2);
		expect(output.keywords.$TIMESTEP).toBe("1");
		expect(output.keywords.TIMESTEP).toBeUndefined();
		await expect(
			service.invoke("start_fcs_export", {
				sampleId: imported.sampleId,
				inputSpace: "linearized",
				keywords: { TIMESTEP: "0.25" },
			}),
		).rejects.toMatchObject({ code: "MANAGED_KEYWORD" });
		await writeFile(
			join(root, "time-conflict.fcs"),
			synthetic([channel("Time", 1)], [8], 0.25, false, { TIMESTEP: "0.5" }),
		);
		const conflicted = (await service.invoke("import_fcs", {
			path: "time-conflict.fcs",
		})) as Result;
		await expect(
			service.invoke("preview_fcs", { sampleId: conflicted.sampleId, inputSpace: "linearized" }),
		).rejects.toMatchObject({ code: "INVALID_PROCESSING_CONTEXT" });
		const repaired = (await service.invoke("preview_fcs", {
			sampleId: conflicted.sampleId,
			inputSpace: "linearized",
			acquisition: { timeStep: 0.125 },
		})) as Result;
		expect(repaired.rows).toEqual([[1]]);
		for (const value of ["0", "-1", "0x1", "", "NaN"])
			await expect(
				service.invoke("start_fcs_export", {
					sampleId: imported.sampleId,
					keywords: { TIMESTEP: value },
				}),
			).rejects.toMatchObject({ code: "INVALID_OUTPUT_METADATA" });
	});
	it("keeps stored values unchanged and exports log/time linearization without double scaling", async () => {
		const raw = (await service.invoke("preview_fcs", { sampleId: logId })) as Result;
		expect(raw.rows).toEqual([
			[0, 0],
			[256, 20],
			[512, 100],
			[768, 200],
		]);
		await expect(service.invoke("start_fcs_export", { sampleId: logId })).rejects.toMatchObject({
			code: "ACQUISITION_SCALE_UNSUPPORTED",
		});
		const submission = (await service.invoke("start_fcs_export", {
			sampleId: logId,
			inputSpace: "linearized",
			renameChannels: { Time: "Seconds" },
		})) as Result;
		const job = await completed(submission.jobId as string);
		expect(job.state).toBe("succeeded");
		const output = await readOutput(job),
			expected = [2, 0, 20, 0.2, 200, 1, 2000, 2];
		let worst = 0;
		for (let i = 0; i < expected.length; i++)
			worst = Math.max(
				worst,
				Math.abs((output.data[i] as number) - (expected[i] as number)) /
					(1 + (expected[i] as number)),
			);
		expect(worst).toBeLessThan(1e-5);
		expect(output.channels.map((c) => [c.amplification, c.gain])).toEqual([
			[[0, 0], 1],
			[[0, 0], 1],
		]);
		expect(output.keywords.$TIMESTEP).toBe("1");
		const receipt = (await service.invoke("get_receipt", { jobId: submission.jobId })) as Result;
		expect(receipt).toMatchObject({
			inputContext: { inputSpace: "linearized" },
			acquisition: {
				profile: output.keywords.FLOWATLAS_ACQUISITION_PROFILE,
				timeGainPolicy: "ignored",
			},
		});
		await expect(
			service.invoke("start_fcs_export", {
				sampleId: logId,
				inputSpace: "linearized",
				keywords: { $TIMESTEP: "0.01" },
			}),
		).rejects.toMatchObject({ code: "MANAGED_KEYWORD" });
	});
	it("binds conventional matrices to their preprocessing context", async () => {
		const spillover = { channels: ["D0", "D1"], matrix: [1, 0.25, 0.125, 1] };
		await expect(
			service.invoke("register_compensation", { sampleId, spillover }),
		).rejects.toMatchObject({ code: "ACQUISITION_SCALE_UNSUPPORTED" });
		const matrix = (await service.invoke("register_compensation", {
			sampleId,
			spillover,
			inputSpace: "linearized",
		})) as Result;
		const preview = (await service.invoke("preview_fcs", {
			sampleId,
			compensationId: matrix.id,
			offset: 7,
			limit: 1,
			channels: ["D0", "D1", "Time"],
		})) as Result;
		const row = (preview.rows as number[][])[0] as number[];
		expect(row[0]).toBeCloseTo(-3, 4);
		expect(row[1]).toBeCloseTo(0, 4);
		expect(row[2]).toBeCloseTo(7, 5);
		await expect(
			service.invoke("preview_fcs", { sampleId, compensationId: matrix.id, inputSpace: "stored" }),
		).rejects.toMatchObject({ code: "PROCESSING_CONTEXT_MISMATCH" });
		await expect(
			service.invoke("start_fcs_export", {
				sampleId,
				compensationId: matrix.id,
				acquisition: { timeStep: 2 },
			}),
		).rejects.toMatchObject({ code: "PROCESSING_CONTEXT_MISMATCH" });
		const stored = (await service.invoke("register_compensation", {
			sampleId: unitId,
			spillover,
		})) as Result;
		const linearized = (await service.invoke("register_compensation", {
			sampleId: unitId,
			spillover,
			inputSpace: "linearized",
		})) as Result;
		expect(stored.id).not.toBe(linearized.id);
	});
	it("registers spectral OLS through MCP and exports named derived columns with residual provenance", async () => {
		await expect(
			service.invoke("register_unmixing", { sampleId, ...reference }),
		).rejects.toMatchObject({ code: "ACQUISITION_SCALE_UNSUPPORTED" });
		const response = await client.callTool({
			name: "register_unmixing",
			arguments: { sampleId, ...reference, inputSpace: "linearized" },
		});
		expect(response.isError).not.toBe(true);
		const text = (response.content as Array<{ text: string }>)[0]?.text as string;
		const definition = JSON.parse(text) as Result;
		const preview = (await service.invoke("preview_fcs", {
			sampleId,
			unmixingId: definition.id,
			offset: 3,
			limit: 1,
			channels: ["F1", "Time", "D2", "fit"],
		})) as Result;
		const row = (preview.rows as number[][])[0] as number[];
		expect(row[0]).toBeCloseTo(1, 4);
		expect(row[1]).toBe(3);
		expect(row[2]).toBeCloseTo(0.75, 5);
		expect(row[3]).toBeLessThan(1e-5);
		expect(preview.columnRoles).toEqual(["unmixed", "linearized", "linearized", "residual-l2"]);
		const submission = (await service.invoke("start_fcs_export", {
			sampleId,
			unmixingId: definition.id,
			channels: ["F1", "Time", "F0", "fit"],
			renameChannels: { F0: "CD3", F1: "CD19" },
			startEvent: 7,
			eventCount: 129,
		})) as Result;
		const job = await completed(submission.jobId as string);
		expect(job.state).toBe("succeeded");
		const output = await readOutput(job);
		expect(output.channels.map((c) => [c.name, c.range, c.gain])).toEqual([
			["CD19", 200, 1],
			["Time", 4096, 1],
			["CD3", 100, 1],
			["fit", 10, 1],
		]);
		expect(output.spill).toBeUndefined();
		expect(output.keywords.$TIMESTEP).toBe("1");
		expect(output.keywords.FLOWATLAS_OUTPUT_LAYOUT).toBe("original-plus-derived");
		let maximum = 0;
		for (let i = 0; i < 129; i++) {
			const [a = 0, b = 0] = abundance(i + 7);
			const expected = [b, i + 7, a, 0];
			for (let j = 0; j < 4; j++)
				maximum = Math.max(
					maximum,
					Math.abs((output.data[i * 4 + j] as number) - (expected[j] as number)),
				);
		}
		expect(maximum).toBeLessThan(1e-4);
		const receipt = (await service.invoke("get_receipt", { jobId: submission.jobId })) as Result;
		expect(receipt).toMatchObject({
			inputContext: { inputSpace: "linearized" },
			columnRoles: ["unmixed", "linearized", "unmixed", "residual-l2"],
			unmixing: {
				matrix: reference.matrix,
				detectors: reference.detectors,
				diagnostics: { rank: 2, source: "gpu-computation" },
			},
		});
		await expect(
			service.invoke("preview_fcs", { sampleId, unmixingId: definition.id, inputSpace: "stored" }),
		).rejects.toMatchObject({ code: "PROCESSING_CONTEXT_MISMATCH" });
	});
	it("rejects conflicting operators and invalid spectral/Time metadata", async () => {
		await expect(
			service.invoke("preview_fcs", { sampleId, compensationId: "x", unmixingId: "y" }),
		).rejects.toMatchObject({ code: "CONFLICTING_PROCESSING" });
		await expect(
			service.invoke("register_unmixing", { sampleId: unitId, ...reference, outputRanges: [1] }),
		).rejects.toMatchObject({ code: "INVALID_OUTPUT_METADATA" });
		await expect(
			service.invoke("register_unmixing", {
				sampleId: unitId,
				...reference,
				fluorochromes: ["Time", "F1"],
			}),
		).rejects.toMatchObject({ code: "INVALID_OUTPUT_METADATA" });
		await expect(
			service.invoke("preview_fcs", { sampleId, acquisition: { timeStep: 1 } }),
		).rejects.toMatchObject({ code: "INVALID_PROCESSING_CONTEXT" });
		await expect(
			service.invoke("start_fcs_export", { sampleId: unitId, renameChannels: { Time: "Seconds" } }),
		).rejects.toMatchObject({ code: "INVALID_OUTPUT_METADATA" });
	});
	it("rejects deficient spectra with numerical diagnostics", async () => {
		await expect(
			service.invoke("register_unmixing", {
				sampleId: unitId,
				detectors: ["D0", "D1", "D2"],
				fluorochromes: ["F0", "F1"],
				matrix: [1, 2, 3, 2, 4, 6],
			}),
		).rejects.toMatchObject({
			code: "NUMERICAL_REJECTION",
			details: { source: "gpu-computation", rank: 1 },
		});
	});
	it.each(["acquisition", "spectral-ols"])(
		"records %s failure and discards staged output",
		async (stage) => {
			const gains = stage === "acquisition" ? [2, 4, 8] : [1, 1, 1];
			const data = mixtures(179, gains);
			data[178 * 4] = Number.NaN;
			const channels = [
				channel("D0", 1, gains[0]),
				channel("D1", 2, gains[1]),
				channel("D2", 3, gains[2]),
				channel("Time", 4, 100),
			];
			await writeFile(join(root, `${stage}.fcs`), synthetic(channels, data, 0.25));
			const imported = (await service.invoke("import_fcs", { path: `${stage}.fcs` })) as Result;
			const definition = (await service.invoke("register_unmixing", {
				sampleId: imported.sampleId,
				...reference,
				inputSpace: "linearized",
			})) as Result;
			const submission = (await service.invoke("start_fcs_export", {
				sampleId: imported.sampleId,
				unmixingId: definition.id,
			})) as Result;
			const job = await completed(submission.jobId as string);
			expect(job).toMatchObject({
				state: "failed",
				error: {
					code: "NUMERICAL_REJECTION",
					details: { stage, sourceChunkStartEvent: 144, sourceChunkEventCount: 35 },
				},
			});
			expect(job.processedEvents).toBe(144);
			expect(job.result).toBeUndefined();
			expect(await readdir(join(root, "outputs"))).not.toContain(submission.jobId);
			expect(await readdir(join(root, ".flow-atlas", "tmp"))).toEqual([]);
		},
	);
});
