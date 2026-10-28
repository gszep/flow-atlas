/**
 * Flow Atlas public demo server, Node 24. Static assets plus a bounded demo API.
 *
 * Serves only the staged public UI assets next to this file (`public/`) plus the
 * staged `release.json`. Strict GET/HEAD, single-decode path confinement, no
 * traversal, dotfiles, symlinks or listings. Authenticated /api/demo routes are
 * separate from static routing and never expose the local host studio. Plain error
 * bodies never echo paths. WebGPU needs no special headers, so none that could
 * break it are set.
 */

import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createDemoApi } from "./demo-api.mjs";

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
const MAX_MANIFEST_BYTES = 1024 * 1024;
const PUBLICATION_PREFIX = "publication/";

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
function _resolveRequestPath(publicRoot, rawUrl) {
	const classified = classifyRequestPath(publicRoot, rawUrl);
	return classified === "bad" || classified === null ? classified : classified.target;
}

/** Same single-decode confinement, additionally exposing the slash-normalized relative path. */
function classifyRequestPath(publicRoot, rawUrl) {
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
	const relativePath = segments.join("/");
	const target = resolve(publicRoot, ...segments);
	if (target !== publicRoot && !target.startsWith(`${publicRoot}${sep}`)) return "bad";
	return { target, relativePath };
}

/**
 * Load the staged publication manifest (bounded metadata) and index its exact
 * payload paths. Only paths listed here may ever be served; everything else in
 * the publication namespace 404s without a filesystem probe. Returns an empty
 * map when no publication dataset is staged (synthetic demo stays unchanged).
 */
async function loadPublicationFiles(publicRoot, realRoot) {
	const manifestPath = resolve(publicRoot, `${PUBLICATION_PREFIX}manifest.json`);
	try {
		const info = await lstat(manifestPath);
		if (!info.isFile() || info.size === 0 || info.size > MAX_MANIFEST_BYTES) return new Map();
		const real = await realpath(manifestPath);
		if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) return new Map();
		const bytes = await readFile(manifestPath);
		const parsed = JSON.parse(bytes.toString("utf8"));
		if (
			parsed?.schemaVersion !== 1 ||
			!Array.isArray(parsed.files) ||
			typeof parsed.id !== "string"
		)
			return new Map();
		const files = new Map();
		for (const entry of parsed.files) {
			if (
				typeof entry?.path !== "string" ||
				typeof entry?.bytes !== "number" ||
				!Number.isSafeInteger(entry.bytes) ||
				entry.bytes < 0 ||
				typeof entry?.sha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test(entry.sha256)
			)
				return new Map();
			if (
				entry.path.startsWith("/") ||
				entry.path.includes("\\") ||
				entry.path
					.split("/")
					.some(
						(segment) =>
							segment === "" || segment === "." || segment === ".." || segment.startsWith("."),
					)
			)
				return new Map();
			if (files.has(entry.path)) return new Map();
			files.set(entry.path, { bytes: entry.bytes, sha256: entry.sha256 });
		}
		return files;
	} catch {
		return new Map();
	}
}

/**
 * Stream one allowlisted publication payload. The staged file must exist, stay
 * confined, be a regular file (O_NOFOLLOW), and match the manifest's declared
 * size exactly. The validated file descriptor is opened BEFORE any response
 * header is written, so a failure here still produces a clean error response;
 * bytes then stream from that descriptor so a ~300 MB dataset never sits in
 * memory. The manifest's content hash is the ETag and the cache policy is
 * no-cache: URLs are not content-addressed, so future data must revalidate.
 */
