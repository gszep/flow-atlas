import {
	dataLayout,
	decodeData,
	FcsError,
	type FcsFile,
	parseChannels,
	parseSpill,
	parseText,
	readHeader,
} from "./index.js";

const METADATA_LIMIT = 16 * 1024 * 1024;
const CHUNK_LIMIT = 128 * 1024 * 1024;
const DEFAULT_CHUNK = 1024 * 1024;

export interface FcsByteSource {
	size: number;
	/** Return exactly length bytes. The reader rejects short/oversized responses. */
	read(offset: number, length: number): Promise<Uint8Array>;
}

export interface FcsChunkOptions {
	chunkEvents?: number;
	signal?: AbortSignal;
	startEvent?: number;
	eventCount?: number;
}

export interface FcsChunk {
	/** Absolute zero-based event offset, including when a subset is requested. */
	start: number;
	count: number;
	data: Float32Array;
}

export interface OpenFcsOptions {
	signal?: AbortSignal;
	/** Strict UTF-8 by default; latin1 is an explicit legacy Windows-1252 opt-in. */
	textEncoding?: "utf-8" | "latin1";
}

export interface FcsReader {
	readonly metadata: Omit<FcsFile, "data">;
	/** $TOT must exactly match DATA byte extent; no truncation/clamping. Reads still verify length. */
	readonly countPolicy: "exact-declared";
	chunks(options?: FcsChunkOptions): AsyncIterable<FcsChunk>;
}

export interface WriteFcsOptions {
	/** Maximum emitted byte-array length, including header/TEXT; 4..128 MiB. Default 1 MiB. */
	chunkBytes?: number;
	signal?: AbortSignal;
}

function integer(value: number, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw new FcsError(`${name} must be a safe integer in [${min}, ${max}]`);
	return value;
}

function keyword(kw: Record<string, string>, name: string, fallback?: number): number {
	const value = kw[name];
	if (value === undefined && fallback !== undefined) return fallback;
	if (value === undefined || !/^\d+$/.test(value.trim()))
		throw new FcsError(`invalid or missing ${name}`);
	return integer(Number(value), name);
}

function cancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new FcsError("FCS operation aborted");
}

function extent(start: number, length: number, size: number, label: string): void {
	integer(start, `${label} offset`);
	integer(length, `${label} length`);
	integer(start + length, `${label} end`);
	if (start + length > size) throw new FcsError(`${label} extends past end of source`);
}

export function blobSource(blob: Blob): FcsByteSource {
	return {
		size: blob.size,
		async read(offset, length) {
			extent(offset, length, blob.size, "Blob read");
			return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
		},
	};
}

