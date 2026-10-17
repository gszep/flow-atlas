#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createAnalysisService } from "./analysis.js";
import { createStudioServer } from "./server.js";

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			root: { type: "string", default: process.cwd() },
			port: { type: "string", default: "0" },
			ui: { type: "string" },
			help: { type: "boolean" },
		},
	});
	if (values.help) {
		console.log(
			"flow-atlas [--root DIRECTORY] [--port PORT] [--ui BUILT_UI_DIRECTORY]\nStarts a local studio with MCP /mcp and JSON-RPC /rpc. FLOW_ATLAS_TOKEN sets a bearer token; otherwise a private connection file is created.",
		);
		return;
	}
	const port = Number(values.port);
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw new Error("Port must be an integer between 0 and 65535");
	const root = await realpath(values.root);
	const generated = !process.env.FLOW_ATLAS_TOKEN;
	const token = process.env.FLOW_ATLAS_TOKEN || randomBytes(32).toString("base64url");
	let uiDirectory = values.ui;
	if (!uiDirectory) {
		const candidate = fileURLToPath(new URL("../../ui/dist", import.meta.url));
		try {
			await access(join(candidate, "index.html"));
			uiDirectory = candidate;
		} catch {
			/* Headless studio does not require the UI build. */
		}
	}
	const service = await createAnalysisService({ root });
	let server: Awaited<ReturnType<typeof createStudioServer>>;
	try {
		server = await createStudioServer({
			service,
			token,
			port,
			...(uiDirectory ? { uiDirectory } : {}),
		});
	} catch (error) {
		await service.close();
		throw error;
	}
	let connectionFile: string | undefined;
	let connectionDirectory: string | undefined;
	try {
		if (generated) {
			connectionDirectory = await mkdtemp(join(tmpdir(), "flow-atlas-connection-"));
			connectionFile = join(connectionDirectory, `connection-${randomUUID()}.json`);
			await writeFile(
				connectionFile,
				`${JSON.stringify({ url: server.url, mcp: `${server.url}/mcp`, rpc: `${server.url}/rpc`, token })}\n`,
				{ flag: "wx", mode: 0o600 },
			);
		}
	} catch (error) {
		await server.close();
		if (connectionDirectory) await rm(connectionDirectory, { recursive: true, force: true });
		throw error;
	}
	console.log(
		JSON.stringify({
			state: "ready",
			root,
			url: server.url,
			mcp: `${server.url}/mcp`,
			rpc: `${server.url}/rpc`,
			...(connectionFile ? { connectionFile } : { tokenSource: "FLOW_ATLAS_TOKEN" }),
		}),
	);
	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		try {
			await server.close();
		} finally {
			if (connectionDirectory) await rm(connectionDirectory, { recursive: true, force: true });
		}
	};
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.once(signal, () => {
			void stop().catch((error: unknown) => {
				console.error(error);
				process.exitCode = 1;
			});
		});
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
