/**
 * Stage the Flow Atlas public demo deploy package into an owned destination.
 *
 * Node 24, zero external dependencies. Copies only allowlisted built UI assets
 * plus this directory's static server/package files; never the monorepo,
 * node_modules, caches, fixtures, oracle data or any private corpus. Verifies
 * the staged output (exact file set, sizes, hashes, no symlinks) and writes a
 * release.json bound to the real git HEAD.
 *
 * Usage:
 *   node deploy/prepare.mjs <destination> [--ui-dist <path>] [--build] [--revision <sha>]
 *
 * The UI build is NOT run by default; pass --build to build packages/ui first
 * (single explicit build, avoiding double builds when the parent coordinates).
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const UI_DIST_DEFAULT = resolve(REPO_ROOT, "packages", "ui", "dist");
const SERVER_FILES = ["static-server.mjs", "package.json", "package-lock.json"];

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

function fail(message) {
	console.error(`prepare: ${message}`);
	process.exitCode = 1;
	throw new Error(message);
}

function parseArguments(argv) {
	const values = {
		uiDist: UI_DIST_DEFAULT,
		build: false,
		revision: undefined,
		destination: undefined,
	};
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--build") values.build = true;
		else if (argument === "--ui-dist")
			values.uiDist = resolve(process.cwd(), argv[++index] ?? fail("--ui-dist requires a path"));
		else if (argument === "--revision")
			values.revision = argv[++index] ?? fail("--revision requires a sha");
		else if (!argument.startsWith("--") && values.destination === undefined)
			values.destination = resolve(process.cwd(), argument);
		else fail(`unknown argument: ${argument}`);
	}
	if (!values.destination)
		fail(
			"usage: node deploy/prepare.mjs <destination> [--ui-dist <path>] [--build] [--revision <sha>]",
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

async function sha256File(path) {
	const bytes = await readFile(path);
	return createHash("sha256").update(bytes).digest("hex");
}

const values = parseArguments(process.argv.slice(2));
const destination = values.destination;

// The destination must be a fresh owned location; never clobber existing content.
{
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
}

const gitSha = await git(["rev-parse", "HEAD"]).catch(() =>
	fail("git HEAD is unavailable; refusing to fabricate a revision"),
);
if (!/^[a-f0-9]{40}$/.test(gitSha)) fail(`unexpected git HEAD format: ${gitSha.slice(0, 12)}…`);
if (values.revision !== undefined && values.revision !== gitSha)
	fail(`--revision ${values.revision} does not match git HEAD ${gitSha}`);
const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "unknown");
const status = await git(["status", "--porcelain"]).catch(() => "");
const dirty = status.trim().length > 0;

if (values.build) {
	console.log("prepare: building @flow-atlas/ui (explicit --build)");
	await run("pnpm", ["--filter", "@flow-atlas/ui", "run", "build"], {
		cwd: REPO_ROOT,
		env: { ...process.env },
		stdio: "inherit",
	});
}

const staged = await collectFiles(values.uiDist);
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

// Manifest everything except release.json itself, then re-verify the staged bytes.
const assets = [];
for (const relativePath of [
	...staged.map((file) => `public/${file.relativePath}`),
	...(await asyncFilter(SERVER_FILES, async (name) => exists(join(destination, name)))),
]) {
	const bytes = (await stat(join(destination, relativePath))).size;
	assets.push({
		path: relativePath,
		bytes,
		sha256: await sha256File(join(destination, relativePath)),
	});
}
const release = {
	schemaVersion: 1,
	source: { gitSha, branch, dirty },
	generatedAt: new Date().toISOString(),
	uiDist: relative(REPO_ROOT, values.uiDist).split(sep).join("/"),
	assets,
};
await writeFile(join(destination, "release.json"), `${JSON.stringify(release, null, "\t")}\n`, {
	mode: 0o600,
});

// Final verification walk: exact expected set, no symlinks, sizes and hashes intact.
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
		const bytes = await readFile(join(current, entry.name));
		const asset = assets.find((candidate) => candidate.path === relativePath);
		if (
			asset &&
			(asset.bytes !== bytes.byteLength ||
				asset.sha256 !== createHash("sha256").update(bytes).digest("hex"))
		)
			fail(`staged content mismatch: ${relativePath}`);
		verified.push(relativePath);
		verifiedBytes += bytes.byteLength;
	}
}
await walk(destination);
if (verified.length !== expected.size) fail("staged file set does not match the manifest");

for (const entry of verified) console.log(`staged ${entry}`);
console.log(
	`prepare: ${verified.length} files, ${verifiedBytes} bytes, git HEAD ${gitSha.slice(0, 12)} (${dirty ? "dirty" : "clean"}), manifest release.json`,
);

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