async function servePublicationFile(
	publicRoot,
	realRoot,
	relativePath,
	files,
	request,
	response,
	headOnly,
) {
	// Manifest paths are relative to the publication namespace root; the request path
	// carries the "publication/" prefix.
	const entry = files.get(relativePath.slice(PUBLICATION_PREFIX.length));
	if (!entry) return notFound(response, headOnly);
	const target = resolve(publicRoot, ...relativePath.split("/"));
	const finishHeaders = (extra) => {
		response.writeHead(200, {
			...securityHeaders(),
			"content-type": "application/octet-stream",
			"cache-control": "no-cache",
			etag: `"${entry.sha256}"`,
			"accept-ranges": "none",
			...extra,
		});
	};
	try {
		const info = await lstat(target);
		if (!info.isFile() || info.size !== entry.bytes) return notFound(response, headOnly);
		const real = await realpath(target);
		if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`))
			return notFound(response, headOnly);
		// Confined, symlink-free read handle validated before headers; stream failures
		// below can therefore only be transport problems, not validation problems.
		const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
		let handleAdopted = false;
		try {
			const opened = await handle.stat();
			if (!opened.isFile() || opened.size !== entry.bytes) return notFound(response, headOnly);
			if (headOnly) {
				finishHeaders({ "content-length": String(entry.bytes) });
				response.end();
				return;
			}
			if (request.headers["if-none-match"] === `"${entry.sha256}"`) {
				response.writeHead(304, {
					...securityHeaders(),
					etag: `"${entry.sha256}"`,
					"cache-control": "no-cache",
				});
				response.end();
				return;
			}
			finishHeaders({ "content-length": String(entry.bytes) });
			// Stream from the already-validated descriptor. The created stream owns the
			// handle via autoClose, which closes it at completion or destruction; the
			// outer finally must then not close it again. Early client disconnects are
			// transport outcomes, not server errors: the socket is destroyed, never a
			// second 500 write.
			const stream = handle.createReadStream({ autoClose: true });
			try {
				handleAdopted = true;
				await pipeline(stream, response);
			} finally {
				// If pipeline never ran (synchronous throw before adoption), close here.
				// Otherwise the stream has already destroyed/closed the descriptor.
				if (!handleAdopted) stream.destroy();
			}
		} finally {
			// The adopted stream closes the descriptor itself (autoClose); closing again
			// would throw EBADF. When the handle was never adopted, close it explicitly.
			if (!handleAdopted) await handle.close().catch(() => {});
		}
	} catch (error) {
		const transport =
			error?.code === "EPIPE" ||
			error?.code === "ECONNRESET" ||
			error?.code === "ERR_STREAM_PREMATURE_CLOSE" ||
			error?.name === "AbortError";
		if (transport) {
			response.destroy();
			return;
		}
		// Headers may already be committed by pipeline teardown; only report when safe.
		if (!response.headersSent && !response.destroyed) {
			plain(response, 500, "Internal error", headOnly);
		} else {
			response.destroy();
		}
	}
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

export async function createStaticServer(options = {}) {
	const publicRoot = resolve(options.publicRoot ?? resolve(HERE, "public"));
	const releasePath = resolve(options.releasePath ?? resolve(HERE, "release.json"));
	const packageRoot = dirname(publicRoot);
	// Confinement anchors are real paths; resolved lazily once per server. The release
	// manifest lives at the package root, outside public/, so it is confined there.
	const realPublicRoot = realpath(publicRoot).catch(() => publicRoot);
	const realPackageRoot = realpath(packageRoot).catch(() => packageRoot);
	// The publication allowlist is per instance; independent servers on different roots
	// never share listed payloads.
	const publicationFiles = await loadPublicationFiles(publicRoot, await realPublicRoot);
	const log = options.log === undefined ? (line) => console.log(line) : options.log;
	const demo = createDemoApi(options.demo ?? {});
	const server = createServer(async (request, response) => {
		const started = Date.now();
		const headOnly = request.method === "HEAD";
		const realRoot = await realPublicRoot;
		const packageRealRoot = await realPackageRoot;
		const finish = (status) => {
			log(`${request.method} ${truncateUrl(request.url)} -> ${status} ${Date.now() - started}ms`);
		};
		try {
			if (await demo(request, response)) return;
			if (request.method !== "GET" && request.method !== "HEAD") {
				plain(response, 405, "Method not allowed", headOnly, { allow: "GET, HEAD" });
				finish(405);
				return;
			}
			const classified = classifyRequestPath(publicRoot, request.url ?? "/");
			if (classified === "bad") {
				plain(response, 400, "Bad request", headOnly);
				finish(400);
				return;
			}
			if (classified === null) {
				notFound(response, headOnly);
				finish(404);
				return;
			}
			const { target, relativePath } = classified;
			// The publication namespace serves only manifest-listed payloads; the manifest
			// itself is metadata and never store-cached. Unknown publication paths 404
			// without touching the filesystem, and the generic MIME path never sees .fcs/.wsp.
			if (relativePath.startsWith(PUBLICATION_PREFIX)) {
				if (relativePath === `${PUBLICATION_PREFIX}manifest.json`) {
					await serveFromRoot(
						publicRoot,
						realRoot,
						resolve(publicRoot, `${PUBLICATION_PREFIX}manifest.json`),
						response,
						headOnly,
						"no-store",
					);
					finish(200);
					return;
				}
				await servePublicationFile(
					publicRoot,
					realRoot,
					relativePath,
					publicationFiles,
					request,
					response,
					headOnly,
				);
				finish(200);
				return;
			} // "/" maps to the staged index; release.json lives at the package root and is
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
			// The response may already be committed (e.g. a transport failure during a
			// publication stream); never attempt a second head/body write on that socket.
			if (!response.headersSent && !response.destroyed) {
				plain(response, 500, "Internal error", headOnly);
			} else if (!response.destroyed) {
				response.destroy();
			}
			finish(response.headersSent ? 200 : 500);
			log(`static server error: ${error instanceof Error ? error.message : "unknown"}`);
		}
	});
	server.on("close", () => demo.close());
	server.on("shutdown", () => demo.close());
	if (demo.speechEnabled) {
		const { attachSpeechRelay } = await import("./speech-relay.mjs");
		attachSpeechRelay(server, demo, options.demo ?? {});
	}
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
	const server = await createStaticServer();
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
			server.emit("shutdown");
			server.close(() => done());
		};
		process.on("SIGTERM", close);
		process.on("SIGINT", close);
	});
	await stopped;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
