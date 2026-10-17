import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { link, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { FcsByteSource } from "@flow-atlas/fcs";
import { AnalysisError } from "./contracts.js";

const COPY_BYTES = 1024 * 1024;
// Nonblocking admission prevents special files from hanging before fstat can reject them.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export const isDigest = (value: string): boolean => /^[a-f0-9]{64}$/.test(value);

export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

export const digest = (value: unknown): string =>
	createHash("sha256").update(canonical(value)).digest("hex");

function inside(root: string, path: string): boolean {
	const r = relative(root, path);
	return r === "" || (!isAbsolute(r) && r !== ".." && !r.startsWith(`..${sep}`));
}

async function openRegular(path: string, root?: string) {
	const resolved = await realpath(path);
	if (root !== undefined && !inside(root, resolved))
		throw new AnalysisError("PATH_OUTSIDE_ROOT", "File path escapes the workspace");
	const handle = await open(resolved, READ_FLAGS);
	try {
		const info = await handle.stat();
		if (!info.isFile() || !Number.isSafeInteger(info.size))
			throw new AnalysisError("INVALID_FILE", "Expected a regular file with a safe byte length");
		const checkPath = async () => {
			const current = await realpath(path);
			if (root !== undefined && !inside(root, current))
				throw new AnalysisError("PATH_OUTSIDE_ROOT", "File path escapes the workspace");
			const currentInfo = await stat(current);
			if (current !== resolved || currentInfo.dev !== info.dev || currentInfo.ino !== info.ino)
				throw new AnalysisError("INPUT_CHANGED", "File path changed while being opened or read");
		};
		await checkPath();
		return { handle, info, checkPath };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

export async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
		if (bytesWritten === 0) throw new AnalysisError("IO_ERROR", "Output write made no progress");
		offset += bytesWritten;
	}
}

export async function hashFile(path: string, signal?: AbortSignal, root?: string): Promise<string> {
	const { handle, checkPath } = await openRegular(path, root);
	try {
		const hash = createHash("sha256");
		const buffer = Buffer.alloc(COPY_BYTES);
		for (;;) {
			signal?.throwIfAborted();
			const { bytesRead } = await handle.read(buffer);
			if (!bytesRead) {
				await checkPath();
				return hash.digest("hex");
			}
			hash.update(buffer.subarray(0, bytesRead));
		}
	} finally {
		await handle.close();
	}
}

export async function fileSource(
	path: string,
	root?: string,
): Promise<{
	source: FcsByteSource;
	identity: string;
	verify(expected: string, signal?: AbortSignal): Promise<void>;
	assertUnchanged(): Promise<void>;
	close(): Promise<void>;
}> {
	const { handle, info, checkPath } = await openRegular(path, root);
	try {
		const fingerprint = (value: typeof info) =>
			`${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
		const identity = fingerprint(info);
		const assertUnchanged = async () => {
			await checkPath();
			if (fingerprint(await handle.stat()) !== identity)
				throw new AnalysisError("INPUT_CHANGED", "Input artifact changed while being read");
		};
		return {
			identity,
			assertUnchanged,
			async verify(expected, signal) {
				const hash = createHash("sha256"),
					buffer = Buffer.alloc(COPY_BYTES);
				let offset = 0;
				while (offset < info.size) {
					signal?.throwIfAborted();
					const { bytesRead } = await handle.read(
						buffer,
						0,
						Math.min(buffer.length, info.size - offset),
						offset,
					);
					if (!bytesRead) throw new AnalysisError("INPUT_CHANGED", "Input artifact was truncated");
					hash.update(buffer.subarray(0, bytesRead));
					offset += bytesRead;
				}
				await assertUnchanged();
				if (hash.digest("hex") !== expected)
					throw new AnalysisError(
						"INTEGRITY_ERROR",
						"Input artifact no longer matches its content hash",
					);
			},
			source: {
				size: info.size,
				async read(offset, length) {
					if (
						!Number.isSafeInteger(offset) ||
						!Number.isSafeInteger(length) ||
						offset < 0 ||
						length < 0 ||
						length > 128 * 2 ** 20 ||
						offset + length > info.size
					) {
						throw new AnalysisError("INVALID_RANGE", "Invalid or oversized file read");
					}
					const result = new Uint8Array(length);
					let done = 0;
					while (done < length) {
						const { bytesRead } = await handle.read(result, done, length - done, offset + done);
						if (!bytesRead)
							throw new AnalysisError("INPUT_CHANGED", "File became shorter while reading");
						done += bytesRead;
					}
					return result;
				},
			},
			close: () => handle.close(),
		};
	} catch (error) {
		await handle.close();
		throw error;
	}
}

export class ArtifactStore {
	private constructor(
		readonly root: string,
		readonly inputs: string,
		readonly temporary: string,
		readonly outputs: string,
		readonly runs: string,
	) {}

	static async create(directory: string): Promise<ArtifactStore> {
		const root = await realpath(directory);
		if (!(await stat(root)).isDirectory())
			throw new AnalysisError("INVALID_ROOT", "Workspace root must be a directory");
		const ensure = async (path: string) => {
			await mkdir(path, { recursive: true, mode: 0o700 });
			const resolved = await realpath(path);
			if (!inside(root, resolved))
				throw new AnalysisError("PATH_OUTSIDE_ROOT", "Storage directory escapes the workspace");
			return resolved;
		};
		const managed = await ensure(join(root, ".flow-atlas"));
		return new ArtifactStore(
			root,
			await ensure(join(managed, "inputs")),
			await ensure(join(managed, "tmp")),
			await ensure(join(root, "outputs")),
			await ensure(join(managed, "runs")),
		);
	}

	relative(path: string): string {
		return relative(this.root, path).split(sep).join("/");
	}

	inputPath(sha256: string): string {
		if (!isDigest(sha256))
			throw new AnalysisError("INVALID_SAMPLE_ID", "Sample ID must be a SHA-256 digest");
		return join(this.inputs, `${sha256}.fcs`);
	}

	async snapshot(
		path: string,
		signal?: AbortSignal,
	): Promise<{ sha256: string; path: string; basename: string; size: number }> {
		if (isAbsolute(path))
			throw new AnalysisError("PATH_OUTSIDE_ROOT", "Input path must be relative to the workspace");
		const input = await realpath(join(this.root, path));
		if (!inside(this.root, input))
			throw new AnalysisError("PATH_OUTSIDE_ROOT", "Input path escapes the workspace");
		const { handle: source, info: before, checkPath } = await openRegular(input, this.root);
		const temp = join(this.temporary, `${randomUUID()}.input`);
		let target: FileHandle | undefined;
		try {
			target = await open(temp, "wx", 0o600);
			const hash = createHash("sha256");
			const buffer = Buffer.alloc(COPY_BYTES);
			let offset = 0;
			while (offset < before.size) {
				signal?.throwIfAborted();
				const { bytesRead } = await source.read(
					buffer,
					0,
					Math.min(buffer.length, before.size - offset),
					offset,
				);
				if (!bytesRead)
					throw new AnalysisError("INPUT_CHANGED", "Input was truncated during import");
				const chunk = buffer.subarray(0, bytesRead);
				hash.update(chunk);
				await writeAll(target, chunk);
				offset += bytesRead;
			}
			const after = await source.stat();
			await checkPath();
			if (
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs
			) {
				throw new AnalysisError(
					"INPUT_CHANGED",
					"Input changed during import; retry on a stable file",
				);
			}
			signal?.throwIfAborted();
			await target.sync();
			await target.chmod(0o400);
			await target.close();
			target = undefined;
			const sha256 = hash.digest("hex");
			const destination = this.inputPath(sha256);
			try {
				await link(temp, destination);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if ((await hashFile(destination, signal, this.root)) !== sha256)
					throw new AnalysisError(
						"INTEGRITY_ERROR",
						"Stored input does not match its content hash",
					);
			}
			return { sha256, path: destination, basename: basename(input), size: before.size };
		} finally {
			await source.close();
			await target?.close();
			await rm(temp, { force: true });
		}
	}

	async saveRun(id: string, record: unknown): Promise<void> {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new AnalysisError("INVALID_JOB_ID", "Invalid job ID");
		const temporary = join(this.temporary, `${randomUUID()}.json`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await writeAll(handle, Buffer.from(`${canonical(record)}\n`));
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, join(this.runs, `${id}.json`));
		} finally {
			await rm(temporary, { force: true });
		}
	}

	async readRun(id: string): Promise<unknown> {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new AnalysisError("INVALID_JOB_ID", "Invalid job ID");
		return this.readRecord(join(this.runs, `${id}.json`));
	}

	async readPublishedReceipt(id: string): Promise<unknown | null> {
		if (!/^[a-f0-9-]{36}$/.test(id)) throw new AnalysisError("INVALID_JOB_ID", "Invalid job ID");
		try {
			return await this.readRecord(join(this.outputs, id, "receipt.json"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	private async readRecord(path: string): Promise<unknown> {
		const { handle, info, checkPath } = await openRegular(path, this.root);
		try {
			const size = info.size;
			if (size > 1024 * 1024)
				throw new AnalysisError("INVALID_RECEIPT", "Run record exceeds size bound");
			const bytes = Buffer.alloc(size);
			let offset = 0;
			while (offset < size) {
				const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
				if (!bytesRead) throw new AnalysisError("INVALID_RECEIPT", "Run record was truncated");
				offset += bytesRead;
			}
			await checkPath();
			return JSON.parse(bytes.toString("utf8")) as unknown;
		} finally {
			await handle.close();
		}
	}
}
