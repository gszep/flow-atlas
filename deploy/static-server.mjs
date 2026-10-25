/**
 * Flow Atlas public demo static server. Zero external dependencies, Node 24.
 *
 * Serves only the staged public UI assets next to this file (`public/`) plus the
 * staged `release.json`. Strict GET/HEAD, single-decode path confinement, no
 * traversal, dotfiles, symlinks, listings or dynamic endpoints. Plain error
 * bodies never echo paths. WebGPU needs no special headers, so none that could
 * break it are set.
 */

import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Only formats the UI build currently emits; everything else 404s.
const MIME = new Map([
	[".html", "text/html; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".mjs", "text/javascript; charset=utf-8"],
	[".css", "text/css; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".map", "application/json; charset=utf-8"],
	[".svg", "image/svg+xml"],
	[".ico", "image/vnd.microsoft.icon"],
	[".txt", "text/plain; charset=utf-8"],
	[".webmanifest", "application/manifest+json"],
]);
const MAX_BYTES = 32 * 1024 * 1024;

function securityHeaders() {
	return {
		"x-content-type-options": "nosniff",
		"referrer-policy": "no-referrer",
		"x-frame-options": "DENY",
		"cross-origin-resource-policy": "same-origin",
		"x-flow-atlas-runtime": `node/${process.version}`,
	};
}

function send(response, status, headers, body, headOnly) {
	response.writeHead(status, {
		...securityHeaders(),
		"content-length": String(body.byteLength),
		...headers,
	});
	if (headOnly) response.end();
	else response.end(body);
}

function plain(response, status, text, headOnly, extra = {}) {
	send(
		response,
		status,
		{ "content-type": "text/plain; charset=utf-8", ...extra },
		Buffer.from(text),
		headOnly,
	);
}

const notFound = (response, headOnly) => plain(response, 404, "Not found", headOnly);

/**
 * Decode the request path exactly once and confine it under publicRoot.
 * Returns an absolute filesystem path or null (caller answers 404) or the
 * string "bad" for malformed/traversal input (caller answers 400).
 */
function resolveRequestPath(publicRoot, rawUrl) {
	let queryless;
	try {
		queryless = new URL(rawUrl, "http://local").pathname;
	} catch {
		return "bad";
	}
	let decoded;
	try {
		decoded = decodeURIComponent(queryless);
	} catch {
		return "bad";
	}
	// Exactly one decode already happened; further encoded traversal must not exist.
	if (/%|\\|\0/.test(decoded)) return "bad";
	const segments = decoded.split("/").filter((segment) => segment !== "" && segment !== ".");
	// A trailing slash names a directory; only "/" itself maps to the staged index.
	if (
		segments.some((segment) => segment.startsWith(".")) ||
		(decoded.length > 1 && decoded.endsWith("/"))
	)
		return null; // dotfiles and slash-suffixed paths: not found
	const target = resolve(publicRoot, ...segments);
	if (target !== publicRoot && !target.startsWith(`${publicRoot}${sep}`)) return "bad";
	return target;
}

/**
 * Stat without following symlinks and verify the real path stays confined under
 * the real public root, so a staged symlink can never escape. Returns null when
 * absent or outside. macOS tmpdir paths differ lexically from their real path
 * (/var vs /private/var), so confinement always compares real paths.
 */
async function readableRegularFile(_publicRoot, realRoot, target) {
	try {
		const info = await lstat(target);
		if (!info.isFile()) return null;
		const real = await realpath(target);
		if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) return null;
		if (info.size > MAX_BYTES) return null;
		const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		try {
			return { size: info.size, handle };
		} catch (error) {
			await handle.close();
			throw error;
		}
	} catch (error) {
		if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP") return null;
		throw error;
	}
}

async function serveFromRoot(publicRoot, realRoot, target, response, headOnly, cache) {
	const file = await readableRegularFile(publicRoot, realRoot, target);
	if (!file) return notFound(response, headOnly);
	try {
		const extension = target.slice(target.lastIndexOf("."));
		const type = MIME.get(extension);
		if (type === undefined) return notFound(response, headOnly);
		const bytes = Buffer.alloc(file.size);
		let offset = 0;
		while (offset < file.size) {
			const { bytesRead } = await file.handle.read(bytes, offset, file.size - offset);
			if (!bytesRead) throw new Error("short static read");
			offset += bytesRead;
		}
		send(response, 200, { "content-type": type, "cache-control": cache }, bytes, headOnly);
	} finally {
		await file.handle.close();
	}
}

export function createStaticServer(options = {}) {
	const publicRoot = resolve(options.publicRoot ?? resolve(HERE, "public"));
	const releasePath = resolve(options.releasePath ?? resolve(HERE, "release.json"));
	const packageRoot = dirname(publicRoot);
	// Confinement anchors are real paths; resolved lazily once per server. The release
	// manifest lives at the package root, outside public/, so it is confined there.
	const realPublicRoot = realpath(publicRoot).catch(() => publicRoot);
	const realPackageRoot = realpath(packageRoot).catch(() => packageRoot);
	const log = options.log === undefined ? (line) => console.log(line) : options.log;
	const server = createServer(async (request, response) => {
		const started = Date.now();
		const headOnly = request.method === "HEAD";
		const realRoot = await realPublicRoot;
		const packageRealRoot = await realPackageRoot;
		const finish = (status) => {
			log(`${request.method} ${truncateUrl(request.url)} -> ${status} ${Date.now() - started}ms`);
		};
		try {
			if (request.method !== "GET" && request.method !== "HEAD") {
				plain(response, 405, "Method not allowed", headOnly, { allow: "GET, HEAD" });
				finish(405);
				return;
			}
			const target = resolveRequestPath(publicRoot, request.url ?? "/");
			if (target === "bad") {
				plain(response, 400, "Bad request", headOnly);
				finish(400);
				return;
			}
			if (target === null) {
				notFound(response, headOnly);
				finish(404);
				return;
			}
			// "/" maps to the staged index; release.json lives at the package root and is
			// never store-cached.
			if (target === publicRoot || target === resolve(publicRoot, "index.html")) {
				await serveFromRoot(
					publicRoot,
					realRoot,
					resolve(publicRoot, "index.html"),
					response,
					headOnly,
					"no-store",
				);
				finish(200);
				return;
			}
			if (target === resolve(publicRoot, "release.json")) {
				await serveFromRoot(
					packageRoot,
					packageRealRoot,
					releasePath,
					response,
					headOnly,
					"no-store",
				);
				finish(200);
				return;
			}
			// Hashed build assets are immutable; everything else revalidates.
			const name = target.slice(target.lastIndexOf(sep) + 1);
			const immutable = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/.test(name);
			await serveFromRoot(
				publicRoot,
				realRoot,
				target,
				response,
				headOnly,
				immutable ? "public, max-age=31536000, immutable" : "no-cache",
			);
			finish(200);
		} catch (error) {
			plain(response, 500, "Internal error", headOnly);
			finish(500);
			log(`static server error: ${error instanceof Error ? error.message : "unknown"}`);
		}
	});
	return server;
}

function truncateUrl(value) {
	const text = String(value).replaceAll(/[\r\n\t ]+/g, "_");
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

export async function main() {
	const port = Number(process.env.PORT ?? 8080);
	const host = process.env.HOST ?? "0.0.0.0";
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		console.error("static server: invalid PORT");
		process.exitCode = 1;
		return;
	}
	// Fail fast when the staged layout is missing instead of serving 404s forever.
	const releasePath = resolve(HERE, "release.json");
	for (const required of [resolve(HERE, "public"), releasePath]) {
		try {
			await lstat(required);
		} catch {
			console.error(
				`static server: staged ${required === releasePath ? "release.json" : "public/"} is missing`,
			);
			process.exitCode = 1;
			return;
		}
	}
	const server = createStaticServer();
	await new Promise((ready, failed) => {
		server.once("error", failed);
		server.listen(port, host, ready);
	});
	const address = server.address();
	const shown = typeof address === "object" && address ? address.port : port;
	const sourceSha = await readFile(releasePath, "utf8")
		.then((text) => {
			const parsed = JSON.parse(text);
			return typeof parsed?.source?.gitSha === "string" ? parsed.source.gitSha : "unknown";
		})
		.catch(() => "unknown");
	console.log(
		`flow-atlas demo static server: node/${process.version} sha ${sourceSha.slice(0, 12)} listening on ${host}:${shown}`,
	);
	const stopped = new Promise((done) => {
		const close = () => {
			server.close(() => done());
		};
		process.on("SIGTERM", close);
		process.on("SIGINT", close);
	});
	await stopped;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
