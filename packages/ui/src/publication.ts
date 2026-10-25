export const PUBLICATION_EMBED_OPTIONS = Object.freeze({
	xdim: 20,
	ydim: 20,
	epochs: 10,
	trainMax: 100000,
	seed: 42,
});
const MAX_FILE = 64 * 2 ** 20;
const MAX_TOTAL = 512 * 2 ** 20;
const MAX_MANIFEST = 256 * 1024;
const WSP_SHA = "00796effe02b7a4702e136fe87132a975d06b5e65f1856a95732573e284ac70c";
const DOI = "10.3389/fimmu.2024.1425488";

export interface PublicationFile {
	path: string;
	name: string;
	kind: "wsp" | "fcs";
	bytes: number;
	sha256: string;
	events?: number;
	channels?: number;
}
export interface PublicationManifest {
	schemaVersion: 1;
	id: "flowatlas-publication-companion-v1";
	title: string;
	citation: { title: string; doi: string; url: string };
	sourceVersion: "local-companion-2026-10-25";
	sampleCount: number;
	eventCount: number;
	totalBytes: number;
	files: PublicationFile[];
	notes: string[];
}
export interface PublicationProgress {
	phase: "manifest" | "files";
	verifiedFiles: number;
	fileCount: number;
	downloadedBytes: number;
	totalBytes: number;
}
interface Options {
	baseUrl?: string;
	fetch?: typeof fetch;
	signal?: AbortSignal;
	onProgress?: (progress: PublicationProgress) => void;
}
function invalid(message: string): never {
	throw new Error(`Publication dataset: ${message}`);
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		invalid("invalid manifest object");
	return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 4096;
}
function fileEntry(value: unknown): PublicationFile {
	const entry = object(value);
	if (
		!text(entry.path) ||
		entry.path.length > 1024 ||
		/[\\:%?#]/.test(entry.path) ||
		Array.from(entry.path).some(
			(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		)
	)
		invalid("unsafe file path");
	const segments = entry.path.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === ".."))
		invalid("unsafe file path segment");
	if (entry.name !== segments.at(-1)) invalid("file name must equal its path basename");
	if (
		(entry.kind !== "wsp" && entry.kind !== "fcs") ||
		!entry.path.toLowerCase().endsWith(`.${entry.kind}`)
	)
		invalid("unexpected file extension/kind");
	if (!integer(entry.bytes, 1, MAX_FILE))
		invalid("file exceeds the 64 MiB bound or has invalid size");
	if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256))
		invalid("invalid SHA-256");
	if (entry.events !== undefined && !integer(entry.events, 0, 0xffffffff))
		invalid("invalid file event count");
	if (entry.channels !== undefined && !integer(entry.channels, 1, 4096))
		invalid("invalid file channel count");
	return {
		path: entry.path,
		name: entry.name as string,
		kind: entry.kind,
		bytes: entry.bytes,
		sha256: entry.sha256,
		...(entry.events === undefined ? {} : { events: entry.events as number }),
		...(entry.channels === undefined ? {} : { channels: entry.channels as number }),
	};
}
export function validatePublicationManifest(value: unknown): PublicationManifest {
	const manifest = object(value),
		citation = object(manifest.citation);
	if (
		manifest.schemaVersion !== 1 ||
		manifest.id !== "flowatlas-publication-companion-v1" ||
		manifest.sourceVersion !== "local-companion-2026-10-25"
	)
		invalid("unsupported manifest identity/version");
	if (
		!text(manifest.title) ||
		!text(citation.title) ||
		citation.doi !== DOI ||
		citation.url !== `https://doi.org/${DOI}`
	)
		invalid("unexpected citation/title");
	if (
		manifest.sampleCount !== 33 ||
		manifest.eventCount !== 3885530 ||
		manifest.totalBytes !== 295841667
	)
		invalid("companion sample/event/byte totals differ from the approved version");
	if (!Array.isArray(manifest.files) || manifest.files.length !== 34)
		invalid("expected 33 FCS files and one WSP");
	const files = manifest.files.map(fileEntry);
	if (new Set(files.map((file) => file.name.toLowerCase())).size !== files.length)
		invalid("duplicate file basenames");
	const workspaces = files.filter((file) => file.kind === "wsp"),
		fcs = files.filter((file) => file.kind === "fcs");
	if (
		workspaces.length !== 1 ||
		fcs.length !== 33 ||
		workspaces[0]?.path !== "workspace.wsp" ||
		workspaces[0]?.sha256 !== WSP_SHA
	)
		invalid("workspace identity or file counts differ");
	const total = files.reduce((sum, file) => sum + file.bytes, 0);
	if (total !== manifest.totalBytes || total > MAX_TOTAL)
		invalid("file byte totals differ or exceed 512 MiB");
	if (
		fcs.every((file) => file.events !== undefined) &&
		fcs.reduce((sum, file) => sum + (file.events as number), 0) !== manifest.eventCount
	)
		invalid("per-file event totals differ");
	if (!Array.isArray(manifest.notes) || manifest.notes.length > 32 || !manifest.notes.every(text))
		invalid("invalid manifest notes");
	return {
		schemaVersion: 1,
		id: "flowatlas-publication-companion-v1",
		sourceVersion: "local-companion-2026-10-25",
		title: manifest.title,
		citation: { title: citation.title, doi: DOI, url: `https://doi.org/${DOI}` },
		sampleCount: 33,
		eventCount: 3885530,
		totalBytes: total,
		files,
		notes: [...manifest.notes],
	};
}