/** Bounded random access. The source is borrowed; it must remain stable until consumption finishes. */
export async function openFcs(
	source: FcsByteSource,
	options: OpenFcsOptions = {},
): Promise<FcsReader> {
	const size = integer(source.size, "source size", 58);
	async function read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
		cancelled(options.signal);
		cancelled(signal);
		extent(offset, length, size, "read");
		const bytes = await source.read(offset, length);
		cancelled(options.signal);
		cancelled(signal);
		if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length)
			throw new FcsError(`source read length mismatch at ${offset}: expected ${length}`);
		return bytes;
	}
	const headerBytes = await read(0, 58);
	// Buffer.slice() is a borrowed view, unlike Uint8Array.slice(); copy the exact
	// returned bytes so pooled Buffer sources cannot expose an unrelated prefix.
	const h = readHeader(new Uint8Array(headerBytes).buffer);
	if (!["FCS2.0", "FCS3.0", "FCS3.1"].includes(h.version))
		throw new FcsError(`unsupported FCS version ${h.version}`);
	let metadataBytes = 0;
	async function text(start: number, end: number): Promise<Record<string, string>> {
		integer(start, "TEXT start", 58);
		integer(end, "TEXT end", start);
		metadataBytes += end - start + 1;
		if (metadataBytes > METADATA_LIMIT) throw new FcsError("combined TEXT exceeds 16 MiB limit");
		return parseText(await read(start, end - start + 1), options.textEncoding);
	}
	const kw = await text(h.textStart, h.textEnd);
	const ss = keyword(kw, "$BEGINSTEXT", 0);
	const se = keyword(kw, "$ENDSTEXT", 0);
	if (ss !== 0 || se !== 0) {
		if (ss <= h.textEnd && se >= h.textStart) throw new FcsError("overlapping TEXT segments");
		const supplement = await text(ss, se);
		for (const [key, value] of Object.entries(supplement)) if (!(key in kw)) kw[key] = value;
	}
	if (keyword(kw, "$NEXTDATA", 0) !== 0)
		throw new FcsError("multiple FCS datasets are unsupported");
	if ((kw.$MODE ?? "L") !== "L") throw new FcsError("only list-mode FCS is supported");
	const channels = parseChannels(kw);
	const count = keyword(kw, "$TOT");
	const datatype = kw.$DATATYPE ?? "F";
	const byteord = kw.$BYTEORD ?? "1,2,3,4";
	const rowBytes = integer(dataLayout(channels, datatype, byteord), "row bytes", 1, CHUNK_LIMIT);
	const dataBytes = integer(rowBytes * count, "DATA byte count");
	integer(channels.length * count, "decoded value count");
	const begin = keyword(kw, "$BEGINDATA", h.dataStart);
	const end = keyword(kw, "$ENDDATA", h.dataEnd);
	const ds = h.dataStart || begin;
	const de = h.dataEnd || end;
	if ((h.dataStart && begin && h.dataStart !== begin) || (h.dataEnd && end && h.dataEnd !== end))
		throw new FcsError("conflicting HEADER/TEXT DATA offsets");
	if (count === 0) {
		// Deliberate empty-file convention: both DATA offsets zero, no DATA bytes.
		if (ds !== 0 || de !== 0) throw new FcsError("zero-event FCS requires zero DATA offsets");
	} else {
		integer(ds, "DATA start", 58);
		integer(de, "DATA end", ds);
		if (de - ds + 1 !== dataBytes)
			throw new FcsError("DATA length does not match declared $TOT / row size");
		extent(ds, dataBytes, size, "DATA");
		if ((ds <= h.textEnd && de >= h.textStart) || (ss > 0 && ds <= se && de >= ss))
			throw new FcsError("DATA overlaps TEXT");
	}
	const spill = parseSpill(kw);
	const metadata: Omit<FcsFile, "data"> = {
		version: h.version,
		keywords: kw,
		channels,
		eventCount: count,
	};
	if (spill) metadata.spill = spill;
	// Keep decoding independent of mutations to inspectable metadata made by downstream clients.
	const decodingChannels = channels.map((c) => ({ ...c }));
	const maxEvents = Math.floor(CHUNK_LIMIT / (rowBytes + channels.length * 4));
	return {
		metadata,
		countPolicy: "exact-declared",
		async *chunks(opts = {}) {
			cancelled(options.signal);
			cancelled(opts.signal);
			const start = integer(opts.startEvent ?? 0, "startEvent", 0, count);
			const events = integer(opts.eventCount ?? count - start, "eventCount", 0, count - start);
			const chunkEvents = integer(
				opts.chunkEvents ?? Math.max(1, Math.min(maxEvents, Math.floor(DEFAULT_CHUNK / rowBytes))),
				"chunkEvents",
				1,
				maxEvents,
			);
			for (let offset = start; offset < start + events; offset += chunkEvents) {
				const n = Math.min(chunkEvents, start + events - offset);
				const bytes = await read(ds + offset * rowBytes, n * rowBytes, opts.signal);
				const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
				yield {
					start: offset,
					count: n,
					data: decodeData(view, decodingChannels, datatype, byteord, n),
				};
			}
		},
	};
}

