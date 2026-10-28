/**
 * Stage the Flow Atlas public demo deploy package into an owned destination.
 *
 * Node 24, zero external dependencies. Copies only allowlisted built UI assets
 * plus this directory's static server/package files; never the monorepo,
 * node_modules, caches, fixtures, oracle data or any private corpus. Verifies
 * the staged output (exact file set, sizes, hashes, no symlinks) and writes a
 * release.json bound to the real git HEAD.
 *
 * With --publication-root <path>, additionally stages the pinned publication
 * companion dataset (deploy/publication-manifest.json): every listed file is
 * verified by streaming SHA-256 against the manifest before copying, copied
 * verbatim under public/publication/, and recorded in release.json. Only the
 * manifest's exact payloads are copied; no unlisted file is ever staged. This
 * opt-in covers only the authorized publication dataset; generic assets keep
 * the small allowlist and reject .fcs/.wsp/oracle content outright.
 *
 * Usage:
 *   node deploy/prepare.mjs <destination> [--ui-dist <path>] [--build] [--revision <sha>]
 *                            [--publication-root <path>]
 *
 * The UI build is NOT run by default; pass --build to build packages/ui first
 * (single explicit build, avoiding double builds when the parent coordinates).
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFile,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const UI_DIST_DEFAULT = resolve(REPO_ROOT, "packages", "ui", "dist");
const PINNED_PUBLICATION_MANIFEST = resolve(HERE, "publication-manifest.json");
const SERVER_FILES = [
	"static-server.mjs",
	"demo-api.mjs",
	"demo-tools.mjs",
	"speech-relay.mjs",
	"package.json",
	"package-lock.json",
];

const ALLOWED_EXTENSIONS = new Set([
	".html",
	".js",
	".mjs",
	".css",
	".json",
	".map",
	".svg",
	".ico",
	".txt",
	".webmanifest",
]);
const FORBIDDEN_SEGMENTS = new Set(["fixtures", "oracle", "node_modules", ".cache", "data"]);
const FORBIDDEN_EXTENSIONS = new Set([".fcs", ".wsp", ".env"]);
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 2000;
// Explicit data budgets for the authorized publication namespace only.
const PUBLICATION_TOTAL_BYTES = 512 * 1024 * 1024;
const PUBLICATION_FILE_BYTES = 64 * 1024 * 1024;
const HASH_CHUNK = 1024 * 1024;

function fail(message) {
	console.error(`prepare: ${message}`);
	const error = new Error(message);
	error.prepared = true;
	throw error;
}

function parseArguments(argv) {
	const values = {
		uiDist: UI_DIST_DEFAULT,
		build: false,
		revision: undefined,
		destination: undefined,
		publicationRoot: undefined,
	};
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--build") values.build = true;
		else if (argument === "--ui-dist")
			values.uiDist = resolve(process.cwd(), argv[++index] ?? fail("--ui-dist requires a path"));
		else if (argument === "--revision")
			values.revision = argv[++index] ?? fail("--revision requires a sha");
		else if (argument === "--publication-root")
			values.publicationRoot = resolve(
				process.cwd(),
				argv[++index] ?? fail("--publication-root requires a path"),
			);
		else if (!argument.startsWith("--") && values.destination === undefined)
			values.destination = resolve(process.cwd(), argument);
		else fail(`unknown argument: ${argument}`);
	}
	if (!values.destination)
		fail(
			"usage: node deploy/prepare.mjs <destination> [--ui-dist <path>] [--build] [--revision <sha>] [--publication-root <path>]",
		);
	return values;
}

async function git(args) {
	const { stdout } = await run("git", args, { cwd: REPO_ROOT });
	return stdout.trim();
}

/** Walk a real directory tree, rejecting symlinks and anything outside the allowlist. */
async function collectFiles(root, prefix = "") {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		fail(`missing directory: ${root}`);
	}
	const files = [];
	for (const entry of entries) {
		const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isSymbolicLink()) fail(`symlink is not stageable: ${relativePath}`);
		if (entry.isDirectory()) {
			if (entry.name.startsWith(".") || FORBIDDEN_SEGMENTS.has(entry.name))
				fail(`forbidden directory: ${relativePath}`);
			files.push(...(await collectFiles(join(root, entry.name), relativePath)));
			continue;
		}
		if (!entry.isFile()) fail(`unsupported entry: ${relativePath}`);
		if (entry.name.startsWith(".")) fail(`dotfile is not stageable: ${relativePath}`);
		if (FORBIDDEN_EXTENSIONS.has(extname(entry.name).toLowerCase()))
			fail(`forbidden file extension: ${relativePath}`);
		if (
			FORBIDDEN_SEGMENTS.has(entry.name.replace(/\.[^.]+$/, "")) ||
			/\.(fcs|wsp)$/i.test(entry.name)
		)
			fail(`forbidden file: ${relativePath}`);
		const extension = extname(entry.name).toLowerCase();
		if (!ALLOWED_EXTENSIONS.has(extension))
			fail(`extension ${extension || "(none)"} is not allowlisted: ${relativePath}`);
		const info = await stat(join(root, entry.name));
		if (info.size > MAX_FILE_BYTES) fail(`file exceeds ${MAX_FILE_BYTES} bytes: ${relativePath}`);
		files.push({ relativePath, source: join(root, entry.name), bytes: info.size });
	}
	return files;
}

