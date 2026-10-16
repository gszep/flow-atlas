import { timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import {
	AnalysisError,
	type AnalysisService,
	boundedJson,
	errorFields,
	MAX_BODY_BYTES,
} from "./contracts.js";
import { createAnalysisMcpServer, invokeOperation } from "./tools.js";

export interface StudioServerOptions {
	service: AnalysisService;
	token: string;
	host?: "127.0.0.1" | "::1";
	port?: number;
	uiDirectory?: string;
}
export interface StudioServer {
	url: string;
	close(): Promise<void>;
}

function send(res: ServerResponse, status: number, value: unknown): void {
	if (res.destroyed || res.writableEnded) return;
	let text: string;
	try {
		text = boundedJson(value);
	} catch (error) {
		status = 500;
		text = boundedJson({
			jsonrpc: "2.0",
			id: null,
			error: { code: -32001, message: "Response limit exceeded", data: errorFields(error) },
		});
	}
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff",
	});
	res.end(text);
}

function rpcError(error: unknown, id: unknown = null) {
	let fields = errorFields(error);
	try {
		boundedJson(fields, 256 * 1024);
	} catch (failure) {
		fields = errorFields(failure);
	}
	const codes: Record<string, number> = {
		PARSE_ERROR: -32700,
		INVALID_REQUEST: -32600,
		METHOD_NOT_FOUND: -32601,
		INVALID_PARAMS: -32602,
		INTERNAL_ERROR: -32603,
	};
	return {
		jsonrpc: "2.0" as const,
		id,
		error: {
			code: Object.hasOwn(codes, fields.code) ? (codes[fields.code] ?? -32000) : -32000,
			message: fields.message,
			data: fields,
		},
	};
}

async function readBody(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
	return new Promise((resolveBody, reject) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		const cleanup = () => {
			req.off("data", data);
			req.off("end", end);
			req.off("error", fail);
			signal.removeEventListener("abort", abort);
		};
		const fail = (error: unknown) => {
			cleanup();
			reject(error);
		};
		const abort = () => fail(new AnalysisError("REQUEST_CANCELLED", "Request cancelled"));
		const data = (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_BODY_BYTES) {
				fail(new AnalysisError("BODY_TOO_LARGE", "Request body exceeds 1 MiB"));
				req.resume();
			} else chunks.push(chunk);
		};
		const end = () => {
			cleanup();
			try {
				resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new AnalysisError("PARSE_ERROR", "Invalid JSON"));
			}
		};
		req.on("data", data);
		req.once("end", end);
		req.once("error", fail);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validEnvelope(body: unknown): body is Record<string, unknown> & { method: string } {
	return (
		isRecord(body) &&
		body.jsonrpc === "2.0" &&
		typeof body.method === "string" &&
		body.method.length <= 128 &&
		(!Object.hasOwn(body, "id") ||
			body.id === null ||
			(typeof body.id === "string" && body.id.length <= 256) ||
			(typeof body.id === "number" && Number.isFinite(body.id)))
	);
}

async function rpc(
	service: AnalysisService,
	body: unknown,
	res: ServerResponse,
	signal: AbortSignal,
) {
	if (!validEnvelope(body)) {
		send(
			res,
			400,
			rpcError(
				new AnalysisError(
					"INVALID_REQUEST",
					"Expected a single JSON-RPC 2.0 request with method <=128 and string id <=256 characters",
				),
			),
		);
		return;
	}
	const notification = !Object.hasOwn(body, "id");
	try {
		const result = await invokeOperation(
			service,
			body.method,
			Object.hasOwn(body, "params") ? body.params : {},
			signal,
		);
		if (notification) {
			res.writeHead(204);
			res.end();
			return;
		}
		if (result === undefined)
			throw new AnalysisError("INVALID_RESULT", "Backend must return finite JSON data");
		// Serialize here to preserve the caller's id even for oversize results.
		const response = { jsonrpc: "2.0", id: body.id, result };
		boundedJson(response);
		send(res, 200, response);
	} catch (error) {
		if (notification) {
			res.writeHead(204);
			res.end();
			return;
		}
		send(res, 200, rpcError(error, body.id));
	}
}

const contentTypes: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};
async function staticAsset(
	root: string,
	pathname: string,
	req: IncomingMessage,
	res: ServerResponse,
	signal: AbortSignal,
) {
	let path: string;
	try {
		path = decodeURIComponent(pathname);
	} catch {
		send(res, 400, { error: "Invalid path" });
		return;
	}
	const within = (file: string) => {
		const rel = relative(root, file);
		return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
	};
	const target = resolve(root, `.${path === "/" ? "/index.html" : path}`);
	if (!within(target)) {
		send(res, 403, { error: "Forbidden" });
		return;
	}
	try {
		const file = await realpath(target);
		if (!within(file)) {
			send(res, 403, { error: "Forbidden" });
			return;
		}
		const info = await stat(file);
		if (!info.isFile()) {
			send(res, 404, { error: "Not found" });
			return;
		}
		res.writeHead(200, {
			"content-type": contentTypes[extname(file)] ?? "application/octet-stream",
			"content-length": info.size,
			"x-content-type-options": "nosniff",
			"content-security-policy":
				"default-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
			"referrer-policy": "no-referrer",
		});
		if (req.method === "HEAD") res.end();
		else await pipeline(createReadStream(file), res, { signal });
	} catch (error) {
		if (res.headersSent) res.destroy();
		else if (isRecord(error) && error.code === "ENOENT") send(res, 404, { error: "Not found" });
		else send(res, 500, { error: "Static asset unavailable" });
	}
}

