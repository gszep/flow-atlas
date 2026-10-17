import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readFcs, writeFcs } from "@flow-atlas/fcs";

const root = await mkdtemp(join(tmpdir(), "flow-atlas-built-"));
const token = randomBytes(24).toString("hex");
let child;
let exited;
let cleanupError;
try {
	const file = await open(join(root, "input.fcs"), "wx");
	try {
		const metadata = {
			version: "FCS3.1",
			keywords: {},
			eventCount: 2,
			channels: ["A", "B"].map((name, i) => ({
				index: i + 1,
				name,
				bits: 32,
				range: 262144,
				amplification: [0, 0],
				gain: 1,
			})),
			spill: {
				channels: ["A", "B"],
				matrix: new Float64Array([1, 0.2, 0.1, 1]),
				source: "$SPILLOVER",
			},
		};
		for await (const chunk of writeFcs(metadata, [new Float32Array([9.8, 0, 2, 20])]))
			await file.writeFile(chunk);
	} finally {
		await file.close();
	}
	child = spawn(
		process.execPath,
		[fileURLToPath(new URL("../dist/main.js", import.meta.url)), "--root", root],
		{ env: { ...process.env, FLOW_ATLAS_TOKEN: token }, stdio: ["ignore", "pipe", "pipe"] },
	);
	exited = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	let stderr = "";
	child.stderr.on("data", (bytes) => {
		stderr = (stderr + bytes).slice(-8192);
	});
	let pending = "";
	let startupTimer;
	const ready = await new Promise((resolve, reject) => {
		startupTimer = setTimeout(
			() => reject(new Error(`Studio startup timed out: ${stderr}`)),
			15_000,
		);
		child.stdout.on("data", (bytes) => {
			pending += bytes;
			for (let index = pending.indexOf("\n"); index >= 0; index = pending.indexOf("\n")) {
				const line = pending.slice(0, index);
				pending = pending.slice(index + 1);
				try {
					const record = JSON.parse(line);
					if (record.state === "ready") resolve(record);
				} catch {
					/* Only the ready record is protocol output. */
				}
			}
			if (pending.length > 65536) reject(new Error("Unexpected oversized startup output"));
		});
		exited.then(
			(exit) => reject(new Error(`Studio exited before ready: ${JSON.stringify(exit)} ${stderr}`)),
			reject,
		);
	}).finally(() => clearTimeout(startupTimer));
	let id = 0;
	const call = async (method, params) => {
		const response = await fetch(`${ready.url}/rpc`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
			signal: AbortSignal.timeout(20_000),
		});
		const result = await response.json();
		assert.equal(response.status, 200);
		assert.equal(result.error, undefined, JSON.stringify(result.error));
		return result.result;
	};
	const capabilities = await call("list_capabilities", {});
	assert.match(capabilities.buildId, /^[a-f0-9]{64}$/);
	const sample = await call("import_fcs", { path: "input.fcs" });
	const matrix = await call("register_compensation", { sampleId: sample.sampleId });
	const job = await call("start_fcs_export", {
		sampleId: sample.sampleId,
		compensationId: matrix.id,
	});
	let status;
	const deadline = Date.now() + 20_000;
	do {
		status = await call("get_job", { jobId: job.jobId });
		if (["succeeded", "failed", "cancelled"].includes(status.state)) break;
		if (Date.now() > deadline) throw new Error("Export did not reach a terminal state");
		await delay(10);
	} while (!["succeeded", "failed", "cancelled"].includes(status.state));
	assert.equal(status.state, "succeeded", JSON.stringify(status));
	const receipt = await call("get_receipt", { jobId: job.jobId });
	assert.equal(receipt.buildId, capabilities.buildId);
	const buffer = await readFile(join(root, status.result.path));
	const output = readFcs(
		buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
	);
	assert.equal(output.spill, undefined);
	assert.equal(output.eventCount, 2);
	const expected = [10, -2, 0, 20];
	assert.ok(output.data.every((value, i) => Math.abs(value - expected[i]) < 0.0001));
	console.log(
		JSON.stringify({
			result: "passed",
			check: "built Node studio: import → GPU compensation → streamed export",
			inputHash: sample.sha256,
			outputHash: status.result.sha256,
		}),
	);
} finally {
	try {
		if (child) {
			child.kill("SIGTERM");
			const timeout = new AbortController();
			const stop = await Promise.race([
				exited,
				delay(10_000, null, { signal: timeout.signal })
					.then(() => null)
					.catch(() => null),
			]);
			timeout.abort();
			if (!stop) {
				child.kill("SIGKILL");
				await exited;
				cleanupError = new Error("Studio did not drain on SIGTERM");
			} else assert.equal(stop.code, 0, JSON.stringify(stop));
		}
	} catch (error) {
		cleanupError = error;
	}
	await rm(root, { recursive: true, force: true });
}
if (cleanupError) throw cleanupError;
