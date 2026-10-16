/**
 * FCS 2.0 / 3.0 / 3.1 reader. Dependency-free; works on an ArrayBuffer in browser and Node.
 *
 * Output layout is row-major `Float32Array` (event-major) so it can be streamed straight into
 * per-channel GPU columns by the compute package. Spill matrices ($SPILLOVER / $SPILL / SPILL)
 * are parsed but never applied here.
 */

export interface FcsChannel {
	/** 1-based parameter index ($Pn). */
	index: number;
	/** $PnN short name. */
	name: string;
	/** $PnS stain / display name, if present. */
	stain?: string;
	/** $PnR range (maximum value + 1 for integer data). */
	range: number;
	/** $PnB bits per value. */
	bits: number;
	/** $PnE amplification: [decades, offset]. [0,0] = linear. */
	amplification: [number, number];
	/** $PnG gain, default 1. */
	gain: number;
}

export interface FcsSpill {
	channels: string[];
	/** Row-major n×n spill matrix S: recorded row y = true row x * S (FlowUtils convention). */
	matrix: Float64Array;
	/** Which keyword it came from. */
	source: "$SPILLOVER" | "$SPILL" | "SPILL" | "SPILLOVER";
}

export interface FcsFile {
	version: string;
	keywords: Record<string, string>;
	channels: FcsChannel[];
	eventCount: number;
	/** Row-major, `eventCount * channels.length`. */
	data: Float32Array;
	spill?: FcsSpill;
}

export interface FcsHeader {
	version: string;
	textStart: number;
	textEnd: number;
	dataStart: number;
	dataEnd: number;
	analysisStart: number;
	analysisEnd: number;
}

export class FcsError extends Error {
	override name = "FcsError";
}

const ascii = (b: Uint8Array, s: number, e: number): string =>
	String.fromCharCode(...b.subarray(s, e));

export function readHeader(buffer: ArrayBuffer): FcsHeader {
	if (buffer.byteLength < 58) throw new FcsError("file too short for an FCS header");
	const b = new Uint8Array(buffer, 0, 58);
	const version = ascii(b, 0, 6).trim();
	if (!/^FCS\d\.\d$/.test(version)) throw new FcsError(`not an FCS file (version "${version}")`);
	const off = (i: number) => {
		const s = ascii(b, 10 + i * 8, 18 + i * 8).trim();
		if (s !== "" && !/^\d+$/.test(s)) throw new FcsError("invalid header offset");
		return s === "" ? 0 : Number(s);
	};
	return {
		version,
		textStart: off(0),
		textEnd: off(1),
		dataStart: off(2),
		dataEnd: off(3),
		analysisStart: off(4),
		analysisEnd: off(5),
	};
}

/**
 * Parse a TEXT segment. Delimiter is the first byte; a doubled delimiter inside a value is an escaped
 * literal. Keys are upper-cased (the standard says keywords are case-insensitive).
 */
export function parseText(
	bytes: Uint8Array,
	encoding: "utf-8" | "latin1" = "utf-8",
): Record<string, string> {
	if (bytes.length === 0) throw new FcsError("empty TEXT segment");
	if (bytes.length > 16 * 1024 * 1024) throw new FcsError("TEXT exceeds 16 MiB limit");
	const d = bytes[0] as number;
	if (d < 1 || d > 127) throw new FcsError("TEXT delimiter must be nonzero ASCII");
	// Offsets refer to bytes, never decoded string length. Legacy single-byte input is opt-in.
	let text: string;
	try {
		text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
	} catch {
		throw new FcsError("invalid TEXT encoding (expected UTF-8; legacy latin1 is opt-in)");
	}
	const delim = String.fromCharCode(d);
	const tokens: string[] = [];
	let cur = "";
	for (let i = 1; i < text.length; i++) {
		const c = text[i] as string;
		if (c === delim) {
			if (text[i + 1] === delim) {
				cur += delim;
				i++;
			} else {
				tokens.push(cur);
				cur = "";
			}
		} else cur += c;
	}
	if (cur.length > 0) tokens.push(cur);
	if (tokens.length % 2 !== 0) throw new FcsError("unpaired TEXT keyword/value");
	const kw: Record<string, string> = Object.create(null);
	for (let i = 0; i + 1 < tokens.length; i += 2) {
		const k = (tokens[i] as string).trim().toUpperCase();
		if (k) kw[k] = tokens[i + 1] as string;
	}
	return kw;
}