function encodeText(kw: Record<string, string>): Uint8Array {
	// Avoid leading delimiters: their doubled escape is ambiguous with the preceding separator.
	const leading = new Set(Object.entries(kw).flatMap(([key, value]) => [key[0], value[0]]));
	const delimiter = [
		"/",
		"|",
		"~",
		"^",
		"!",
		...Array.from({ length: 126 }, (_, i) => String.fromCharCode(i + 1)),
	].find((d) => !leading.has(d));
	if (!delimiter) throw new FcsError("cannot choose unambiguous TEXT delimiter");
	let text = delimiter;
	for (const [key, value] of Object.entries(kw)) {
		if (!key || !value || key.trim() !== key || key.includes("\0") || value.includes("\0"))
			throw new FcsError("TEXT keys/values must be nonempty and NUL-free");
		if (text.length + key.length + value.length + 2 > METADATA_LIMIT)
			throw new FcsError("TEXT exceeds 16 MiB limit");
		text += `${key.replaceAll(delimiter, delimiter + delimiter)}${delimiter}${value.replaceAll(delimiter, delimiter + delimiter)}${delimiter}`;
		if (text.length > METADATA_LIMIT) throw new FcsError("TEXT exceeds 16 MiB limit");
	}
	const bytes = new TextEncoder().encode(text);
	if (new TextDecoder().decode(bytes) !== text) throw new FcsError("TEXT contains invalid Unicode");
	if (bytes.length > METADATA_LIMIT) throw new FcsError("TEXT exceeds 16 MiB limit");
	return bytes;
}

/**
 * Stream FCS3.1 float32 little-endian without buffering the event stream. Each input chunk must
 * contain complete rows. Consumers MUST discard partial output if iteration fails or is stopped.
 * Values are raw numeric I/O: no compensation, gain division, or log-to-linear conversion.
 */