/** Loopback-only, bearer-authenticated transport. The supplied service owns all analysis and jobs. */
export async function createStudioServer(options: StudioServerOptions): Promise<StudioServer> {
	const host = options.host ?? "127.0.0.1";
	if (host !== "127.0.0.1" && host !== "::1")
		throw new Error("Studio must bind to a loopback address");
	if (typeof options.token !== "string" || !/^[A-Za-z0-9._~+/-]+=*$/u.test(options.token))
		throw new Error("A nonempty whitespace-free bearer token is required");
	const authorization = Buffer.from(`Bearer ${options.token}`);
	const root = options.uiDirectory ? await realpath(options.uiDirectory) : undefined;
	let url = "";
	let authority = "";
	let closing = false;
	const controllers = new Set<AbortController>();
	const tasks = new Set<Promise<void>>();
	const invocations = new Set<Promise<unknown>>();
	const service: AnalysisService = {
		invoke(name, args, signal) {
			const promise = Promise.resolve().then(() => {
				signal?.throwIfAborted();
				return options.service.invoke(name, args, signal);
			});
			invocations.add(promise);
			void promise.then(
				() => invocations.delete(promise),
				() => invocations.delete(promise),
			);
			return promise;
		},
		close: () => options.service.close(),
	};
	const handle = async (req: IncomingMessage, res: ServerResponse, signal: AbortSignal) => {
		if (closing) {
			send(res, 503, { error: "Server closing" });
			return;
		}
		if (
			req.headers.host !== authority ||
			(req.headers.origin !== undefined && req.headers.origin !== url)
		) {
			send(res, 403, { error: "Host or Origin rejected" });
			return;
		}
		if (!req.url?.startsWith("/") || req.url.startsWith("//")) {
			send(res, 400, { error: "Invalid request target" });
			return;
		}
		const pathname = new URL(req.url, url).pathname;
		if (pathname === "/health" && req.method === "GET") {
			send(res, 200, {
				status: "ok",
				service: "flow-atlas",
				transport: "analysis",
				collaboration: false,
			});
			return;
		}
		if (pathname !== "/rpc" && pathname !== "/mcp") {
			if (root && (req.method === "GET" || req.method === "HEAD"))
				await staticAsset(root, pathname, req, res, signal);
			else send(res, 404, { error: "Not found" });
			return;
		}
		const supplied = Buffer.from(req.headers.authorization ?? "");
		if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
			res.setHeader("www-authenticate", "Bearer");
			send(res, 401, { error: "Unauthorized" });
			return;
		}
		if (req.method !== "POST") {
			res.setHeader("allow", "POST");
			send(res, 405, { error: "Only POST is supported" });
			return;
		}
		if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
			send(res, 415, { error: "Expected application/json" });
			return;
		}
		if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") {
			send(res, 415, { error: "Compressed requests are unsupported" });
			return;
		}
		try {
			const body = await readBody(req, signal);
			if (pathname === "/rpc") {
				await rpc(service, body, res, signal);
				return;
			}
			// No batches/fan-out. Bound echoed IDs before entering the SDK's response paths.
			if (!validEnvelope(body)) {
				send(
					res,
					400,
					rpcError(
						new AnalysisError(
							"INVALID_REQUEST",
							"Expected a single JSON-RPC 2.0 request with method <=128 and string id <=256 characters",
						),
					),
				);
				return;
			}
			const mcp = createAnalysisMcpServer(service, signal);
			const transport = new NodeStreamableHTTPServerTransport({
				sessionIdGenerator: undefined,
				enableJsonResponse: true,
			});
			const originalSend = transport.send.bind(transport);
			transport.send = async (message, sendOptions) => {
				try {
					boundedJson(message);
				} catch (error) {
					if ("id" in message) {
						const response = rpcError(error);
						await originalSend(
							{
								jsonrpc: "2.0",
								...(message.id === undefined ? {} : { id: message.id }),
								error: response.error,
							},
							sendOptions,
						);
						return;
					}
					throw error;
				}
				await originalSend(message, sendOptions);
			};
			try {
				await mcp.connect(transport);
				await transport.handleRequest(req, res, body);
			} finally {
				await mcp.close();
			}
		} catch (error) {
			send(
				res,
				error instanceof AnalysisError && error.code === "BODY_TOO_LARGE" ? 413 : 400,
				rpcError(error),
			);
		}
	};
	const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, (req, res) => {
		const controller = new AbortController();
		controllers.add(controller);
		const abort = () => controller.abort();
		req.once("aborted", abort);
		res.once("close", abort);
		const task = handle(req, res, controller.signal)
			.catch(() => {
				if (!res.headersSent) send(res, 500, { error: "Internal transport error" });
				else res.destroy();
			})
			.finally(() => {
				controllers.delete(controller);
				tasks.delete(task);
				req.off("aborted", abort);
				res.off("close", abort);
			});
		tasks.add(task);
	});
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, host, () => {
			server.off("error", reject);
			resolveListen();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing TCP address");
	authority = `${host === "::1" ? "[::1]" : host}:${address.port}`;
	url = `http://${authority}`;
	let closed: Promise<void> | undefined;
	return {
		url,
		close() {
			closed ??= (async () => {
				closing = true;
				const stopped = new Promise<void>((done, reject) =>
					server.close((error) => (error ? reject(error) : done())),
				);
				for (const controller of controllers) controller.abort();
				server.closeAllConnections();
				// Service.close must cancel/drain backend-owned jobs, including work not tied to an HTTP request.
				try {
					await service.close();
				} finally {
					await Promise.allSettled([...tasks, ...invocations]);
					await stopped;
				}
			})();
			return closed;
		},
	};
}
