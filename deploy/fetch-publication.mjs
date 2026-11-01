import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

async function realDirectory(path) {
	await mkdir(path, { recursive: true });
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink())
		throw new Error(`Not a real directory: ${path}`);
}

async function matches(file, expected) {
	try {
		const info = await lstat(file);
		if (info.isSymbolicLink() || !info.isFile())
			throw new Error(`Not a regular cache file: ${file}`);
		if (info.size !== expected.bytes) return false;
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(file)) hash.update(chunk);
		return hash.digest("hex") === expected.sha256;
	} catch (error) {
		if (error.code === "ENOENT") return false;
		throw error;
	}
}

/** Restore only immutable, already-public manifest payloads; never read the private oracle. */
export async function fetchPublication(
	manifest,
	destination,
	baseURL = "https://flow.gszep.com/publication/",
) {
	const root = resolve(destination);
	const seen = new Set();
	for (const file of manifest.files) {
		if (
			!file.path ||
			file.path.includes("\\") ||
			file.path.split("/").some((part) => !part || part === "." || part === "..") ||
			!Number.isSafeInteger(file.bytes) ||
			file.bytes < 1 ||
			file.bytes > 64 * 1024 * 1024 ||
			!/^[a-f0-9]{64}$/.test(file.sha256) ||
			seen.has(file.path)
		)
			throw new Error("Invalid publication manifest entry");
		seen.add(file.path);
	}
	await realDirectory(root);
	let next = 0;
	let downloaded = 0;
	await Promise.all(
		Array.from({ length: Math.min(4, manifest.files.length) }, async () => {
			while (next < manifest.files.length) {
				const expected = manifest.files[next++];
				const parts = expected.path.split("/");
				let parent = root;
				for (const part of parts.slice(0, -1)) {
					parent = join(parent, part);
					await realDirectory(parent);
				}
				const target = join(root, expected.path);
				if (await matches(target, expected)) continue;
				const temporary = `${target}.${randomUUID()}.partial`;
				try {
					const url = new URL(parts.map(encodeURIComponent).join("/"), baseURL);
					const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
					if (!response.ok || !response.body)
						throw new Error(`Publication download failed: ${expected.path} (${response.status})`);
					const hash = createHash("sha256");
					let size = 0;
					await pipeline(
						Readable.fromWeb(response.body),
						async function* (source) {
							for await (const chunk of source) {
								size += chunk.length;
								if (size > expected.bytes)
									throw new Error(`Publication size mismatch: ${expected.path}`);
								hash.update(chunk);
								yield chunk;
							}
							if (size !== expected.bytes || hash.digest("hex") !== expected.sha256)
								throw new Error(`Publication hash/size mismatch: ${expected.path}`);
						},
						createWriteStream(temporary, { flags: "wx" }),
					);
					await rename(temporary, target);
					downloaded++;
				} finally {
					await rm(temporary, { force: true });
				}
			}
		}),
	);
	return { files: manifest.files.length, downloaded };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (!process.argv[2])
		throw new Error("usage: node deploy/fetch-publication.mjs <owned-cache-directory>");
	const manifest = JSON.parse(
		await readFile(new URL("./publication-manifest.json", import.meta.url), "utf8"),
	);
	console.log(JSON.stringify(await fetchPublication(manifest, process.argv[2])));
}