function num(kw: Record<string, string>, key: string, fallback?: number): number {
	const v = kw[key];
	if (v === undefined) {
		if (fallback !== undefined) return fallback;
		throw new FcsError(`missing required keyword ${key}`);
	}
	const n = Number(v);
	if (v.trim() === "" || !Number.isFinite(n))
		throw new FcsError(`keyword ${key} is not numeric: "${v}"`);
	return n;
}

export function parseChannels(kw: Record<string, string>): FcsChannel[] {
	const par = num(kw, "$PAR");
	if (!Number.isSafeInteger(par) || par < 1 || par > 65536)
		throw new FcsError("$PAR must be an integer in [1, 65536]");
	const out: FcsChannel[] = [];
	for (let i = 1; i <= par; i++) {
		const amplification = (kw[`$P${i}E`] ?? "0,0").split(",");
		if (amplification.some((v) => v.trim() === "")) throw new FcsError(`invalid $P${i}E`);
		const e = amplification.map(Number);
		if (e.length !== 2 || e.some((v) => !Number.isFinite(v) || v < 0))
			throw new FcsError(`invalid $P${i}E`);
		const ch: FcsChannel = {
			index: i,
			name: kw[`$P${i}N`] ?? `P${i}`,
			range: num(kw, `$P${i}R`, 262144),
			bits: num(kw, `$P${i}B`),
			amplification: [e[0] ?? 0, e[1] ?? 0],
			gain: num(kw, `$P${i}G`, 1),
		};
		if (!Number.isSafeInteger(ch.bits) || ch.bits <= 0 || ch.range <= 0 || ch.gain <= 0)
			throw new FcsError(`invalid channel ${i} bits/range/gain`);
		const s = kw[`$P${i}S`];
		if (s !== undefined && s !== "") ch.stain = s;
		out.push(ch);
	}
	return out;
}

export function parseSpill(kw: Record<string, string>): FcsSpill | undefined {
	for (const key of ["$SPILLOVER", "$SPILL", "SPILL", "SPILLOVER"] as const) {
		const v = kw[key];
		if (v === undefined) continue;
		if (v.length > 16 * 1024 * 1024) throw new FcsError(`oversized ${key}`);
		const parts = v.split(",").map((s) => s.trim());
		const n = Number(parts[0]);
		if (
			!/^\d+$/.test(parts[0] ?? "") ||
			!Number.isSafeInteger(n) ||
			n <= 0 ||
			n * n > 2097152 ||
			parts.length !== 1 + n + n * n
		) {
			throw new FcsError(`malformed ${key}`);
		}
		const channels = parts.slice(1, 1 + n);
		if (channels.some((c) => c === "") || new Set(channels).size !== n)
			throw new FcsError(`malformed ${key} channel names`);
		if (parts.slice(1 + n).some((v) => v === "" || !Number.isFinite(Number(v))))
			throw new FcsError(`malformed ${key} coefficients`);
		const matrix = Float64Array.from(parts.slice(1 + n, 1 + n + n * n), Number);
		return { channels, matrix, source: key };
	}
	return undefined;
}