async function sha256Streaming(handle, size, label) {
	const hash = createHash("sha256");
	const buffer = Buffer.alloc(HASH_CHUNK);
	let offset = 0;
	while (offset < size) {
		const { bytesRead } = await handle.read(
			buffer,
			0,
			Math.min(buffer.length, size - offset),
			offset,
		);
		if (!bytesRead) throw new Error(`short read at ${offset} of ${label}`);
		hash.update(buffer.subarray(0, bytesRead));
		offset += bytesRead;
	}
	return hash.digest("hex");
}

/**
 * Validate and stage the pinned publication dataset. The manifest argument is
 * metadata only; payload bytes come exclusively from publicationRoot. Every
 * listed file must match its declared size and streaming SHA-256, must be a
 * real file (no symlinks), and must stay inside publicationRoot. Only listed
 * payloads are copied, verbatim, to public/publication/<path>; the manifest is
 * staged alongside them as manifest.json. Returns the release descriptor.
 */
export async function stagePublication(options) {
	const { destination, publicationRoot, manifest, signal } = options;
	if (
		typeof manifest?.id !== "string" ||
		manifest?.schemaVersion !== 1 ||
		!Array.isArray(manifest.files)
	)
		fail("publication manifest is malformed");
	if (typeof publicationRoot !== "string") fail("publication root is required");
	const rootReal = await realpath(publicationRoot);
	const payloads = manifest.files.filter((entry) => entry.path !== "manifest.json");
	const declaredTotal = payloads.reduce((sum, entry) => sum + entry.bytes, 0);
	if (declaredTotal > PUBLICATION_TOTAL_BYTES)
		fail(`publication dataset exceeds ${PUBLICATION_TOTAL_BYTES} bytes`);
	// Verify every payload before copying anything: publication staging is all-or-nothing.
	const verified = [];
	for (const entry of payloads) {
		signal?.throwIfAborted();
		if (
			typeof entry.path !== "string" ||
			entry.path.startsWith("/") ||
			entry.path.includes("\\") ||
			entry.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
		)
			fail(`unusable publication path: ${JSON.stringify(entry.path)}`);
		if (typeof entry.bytes !== "number" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)
			fail(`unusable publication size: ${entry.path}`);
		if (entry.bytes > PUBLICATION_FILE_BYTES)
			fail(`publication file exceeds ${PUBLICATION_FILE_BYTES} bytes: ${entry.path}`);
		if (!/^[a-f0-9]{64}$/.test(entry.sha256 ?? ""))
			fail(`unusable publication hash: ${entry.path}`);
		const source = resolve(publicationRoot, ...entry.path.split("/"));
		if (!source.startsWith(`${publicationRoot}${sep}`) && source !== publicationRoot)
			fail(`publication payload escapes the publication root: ${entry.path}`);
		const info = await lstat(source).catch(() => null);
		if (!info?.isFile())
			fail(`publication payload is missing or not a regular file: ${entry.path}`);
		const sourceReal = await realpath(source).catch(() => null);
		if (!sourceReal || (sourceReal !== rootReal && !sourceReal.startsWith(`${rootReal}${sep}`)))
			fail(`publication payload escapes the publication root: ${entry.path}`);
		if (info.size !== entry.bytes)
			fail(
				`publication size mismatch for ${entry.path}: manifest ${entry.bytes}, disk ${info.size}`,
			);
		const handle = await open(source, "r");
		try {
			const before = await handle.stat();
			const sha256 = await sha256Streaming(handle, entry.bytes, entry.path);
			const after = await handle.stat();
			if (
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ino !== after.ino
			)
				fail(`publication source changed while reading: ${entry.path}`);
			if (sha256 !== entry.sha256)
				fail(
					`publication hash mismatch for ${entry.path}: manifest ${entry.sha256.slice(0, 12)}…, disk ${sha256.slice(0, 12)}…`,
				);
		} finally {
			await handle.close();
		}
		verified.push(entry);
	}
	// Copy the verified payloads verbatim, then stage the manifest bytes alongside them.
	const publicationRootDestination = join(destination, "public", "publication");
	await mkdir(publicationRootDestination, { recursive: true, mode: 0o700 });
	for (const entry of verified) {
		const target = join(publicationRootDestination, ...entry.path.split("/"));
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		// Copy through confined descriptors: the source is opened before the copy and
		// identity-checked after it, so a concurrently swapped source aborts staging.
		const sourceHandle = await open(resolve(publicationRoot, ...entry.path.split("/")), "r");
		let sourceStream = null;
		try {
			const before = await sourceHandle.stat();
			const targetHandle = await open(target, "w", 0o600);
			try {
				sourceStream = sourceHandle.createReadStream({ autoClose: false });
				await pipeline(sourceStream, targetHandle.createWriteStream());
			} finally {
				await targetHandle.close();
			}
			const after = await sourceHandle.stat();
			if (
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ino !== after.ino
			)
				fail(`publication source changed while copying: ${entry.path}`);
		} finally {
			// The copy stream must not outlive the descriptor; destroy any partial stream
			// before closing the handle it was created from.
			if (sourceStream && !sourceStream.destroyed) sourceStream.destroy();
			await sourceHandle.close();
		}
	}
	// Stage the manifest itself, byte-verbatim, and hash those staged bytes.
	const manifestBytes =
		options.manifestBytes ?? Buffer.from(`${JSON.stringify(manifest, null, "\t")}\n`);
	await writeFile(join(publicationRootDestination, "manifest.json"), manifestBytes, {
		mode: 0o600,
	});
	// TOCTOU closure: the bytes now staged under the pinned namespace must match the
	// pinned manifest exactly. Any concurrent source swap that survived the per-copy
	// checks is caught here before staging is declared successful.
	for (const entry of verified) {
		signal?.throwIfAborted();
		const target = join(publicationRootDestination, ...entry.path.split("/"));
		const handle = await open(target, "r");
		try {
			const info = await handle.stat();
			if (info.size !== entry.bytes)
				fail(
					`staged publication size mismatch for ${entry.path}: manifest ${entry.bytes}, staged ${info.size}`,
				);
			const sha256 = await sha256Streaming(handle, entry.bytes, `staged ${entry.path}`);
			if (sha256 !== entry.sha256)
				fail(
					`staged publication hash mismatch for ${entry.path}: manifest ${entry.sha256.slice(0, 12)}…, staged ${sha256.slice(0, 12)}…`,
				);
		} finally {
			await handle.close();
		}
	}
	return {
		id: manifest.id,
		manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
		fileCount: payloads.length,
		bytes: declaredTotal,
		staged: verified.map((entry) => entry.path),
	};
}