function ownedAbort(signal?: AbortSignal) {
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	if (signal?.aborted) abort();
	else signal?.addEventListener("abort", abort, { once: true });
	return { controller, unlink: () => signal?.removeEventListener("abort", abort) };
}
async function readBounded(
	response: Response,
	limit: number,
	expected: number | null,
	signal: AbortSignal,
	progress: (bytes: number) => void,
): Promise<Uint8Array<ArrayBuffer>> {
	if (!response.body) invalid("response has no readable body");
	const reader = response.body.getReader();
	const abort = () => {
		void reader.cancel(signal.reason).catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	let received = 0;
	try {
		signal.throwIfAborted();
		if (!response.ok) invalid(`download failed (HTTP ${response.status})`);
		const header = response.headers.get("content-length");
		if (header !== null && (!/^\d+$/.test(header) || !integer(Number(header), 0, limit)))
			invalid("response Content-Length exceeds its byte bound");
		if (
			expected !== null &&
			header !== null &&
			!response.headers.get("content-encoding") &&
			Number(header) !== expected
		)
			invalid("response Content-Length differs from manifest");
		const bytes = new Uint8Array(expected ?? limit);
		for (;;) {
			const part = await reader.read();
			signal.throwIfAborted();
			if (part.done) break;
			if (part.value.byteLength > bytes.length - received)
				invalid("response exceeds its declared byte length");
			bytes.set(part.value, received);
			received += part.value.byteLength;
			progress(part.value.byteLength);
		}
		if (expected !== null && received !== expected)
			invalid("downloaded byte length differs from manifest");
		return expected === null ? bytes.slice(0, received) : bytes;
	} catch (error) {
		await reader.cancel(error).catch(() => {});
		throw error;
	} finally {
		signal.removeEventListener("abort", abort);
		reader.releaseLock();
	}
}
function baseUrl(base: string | undefined): URL {
	const url = new URL("./publication/", base ?? document.baseURI);
	if (url.protocol !== "https:" && url.protocol !== "http:")
		invalid("publication requires an HTTP(S) origin");
	return url;
}

/** Bounded transport primitive; UI entry calls it only after complete manifest validation.
 * Exported for tiny mocked transport tests, not an alternative dataset selector.
 */
export async function downloadPublicationFiles(
	manifest: Pick<PublicationManifest, "files" | "totalBytes">,
	options: Options = {},
): Promise<File[]> {
	const files = manifest.files.map(fileEntry);
	if (
		!files.length ||
		files.length > 128 ||
		new Set(files.map((file) => file.name.toLowerCase())).size !== files.length ||
		files.reduce((sum, file) => sum + file.bytes, 0) !== manifest.totalBytes ||
		manifest.totalBytes > MAX_TOTAL
	)
		invalid("invalid bounded download list");
	const base = baseUrl(options.baseUrl);
	const { controller, unlink } = ownedAbort(options.signal);
	const signal = controller.signal,
		fetcher = options.fetch ?? fetch;
	const result: File[] = new Array(files.length);
	let next = 0,
		verified = 0,
		downloaded = 0,
		failed = false,
		failure: unknown;
	const progress = () =>
		options.onProgress?.({
			phase: "files",
			verifiedFiles: verified,
			fileCount: files.length,
			downloadedBytes: downloaded,
			totalBytes: manifest.totalBytes,
		});
	const worker = async () => {
		try {
			while (next < files.length) {
				signal.throwIfAborted();
				const index = next++,
					file = files[index] as PublicationFile;
				const url = new URL(file.path.split("/").map(encodeURIComponent).join("/"), base);
				const response = await fetcher(url, {
					method: "GET",
					credentials: "omit",
					redirect: "error",
					signal,
				});
				const bytes = await readBounded(response, file.bytes, file.bytes, signal, (count) => {
					downloaded += count;
					progress();
				});
				const actual = Array.from(
					new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
					(byte) => byte.toString(16).padStart(2, "0"),
				).join("");
				signal.throwIfAborted();
				if (actual !== file.sha256) invalid(`SHA-256 mismatch for ${file.name}`);
				result[index] = new File([bytes.buffer], file.name, {
					type: file.kind === "wsp" ? "application/xml" : "application/octet-stream",
					lastModified: 0,
				});
				verified++;
				progress();
			}
		} catch (error) {
			if (!failed) {
				failed = true;
				failure = error;
			}
			controller.abort(error);
			throw error;
		}
	};
	try {
		signal.throwIfAborted();
		progress();
		await Promise.allSettled(Array.from({ length: Math.min(2, files.length) }, () => worker()));
		if (failed) throw failure;
		signal.throwIfAborted();
		return result;
	} finally {
		unlink();
	}
}

export async function loadPublicationDataset(
	options: Options = {},
): Promise<{ manifest: PublicationManifest; files: File[] }> {
	const { controller, unlink } = ownedAbort(options.signal);
	try {
		const signal = controller.signal;
		signal.throwIfAborted();
		options.onProgress?.({
			phase: "manifest",
			verifiedFiles: 0,
			fileCount: 0,
			downloadedBytes: 0,
			totalBytes: 0,
		});
		const response = await (options.fetch ?? fetch)(
			new URL("manifest.json", baseUrl(options.baseUrl)),
			{ method: "GET", credentials: "omit", redirect: "error", signal },
		);
		const bytes = await readBounded(response, MAX_MANIFEST, null, signal, () => {});
		const manifest = validatePublicationManifest(
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
		);
		const files = await downloadPublicationFiles(manifest, { ...options, signal });
		return { manifest, files };
	} catch (error) {
		controller.abort(error);
		throw error;
	} finally {
		unlink();
	}
}