function resolveDataRange(
	h: FcsHeader,
	kw: Record<string, string>,
	total: number,
): [number, number] {
	// FCS 3.x: header offsets may be 0 when the segment exceeds 99,999,999 bytes; $BEGINDATA/$ENDDATA win.
	let start = h.dataStart;
	let end = h.dataEnd;
	if (kw.$BEGINDATA !== undefined && kw.$ENDDATA !== undefined) {
		const bs = num(kw, "$BEGINDATA");
		const be = num(kw, "$ENDDATA");
		if (!Number.isSafeInteger(bs) || !Number.isSafeInteger(be) || bs < 0 || be < 0)
			throw new FcsError("invalid DATA offsets");
		if (bs > 0 && be > 0 && (start === 0 || end === 0 || bs === start)) {
			start = bs;
			end = be;
		}
	}
	if (start <= 0 || end < start) throw new FcsError("cannot locate DATA segment");
	if (start >= total)
		throw new FcsError(`DATA segment starts past end of file (${start} >= ${total})`);
	// Truncated files: clamp and let the caller compare eventCount with $TOT.
	return [start, Math.min(end, total - 1)];
}

export interface ReadOptions {
	/** Skip decoding the DATA segment; `data` is an empty array and `eventCount` is from $TOT. */
	headerOnly?: boolean;
	/** UTF-8 by default; latin1 explicitly opts into legacy Windows-1252 decoding. */
	textEncoding?: "utf-8" | "latin1";
}

export function readFcs(buffer: ArrayBuffer, opts: ReadOptions = {}): FcsFile {
	const h = readHeader(buffer);
	if (h.textStart < 58 || h.textEnd < h.textStart || h.textEnd + 1 > buffer.byteLength) {
		throw new FcsError("invalid TEXT segment offsets");
	}
	const kw = parseText(
		new Uint8Array(buffer, h.textStart, h.textEnd - h.textStart + 1),
		opts.textEncoding,
	);

	// Supplemental TEXT (3.x) — merge, primary wins.
	if (kw.$BEGINSTEXT && kw.$ENDSTEXT) {
		const s = num(kw, "$BEGINSTEXT");
		const e = num(kw, "$ENDSTEXT");
		if (!Number.isSafeInteger(s) || !Number.isSafeInteger(e) || s < 0 || e < 0)
			throw new FcsError("invalid supplemental TEXT offsets");
		if (s > 0 && e > s && e + 1 <= buffer.byteLength && s !== h.textStart) {
			const supp = parseText(new Uint8Array(buffer, s, e - s + 1), opts.textEncoding);
			for (const [k, v] of Object.entries(supp)) if (!(k in kw)) kw[k] = v;
		}
	}

	if ((kw.$MODE ?? "L") !== "L")
		throw new FcsError(`unsupported $MODE ${kw.$MODE} (only list mode)`);
	if (num(kw, "$NEXTDATA", 0) !== 0) throw new FcsError("multiple FCS datasets are unsupported");
	const channels = parseChannels(kw);
	const spill = parseSpill(kw);
	const tot = num(kw, "$TOT");
	if (!Number.isSafeInteger(tot) || tot < 0) throw new FcsError("invalid $TOT");
	const base: Omit<FcsFile, "data" | "eventCount"> = { version: h.version, keywords: kw, channels };
	if (spill) base.spill = spill;

	if (opts.headerOnly) return { ...base, eventCount: tot, data: new Float32Array(0) };

	if (tot === 0) return { ...base, eventCount: 0, data: new Float32Array(0) };
	const [ds, de] = resolveDataRange(h, kw, buffer.byteLength);
	const datatype = kw.$DATATYPE ?? "F";
	const bytes = new DataView(buffer, ds, de - ds + 1);

	const rowBytes = dataLayout(channels, datatype, kw.$BYTEORD ?? "1,2,3,4");
	const available = Math.floor(bytes.byteLength / rowBytes);
	const events = Math.min(tot, available);
	return {
		...base,
		eventCount: events,
		data: decodeData(bytes, channels, datatype, kw.$BYTEORD ?? "1,2,3,4", events),
	};
}