/** Stage the complete deploy package; `publicationManifest` is a test-only manifest override. */
export async function stageDemoPackage(options) {
	const destination = resolve(options.destination);
	const uiDist = resolve(options.uiDist ?? UI_DIST_DEFAULT);
	const signal = options.signal;
	const existing = await lstat(destination).then(
		() => true,
		() => false,
	);
	if (existing) {
		const leftovers = await readdir(destination);
		if (leftovers.length) fail(`destination is not empty: ${destination}`);
	} else {
		await mkdir(destination, { recursive: true, mode: 0o700 });
	}
	const gitSha = await git(["rev-parse", "HEAD"]).catch(() =>
		fail("git HEAD is unavailable; refusing to fabricate a revision"),
	);
	if (!/^[a-f0-9]{40}$/.test(gitSha)) fail(`unexpected git HEAD format: ${gitSha.slice(0, 12)}…`);
	if (options.revision !== undefined && options.revision !== gitSha)
		fail(`--revision ${options.revision} does not match git HEAD ${gitSha}`);
	const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "unknown");
	const status = await git(["status", "--porcelain"]).catch(() => "");
	const dirty = status.trim().length > 0;

	if (options.build) {
		console.log("prepare: building @flow-atlas/ui (explicit --build)");
		await run("pnpm", ["--filter", "@flow-atlas/ui", "run", "build"], {
			cwd: REPO_ROOT,
			env: { ...process.env },
			stdio: "inherit",
		});
	}

	const staged = await collectFiles(uiDist);
	if (!staged.some((file) => file.relativePath === "index.html"))
		fail("built UI dist does not contain index.html");
	const totalBytes = staged.reduce((sum, file) => sum + file.bytes, 0);
	if (staged.length > MAX_FILES) fail(`too many UI files: ${staged.length}`);
	if (totalBytes > MAX_TOTAL_BYTES) fail(`UI dist exceeds ${MAX_TOTAL_BYTES} bytes`);

	const publicRoot = join(destination, "public");
	await mkdir(publicRoot, { recursive: true, mode: 0o700 });
	for (const file of staged) {
		const target = join(publicRoot, ...file.relativePath.split("/"));
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		await copyFile(file.source, target);
	}
	for (const name of SERVER_FILES) {
		const source = join(HERE, name);
		const present = await lstat(source).then(
			() => true,
			() => false,
		);
		if (present) await copyFile(source, join(destination, name));
	}
	if (
		!(await lstat(join(destination, "static-server.mjs")).then(
			() => true,
			() => false,
		))
	)
		fail("static-server.mjs was not staged");

	// Publication dataset: opt-in, pinned manifest, verified payload by payload.
	let publication;
	if (options.publicationRoot !== undefined) {
		const manifestBytes = options.publicationManifest
			? Buffer.from(`${JSON.stringify(options.publicationManifest, null, "\t")}\n`)
			: await readFile(PINNED_PUBLICATION_MANIFEST);
		const manifest = JSON.parse(manifestBytes.toString("utf8"));
		publication = await stagePublication({
			destination,
			publicationRoot: options.publicationRoot,
			manifest,
			manifestBytes,
			signal,
		});
		console.log(
			`prepare: publication ${publication.id}: ${publication.fileCount} verified payloads, ${publication.bytes} bytes`,
		);
	}

	// Manifest everything except release.json itself, then re-verify the staged bytes.
	const assets = [];
	const listed = [
		...staged.map((file) => `public/${file.relativePath}`),
		...(await asyncFilter(SERVER_FILES, async (name) => exists(join(destination, name)))),
	];
	if (publication) {
		for (const path of publication.staged) listed.push(`public/publication/${path}`);
		listed.push("public/publication/manifest.json");
	}
	for (const relativePath of listed) {
		const info = await stat(join(destination, relativePath));
		const handle = await open(join(destination, relativePath), "r");
		try {
			assets.push({
				path: relativePath,
				bytes: info.size,
				sha256: await sha256Streaming(handle, info.size, relativePath),
			});
		} finally {
			await handle.close();
		}
	}
	const release = {
		schemaVersion: 1,
		source: { gitSha, branch, dirty },
		generatedAt: new Date().toISOString(),
		uiDist: relative(REPO_ROOT, uiDist).split(sep).join("/"),
		...(publication
			? {
					publication: {
						id: publication.id,
						manifestSha256: publication.manifestSha256,
						fileCount: publication.fileCount,
						bytes: publication.bytes,
					},
				}
			: {}),
		assets,
	};
	await writeFile(join(destination, "release.json"), `${JSON.stringify(release, null, "\t")}\n`, {
		mode: 0o600,
	});

	// Final verification walk: exact expected set, no symlinks, streamed sizes and hashes.
	const expected = new Set([...assets.map((asset) => asset.path), "release.json"]);
	const verified = [];
	let verifiedBytes = 0;
	async function walk(current, prefix = "") {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			if (entry.isSymbolicLink()) fail(`staged symlink detected: ${prefix}${entry.name}`);
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(join(current, entry.name), relativePath);
				continue;
			}
			if (!expected.has(relativePath)) fail(`unexpected staged file: ${relativePath}`);
			const info = await stat(join(current, entry.name));
			const handle = await open(join(current, entry.name), "r");
			try {
				const sha256 = await sha256Streaming(handle, info.size, relativePath);
				const asset = assets.find((candidate) => candidate.path === relativePath);
				if (asset && (asset.bytes !== info.size || asset.sha256 !== sha256))
					fail(`staged content mismatch: ${relativePath}`);
			} finally {
				await handle.close();
			}
			verified.push(relativePath);
			verifiedBytes += info.size;
		}
	}
	await walk(destination);
	if (verified.length !== expected.size) fail("staged file set does not match the manifest");

	for (const entry of verified) console.log(`staged ${entry}`);
	console.log(
		`prepare: ${verified.length} files, ${verifiedBytes} bytes, git HEAD ${gitSha.slice(0, 12)} (${dirty ? "dirty" : "clean"}), manifest release.json`,
	);
	return { release, verified };
}

async function exists(path) {
	return lstat(path).then(
		() => true,
		() => false,
	);
}
async function asyncFilter(values, predicate) {
	const keep = await Promise.all(
		values.map(async (value) => ((await predicate(value)) ? value : null)),
	);
	return keep.filter((value) => value !== null);
}

async function main() {
	const values = parseArguments(process.argv.slice(2));
	try {
		await stageDemoPackage(values);
	} catch (error) {
		// fail() already reported its specific message; anything else is unexpected.
		if (!error?.prepared) {
			console.error(`prepare: ${error instanceof Error ? error.message : "unknown failure"}`);
		}
		process.exitCode = 1;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
