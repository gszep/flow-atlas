import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AnalysisError,
	type AnalysisService,
	boundedJson,
	createStudioServer,
	MAX_BODY_BYTES,
	operationSchemas,
	type StudioServer,
	validateOperation,
} from "../src/index.js";

const token = "test-secret-not-logged";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function start(invoke: AnalysisService["invoke"] = async (name, args) => ({ name, args })) {
	const service = { invoke: vi.fn(invoke), close: vi.fn(async () => {}) };
	const server = await createStudioServer({ service, token });
	cleanup.push(() => server.close());
	return { server, service };
}
function post(server: StudioServer, method: string, params: unknown = {}, extra: RequestInit = {}) {
	return fetch(`${server.url}/rpc`, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
		...extra,
	});
}
async function mcp(server: StudioServer) {
	const client = new Client({ name: "transport-test", version: "1" });
	cleanup.push(() => client.close());
	await client.connect(
		new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
			requestInit: { headers: { authorization: `Bearer ${token}` } },
		}),
	);
	return client;
}

describe("studio transport", () => {
	it("SDK initialize/list/call and RPC invoke the same injected service", async () => {
		const { server, service } = await start();
		const client = await mcp(server);
		const list = await client.listTools();
		expect(list.tools.map((tool) => tool.name).sort()).toEqual(
			Object.keys(operationSchemas).sort(),
		);
		expect(
			list.tools.find((tool) => tool.name === "list_samples")?.inputSchema.additionalProperties,
		).toBe(false);
		const call = await client.callTool({ name: "list_samples", arguments: { limit: 2 } });
		expect(call).toMatchObject({
			content: [
				{ type: "text", text: JSON.stringify({ name: "list_samples", args: { limit: 2 } }) },
			],
		});
		expect(await (await post(server, "list_samples", { limit: 2 })).json()).toEqual({
			jsonrpc: "2.0",
			id: 7,
			result: { name: "list_samples", args: { limit: 2 } },
		});
		expect(service.invoke.mock.calls.map(([name, args]) => ({ name, args }))).toEqual([
			{ name: "list_samples", args: { limit: 2 } },
			{ name: "list_samples", args: { limit: 2 } },
		]);
	});
	it("rejects unknown fields and bad arguments before invoking the backend", async () => {
		const { server, service } = await start();
		const response = await (
			await post(server, "list_samples", { limit: 101, unexpected: true })
		).json();
		expect(response).toMatchObject({
			id: 7,
			error: { code: -32602, data: { code: "INVALID_PARAMS" } },
		});
		const client = await mcp(server);
		expect(
			await client.callTool({ name: "list_samples", arguments: { unexpected: true } }),
		).toMatchObject({ isError: true });
		expect(service.invoke).not.toHaveBeenCalled();
		expect(() =>
			validateOperation("register_compensation", {
				sampleId: "a",
				spillover: { channels: ["A"], matrix: [Infinity] },
			}),
		).toThrow(AnalysisError);
		expect(() => validateOperation("__proto__", {})).toThrow(AnalysisError);
	});
	it("preserves typed backend errors on both protocols and hides unexpected exceptions", async () => {
		const failure = new AnalysisError("GPU_UNAVAILABLE", "GPU required", { fallback: false });
		const { server, service } = await start(async () => {
			throw failure;
		});
		const client = await mcp(server);
		const rpc = await (await post(server, "list_capabilities")).json();
		const tool = await client.callTool({ name: "list_capabilities", arguments: {} });
		expect(tool).toMatchObject({ isError: true, structuredContent: { error: rpc.error.data } });
		expect(rpc.error).toMatchObject({
			code: -32000,
			data: { code: "GPU_UNAVAILABLE", message: "GPU required", details: { fallback: false } },
		});
		service.invoke.mockRejectedValue(new Error(`private-path-${token}`));
		expect(await (await post(server, "list_capabilities")).text()).not.toContain(token);
	});
	it("fails closed for auth, Origin, Host and unsupported HTTP methods", async () => {
		const { server, service } = await start();
		const statuses = [];
		for (const endpoint of ["rpc", "mcp"]) {
			for (const supplied of [undefined, "Bearer wrong", "Basic test"]) {
				statuses.push(
					(
						await fetch(`${server.url}/${endpoint}`, {
							method: "POST",
							headers: supplied ? { authorization: supplied } : {},
						})
					).status,
				);
			}
		}
		expect(statuses).toEqual([401, 401, 401, 401, 401, 401]);
		expect(
			(
				await post(
					server,
					"list_capabilities",
					{},
					{ headers: { ...headers, origin: "http://evil.test" } },
				)
			).status,
		).toBe(403);
		expect(
			(await post(server, "list_capabilities", {}, { headers: { ...headers, origin: "null" } }))
				.status,
		).toBe(403);
		const badHost = await new Promise<number | undefined>((done, reject) => {
			const req = request(
				`${server.url}/rpc`,
				{ method: "POST", headers: { ...headers, host: "evil.test" } },
				(res) => {
					res.resume();
					res.on("end", () => done(res.statusCode));
				},
			);
			req.on("error", reject);
			req.end("{}");
		});
		expect(badHost).toBe(403);
		expect((await fetch(`${server.url}/mcp`, { headers })).status).toBe(405);
		expect(service.invoke).not.toHaveBeenCalled();
		expect(
			(await post(server, "list_capabilities", {}, { headers: { ...headers, origin: server.url } }))
				.status,
		).toBe(200);
	});
	it("bounds request bodies for both transports, including chunked bodies", async () => {
		const { server, service } = await start();
		const huge = `"${"x".repeat(MAX_BODY_BYTES)}"`;
		for (const endpoint of ["rpc", "mcp"]) {
			const status = await new Promise<number | undefined>((done, reject) => {
				const req = request(`${server.url}/${endpoint}`, { method: "POST", headers }, (res) => {
					res.resume();
					res.on("end", () => done(res.statusCode));
				});
				req.on("error", reject);
				req.write(huge.slice(0, 512000));
				req.end(huge.slice(512000));
			});
			expect(status).toBe(413);
		}
		expect(service.invoke).not.toHaveBeenCalled();
	});
	it("uses stable JSON-RPC errors, notification semantics and rejects batches", async () => {
		const { server } = await start();
		const invalid = await (await post(server, "x", {}, { body: "{" })).json();
		expect(invalid.error.code).toBe(-32700);
		expect((await (await post(server, "x")).json()).error.code).toBe(-32601);
		expect((await (await post(server, "x", {}, { body: "[]" })).json()).error.code).toBe(-32600);
		const notification = await post(
			server,
			"list_capabilities",
			{},
			{ body: JSON.stringify({ jsonrpc: "2.0", method: "list_capabilities" }) },
		);
		expect(notification.status).toBe(204);
		expect(await notification.text()).toBe("");
	});
	it("bounds huge results before JSON serialization on both transports", async () => {
		const { server } = await start(async () => ({ huge: "x".repeat(2 * MAX_BODY_BYTES) }));
		expect(await (await post(server, "list_capabilities")).json()).toMatchObject({
			id: 7,
			error: { data: { code: "RESPONSE_TOO_LARGE" } },
		});
		const client = await mcp(server);
		expect(await client.callTool({ name: "list_capabilities", arguments: {} })).toMatchObject({
			isError: true,
			structuredContent: { error: { code: "RESPONSE_TOO_LARGE" } },
		});
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => boundedJson(cyclic)).toThrow(AnalysisError);
		expect(() => boundedJson(new Float32Array(10))).toThrow(AnalysisError);
	});

	it("rejects undefined backend results rather than sending invalid JSON-RPC success", async () => {
		const { server } = await start(async () => undefined);
		expect(await (await post(server, "list_capabilities")).json()).toMatchObject({
			id: 7,
			error: { data: { code: "INVALID_RESULT" } },
		});
		const client = await mcp(server);
		expect(await client.callTool({ name: "list_capabilities", arguments: {} })).toMatchObject({
			isError: true,
			structuredContent: { error: { code: "INVALID_RESULT" } },
		});
	});

	it("rejects batch fan-out and oversized echoed identifiers on both protocols", async () => {
		const { server, service } = await start();
		const statuses = [];
		for (const endpoint of ["rpc", "mcp"]) {
			for (const body of [
				[{ jsonrpc: "2.0", id: 1, method: "list_capabilities" }],
				{ jsonrpc: "2.0", id: "x".repeat(300), method: "list_capabilities" },
			]) {
				const response = await fetch(`${server.url}/${endpoint}`, {
					method: "POST",
					headers,
					body: JSON.stringify(body),
				});
				statuses.push([response.status, (await response.json()).error.code]);
			}
		}
		expect(statuses).toEqual([
			[400, -32600],
			[400, -32600],
			[400, -32600],
			[400, -32600],
		]);
		expect(service.invoke).not.toHaveBeenCalled();
	});

	it.each(["rpc", "mcp"])(
		"propagates %s disconnect cancellation and drains resources",
		async (endpoint) => {
			const entered = Promise.withResolvers<void>();
			const aborted = Promise.withResolvers<void>();
			const { server, service } = await start(async (_name, _args, signal) => {
				entered.resolve();
				await new Promise<void>((_resolve, reject) => {
					const cancel = () => {
						aborted.resolve();
						reject(new AnalysisError("REQUEST_CANCELLED", "Cancelled"));
					};
					if (signal?.aborted) cancel();
					else signal?.addEventListener("abort", cancel, { once: true });
				});
			});
			const controller = new AbortController();
			const response = fetch(`${server.url}/${endpoint}`, {
				method: "POST",
				headers: {
					...headers,
					accept: "application/json, text/event-stream",
					"mcp-protocol-version": "2025-11-25",
				},
				signal: controller.signal,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: endpoint === "rpc" ? "list_capabilities" : "tools/call",
					params: endpoint === "rpc" ? {} : { name: "list_capabilities", arguments: {} },
				}),
			}).catch((error) => error);
			await entered.promise;
			controller.abort();
			await aborted.promise;
			await response;
			await Promise.all([server.close(), server.close()]);
			expect(service.close).toHaveBeenCalledTimes(1);
		},
	);
	it("server close aborts in-flight work and calls backend close once", async () => {
		const entered = Promise.withResolvers<void>();
		let aborted = false;
		const { server, service } = await start(async (_name, _args, signal) => {
			entered.resolve();
			return new Promise((_resolve, reject) =>
				signal?.addEventListener(
					"abort",
					() => {
						aborted = true;
						reject(new Error("aborted"));
					},
					{ once: true },
				),
			);
		});
		const response = post(server, "list_capabilities").catch((error) => error);
		await entered.promise;
		await server.close();
		await response;
		expect(aborted).toBe(true);
		expect(service.close).toHaveBeenCalledTimes(1);
	});
	it("serves optional static assets, prevents symlink escape, and exposes nonsecret health", async () => {
		const directory = await mkdtemp(join(tmpdir(), "flow-host-test-"));
		cleanup.push(() => rm(directory, { recursive: true, force: true }));
		const root = join(directory, "index.html");
		await writeFile(root, "<h1>Studio</h1>");
		await symlink("/etc/hosts", join(directory, "outside.txt"));
		const service: AnalysisService = { invoke: async () => null, close: async () => {} };
		const server = await createStudioServer({ service, token, uiDirectory: directory });
		cleanup.push(() => server.close());
		expect(await (await fetch(server.url)).text()).toBe("<h1>Studio</h1>");
		expect((await fetch(`${server.url}/outside.txt`)).status).toBe(403);
		expect(await (await fetch(`${server.url}/health`)).json()).toMatchObject({
			status: "ok",
			collaboration: false,
		});
		expect((await fetch(`${server.url}/missing.js`)).status).toBe(404);
	});
});