export async function* writeFcs(
	metadata: Omit<FcsFile, "data">,
	chunks: AsyncIterable<Float32Array> | Iterable<Float32Array>,
	options: WriteFcsOptions = {},
): AsyncIterable<Uint8Array> {
	cancelled(options.signal);
	const chunkBytes = integer(options.chunkBytes ?? DEFAULT_CHUNK, "chunkBytes", 4, CHUNK_LIMIT);
	const count = integer(metadata.eventCount, "eventCount");
	const par = integer(metadata.channels.length, "channel count", 1, 65536);
	const values = integer(count * par, "value count");
	const dataBytes = integer(values * 4, "DATA byte count");
	const kw: Record<string, string> = Object.create(null);
	const structural =
		/^\$(?:P\d+.*|PAR|TOT|DATATYPE|BYTEORD|MODE|NEXTDATA|(?:BEGIN|END)(?:DATA|STEXT|ANALYSIS)|UNICODE|SPILL|SPILLOVER)$|^(?:SPILL|SPILLOVER)$/;
	let suppliedSize = 0;
	for (const [key, value] of Object.entries(metadata.keywords)) {
		if (typeof value !== "string") throw new FcsError("keyword values must be strings");
		suppliedSize += key.length + value.length;
		if (suppliedSize > METADATA_LIMIT) throw new FcsError("input metadata exceeds 16 MiB limit");
		const normalized = key.toUpperCase();
		if (!structural.test(normalized)) kw[normalized] = value;
	}
	Object.assign(kw, {
		$PAR: String(par),
		$TOT: String(count),
		$DATATYPE: "F",
		$BYTEORD: "1,2,3,4",
		$MODE: "L",
		$NEXTDATA: "0",
		$BEGINANALYSIS: "0",
		$ENDANALYSIS: "0",
		$BEGINSTEXT: "0",
		$ENDSTEXT: "0",
	});
	const names = new Set<string>();
	for (let p = 0; p < par; p++) {
		const c = metadata.channels[p];
		if (!c) throw new FcsError("missing channel");
		if (typeof c.name !== "string" || !c.name.trim() || names.has(c.name))
			throw new FcsError("channel names must be nonempty and unique");
		names.add(c.name);
		if (
			!Array.isArray(c.amplification) ||
			c.amplification.length !== 2 ||
			c.amplification.some((v) => v !== 0)
		)
			throw new FcsError(
				"nonzero amplification requires upstream numerical conversion before export",
			);
		if (c.gain !== 1)
			throw new FcsError("non-unit gain requires upstream numerical conversion before export");
		if (!Number.isFinite(c.range) || c.range <= 0) throw new FcsError("invalid channel range");
		const prefix = `$P${p + 1}`;
		kw[`${prefix}N`] = c.name;
		kw[`${prefix}B`] = "32";
		kw[`${prefix}R`] = String(c.range);
		kw[`${prefix}E`] = "0,0";
		kw[`${prefix}G`] = "1";
		if (c.stain) kw[`${prefix}S`] = c.stain;
	}
	if (metadata.spill) {
		const s = metadata.spill;
		const n = s.channels.length;
		if (
			n < 1 ||
			n * n > METADATA_LIMIT / 8 ||
			s.matrix.length !== n * n ||
			s.channels.some((c) => c.trim() !== c || c.includes(",") || !names.has(c))
		)
			throw new FcsError("spill dimensions/named channels do not match export channels");
		kw.$SPILLOVER = `${n},${s.channels.join(",")},${Array.from(s.matrix).join(",")}`;
		parseSpill(kw);
	}
	// Fixed-width decimal TEXT offsets make TEXT length independent of the eventual DATA location.
	kw.$BEGINDATA = "0".repeat(16);
	kw.$ENDDATA = "0".repeat(16);
	let text = encodeText(kw);
	const textEnd = 58 + text.length - 1;
	const dataStart = count === 0 ? 0 : textEnd + 1;
	const dataEnd = count === 0 ? 0 : integer(dataStart + dataBytes, "file byte count") - 1;
	kw.$BEGINDATA = String(dataStart).padStart(16, "0");
	kw.$ENDDATA = String(dataEnd).padStart(16, "0");
	text = encodeText(kw);
	const field = (n: number) => String(n).padStart(8, " ");
	const headerData = dataEnd > 99999999 ? [0, 0] : [dataStart, dataEnd];
	const header = new TextEncoder().encode(
		`FCS3.1    ${[58, textEnd, ...headerData, 0, 0].map(field).join("")}`,
	);
	for (const section of [header, text]) {
		for (let offset = 0; offset < section.length; offset += chunkBytes) {
			cancelled(options.signal);
			yield section.slice(offset, offset + chunkBytes);
		}
	}
	let written = 0;
	const chunkValues = Math.floor(chunkBytes / 4);
	cancelled(options.signal);
	const iterator =
		Symbol.asyncIterator in chunks ? chunks[Symbol.asyncIterator]() : chunks[Symbol.iterator]();
	let exhausted = false;
	try {
		while (true) {
			cancelled(options.signal);
			const item = await iterator.next();
			cancelled(options.signal);
			if (item.done) {
				exhausted = true;
				break;
			}
			const input = item.value;
			if (!(input instanceof Float32Array) || input.length % par !== 0)
				throw new FcsError("input chunk must be Float32Array of complete event rows");
			if (input.byteLength > CHUNK_LIMIT) throw new FcsError("input chunk exceeds 128 MiB limit");
			if (input.length > values - written) throw new FcsError("excess input events");
			for (let offset = 0; offset < input.length; offset += chunkValues) {
				cancelled(options.signal);
				const n = Math.min(chunkValues, input.length - offset);
				const output = new Uint8Array(n * 4);
				const view = new DataView(output.buffer);
				for (let i = 0; i < n; i++) view.setFloat32(i * 4, input[offset + i] as number, true);
				written += n;
				yield output;
			}
		}
		if (written !== values)
			throw new FcsError(`premature end of input: expected ${values} values, received ${written}`);
	} finally {
		if (!exhausted) await iterator.return?.();
	}
}
