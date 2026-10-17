import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, renameSync } from "node:fs";
import { mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { writeFcs } from "@flow-atlas/fcs";
import { afterEach, expect, it, vi } from "vitest";
import { createAnalysisService } from "../src/analysis.js";
import type { AnalysisService } from "../src/contracts.js";

const admission = vi.hoisted(() => ({
	beforeOpen: undefined as undefined | ((path: unknown, flags: unknown) => void),
}));
vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			admission.beforeOpen?.(args[0], args[1]);
			return actual.open(...args);
		},
	};
});
const roots: string[] = [];
const services: AnalysisService[] = [];
afterEach(async () => {
	admission.beforeOpen = undefined;
	for (const service of services.splice(0)) await service.close();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function directory() {
	const root = await mkdtemp(join(tmpdir(), "flow-atlas-artifact-review-"));
	roots.push(root);
	return root;
}
async function fixture(path: string, value: number) {
	const file = await open(path, "wx");
	try {
		for await (const chunk of writeFcs(
			{
				version: "FCS3.1",
				eventCount: 1,
				keywords: {},
				channels: [
					{ index: 1, name: "A", bits: 32, range: 262144, amplification: [0, 0], gain: 1 },
				],
			},
			[new Float32Array([value])],
		))
			await file.writeFile(chunk);
	} finally {
		await file.close();
	}
}

it("refuses published receipts reached through an outside-root directory link", async () => {
	const root = await directory(),
		outside = await directory();
	const service = await createAnalysisService({ root });
	services.push(service);
	const id = randomUUID();
	await writeFile(
		join(outside, "receipt.json"),
		JSON.stringify({ jobId: id, state: "succeeded", marker: "outside-root" }),
	);
	await symlink(outside, join(root, "outputs", id));
	await expect(service.invoke("get_receipt", { jobId: id })).rejects.toMatchObject({
		code: "PATH_OUTSIDE_ROOT",
	});
	await expect(service.invoke("get_job", { jobId: id })).rejects.toMatchObject({
		code: "PATH_OUTSIDE_ROOT",
	});
});

it("does not relabel replacement events with a verified cold-cache content hash", async () => {
	const root = await directory();
	await fixture(join(root, "input.fcs"), 1);
	await fixture(join(root, "replacement.fcs"), 99);
	const first = await createAnalysisService({ root });
	services.push(first);
	const imported = (await first.invoke("import_fcs", { path: "input.fcs" })) as {
		sampleId: string;
	};
	await first.close();
	const second = await createAnalysisService({ root });
	services.push(second);
	const stored = await realpath(join(root, ".flow-atlas", "inputs", `${imported.sampleId}.fcs`));
	let opens = 0,
		replaced = false;
	admission.beforeOpen = (path, flags) => {
		if (path === stored && typeof flags === "number" && ++opens === 2) {
			renameSync(join(root, "replacement.fcs"), stored);
			replaced = true;
		}
	};
	await expect(second.invoke("preview_fcs", { sampleId: imported.sampleId })).rejects.toMatchObject(
		{ code: "INTEGRITY_ERROR" },
	);
	expect(replaced).toBe(true);
});

it.skipIf(process.platform === "win32")(
	"rejects an unwritten FIFO without waiting for a writer",
	async () => {
		const root = await directory();
		const pipe = join(root, "pipe.fcs");
		await promisify(execFile)("mkfifo", [pipe]);
		const service = await createAnalysisService({ root });
		services.push(service);
		let releasedByWatchdog = false;
		let writer: Promise<void> | undefined;
		const watchdog = setTimeout(() => {
			releasedByWatchdog = true;
			writer = open(pipe, constants.O_WRONLY | constants.O_NONBLOCK)
				.then((handle) => handle.close())
				.catch((error: NodeJS.ErrnoException) => {
					if (error.code !== "ENXIO") throw error;
				});
		}, 2000);
		try {
			await expect(service.invoke("import_fcs", { path: "pipe.fcs" })).rejects.toMatchObject({
				code: "INVALID_FILE",
			});
			expect(releasedByWatchdog).toBe(false);
			await service.close();
		} finally {
			clearTimeout(watchdog);
			await writer;
		}
	},
);