/** @internal Validate binary layout before allocating decoded output. */
export function dataLayout(channels: FcsChannel[], datatype: string, byteord: string): number {
	if (!["F", "D", "I"].includes(datatype)) throw new FcsError(`unsupported $DATATYPE ${datatype}`);
	if (!["1,2", "2,1", "1,2,3,4", "4,3,2,1", "1,2,3,4,5,6,7,8", "8,7,6,5,4,3,2,1"].includes(byteord))
		throw new FcsError(`unsupported $BYTEORD ${byteord}`);
	for (const c of channels) {
		const valid =
			datatype === "F"
				? c.bits === 32
				: datatype === "D"
					? c.bits === 64
					: [8, 16, 24, 32, 64].includes(c.bits);
		if (!valid) throw new FcsError(`unsupported $PnB=${c.bits} for $DATATYPE ${datatype}`);
		if (datatype === "I" && (!Number.isInteger(c.range) || c.range > 2 ** c.bits))
			throw new FcsError("integer $PnR must fit its bit width");
	}
	return channels.reduce((n, c) => n + c.bits / 8, 0);
}

/** @internal Shared binary I/O decoder; no gain, amplification, or compensation is applied. */
export function decodeData(
	bytes: DataView,
	channels: FcsChannel[],
	datatype: string,
	byteord: string,
	events: number,
): Float32Array {
	const little = byteord.startsWith("1");
	const par = channels.length;
	const bitsList = channels.map((c) => c.bits);
	const data = new Float32Array(events * par);

	if (datatype === "F") {
		if (bitsList.some((b) => b !== 32)) throw new FcsError("$DATATYPE F requires $PnB=32");
		let o = 0;
		for (let i = 0; i < events * par; i++) {
			data[i] = bytes.getFloat32(o, little);
			o += 4;
		}
	} else if (datatype === "D") {
		if (bitsList.some((b) => b !== 64)) throw new FcsError("$DATATYPE D requires $PnB=64");
		let o = 0;
		for (let i = 0; i < events * par; i++) {
			data[i] = bytes.getFloat64(o, little);
			o += 8;
		}
	} else if (datatype === "I") {
		// Integer data: $PnB bits per value (8/16/24/32/64), masked to $PnR (next power of two - 1).
		const masks = channels.map((c) => {
			const r = c.range;
			const p = 2 ** Math.ceil(Math.log2(Math.max(r, 2)));
			return p - 1;
		});
		let o = 0;
		for (let ev = 0; ev < events; ev++) {
			for (let p = 0; p < par; p++) {
				const bits = bitsList[p] as number;
				let v: number;
				switch (bits) {
					case 8:
						v = bytes.getUint8(o);
						break;
					case 16:
						v = bytes.getUint16(o, little);
						break;
					case 32:
						v = bytes.getUint32(o, little);
						break;
					case 64:
						// Mask before conversion: Number(uint64) could round away meaningful low bits.
						v = Number(bytes.getBigUint64(o, little) & (BigInt((masks[p] as number) + 1) - 1n));
						break;
					case 24: {
						const b0 = bytes.getUint8(o);
						const b1 = bytes.getUint8(o + 1);
						const b2 = bytes.getUint8(o + 2);
						v = little ? b0 | (b1 << 8) | (b2 << 16) : (b0 << 16) | (b1 << 8) | b2;
						break;
					}
					default:
						throw new FcsError(`unsupported $PnB=${bits} for integer data`);
				}
				const m = masks[p] as number;
				data[ev * par + p] = bits <= 32 ? (v & m) >>> 0 : v;
				o += bits / 8;
			}
		}
	} else {
		throw new FcsError(`unsupported $DATATYPE ${datatype}`);
	}

	return data;
}

/** Extract a single channel as a contiguous column. */
export function column(file: FcsFile, index: number): Float32Array {
	const par = file.channels.length;
	const out = new Float32Array(file.eventCount);
	for (let i = 0; i < file.eventCount; i++) out[i] = file.data[i * par + index] as number;
	return out;
}

export type {
	FcsByteSource,
	FcsChunk,
	FcsChunkOptions,
	FcsReader,
	OpenFcsOptions,
	WriteFcsOptions,
} from "./stream.js";
export { blobSource, openFcs, writeFcs } from "./stream.js";
