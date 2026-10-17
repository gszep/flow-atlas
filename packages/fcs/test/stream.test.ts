import { describe, expect, it } from "vitest";
import {
	blobSource,
	type FcsByteSource,
	type FcsChannel,
	FcsError,
	type FcsFile,
	openFcs,
	parseSpill,
	parseText,
	readFcs,
	readHeader,
	writeFcs,
} from "../src/index.js";

const encoder = new TextEncoder();
const base = (): Omit<FcsFile, "data"> => ({
	version: "FCS3.0",
	keywords: { $CYT: "Synthetic" },
	channels: ["A", "B"].map((name, i) => ({
		index: i + 1,
		name,
		range: 1024,
		bits: 32,
		amplification: [0, 0],
		gain: 1,
	})),
	eventCount: 3,
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
	const result: T[] = [];
	for await (const item of stream) result.push(item);
	return result;
}

async function output(
	metadata = base(),
	input = [new Float32Array([-4, 2, 3, 4, 5000, 6])],
	chunkBytes = 13,
): Promise<Uint8Array> {
	const pieces = await collect(writeFcs(metadata, input, { chunkBytes }));
	expect(Math.max(...pieces.map((p) => p.length))).toBeLessThanOrEqual(chunkBytes);
	return Uint8Array.from(pieces.flatMap((p) => Array.from(p)));
}

/** Sparse source: never constructs the gap, and fails if the reader requests any of it. */
function synthetic(
	options: {
		datatype?: string;
		bits?: number[];
		little?: boolean;
		values?: number[];
		dataStart?: number;
		keywords?: Record<string, string>;
		supplement?: Record<string, string>;
	} = {},
) {
	const bits = options.bits ?? [32, 32];
	const values = options.values ?? [1, 2, 3, 4, 5, 6];
	const rowBytes = bits.reduce((n, b) => n + b / 8, 0);
	const count = values.length / bits.length;
	const datatype = options.datatype ?? "F";
	const little = options.little ?? true;
	const data = new Uint8Array(rowBytes * count);
	const dv = new DataView(data.buffer);
	let offset = 0;
	for (let i = 0; i < values.length; i++) {
		const b = bits[i % bits.length] as number;
		const v = values[i] as number;
		if (datatype === "F") dv.setFloat32(offset, v, little);
		else if (datatype === "D") dv.setFloat64(offset, v, little);
		else if (b === 8) dv.setUint8(offset, v);
		else if (b === 16) dv.setUint16(offset, v, little);
		else if (b === 32) dv.setUint32(offset, v, little);
		else if (b === 64) dv.setBigUint64(offset, BigInt(v), little);
		else if (b === 24) {
			for (let j = 0; j < 3; j++) data[offset + j] = (v >>> (8 * (little ? j : 2 - j))) & 255;
		}
		offset += b / 8;
	}
	const ds = options.dataStart ?? 4096;
	const kw: Record<string, string> = {
		$TOT: String(count),
		$PAR: String(bits.length),
		$DATATYPE: datatype,
		$BYTEORD: little ? "1,2,3,4" : "4,3,2,1",
		$MODE: "L",
		$NEXTDATA: "0",
		$BEGINDATA: String(ds),
		$ENDDATA: String(ds + data.length - 1),
	};
	for (let p = 0; p < bits.length; p++)
		Object.assign(kw, {
			[`$P${p + 1}B`]: String(bits[p]),
			[`$P${p + 1}R`]: String(2 ** Math.min(bits[p] as number, 32)),
			[`$P${p + 1}N`]: `P${p + 1}`,
		});
	const text = (k: Record<string, string>) =>
		encoder.encode(
			`|${Object.entries(k)
				.map(([key, value]) => `${key}|${value}|`)
				.join("")}`,
		);
	const supplement = options.supplement ? text(options.supplement) : undefined;
	if (supplement)
		Object.assign(kw, { $BEGINSTEXT: "2048", $ENDSTEXT: String(2048 + supplement.length - 1) });
	Object.assign(kw, options.keywords);
	const primary = text(kw);
	const header = encoder.encode(
		`FCS3.1    ${[58, 57 + primary.length, 0, 0, 0, 0].map((n) => String(n).padStart(8, " ")).join("")}`,
	);
	const segments = [
		{ start: 0, bytes: header },
		{ start: 58, bytes: primary },
		{ start: ds, bytes: data },
	];
	if (supplement) segments.push({ start: 2048, bytes: supplement });
	const calls: [number, number][] = [];
	const source: FcsByteSource = {
		size: ds + data.length,
		async read(start, length) {
			calls.push([start, length]);
			const segment = segments.find(
				(s) => start >= s.start && start + length <= s.start + s.bytes.length,
			);
			if (!segment) throw new Error(`unexpected sparse read ${start}, ${length}`);
			// Nonzero byteOffset exercises DataView handling of Node Buffer-like source slices.
			const padded = new Uint8Array(length + 8);
			padded.set(segment.bytes.subarray(start - segment.start, start - segment.start + length), 4);
			return padded.subarray(4, 4 + length);
		},
	};
	return { source, calls, segments };
}

describe("bounded FCS streaming", () => {
	it("reads pooled Buffer views without using the backing pool prefix", async () => {
		const bytes = await output();
		const reader = await openFcs({
			size: bytes.length,
			async read(offset, length) {
				const backing = Buffer.alloc(length + 32, 0x78);
				backing.set(bytes.subarray(offset, offset + length), 16);
				return backing.subarray(16, 16 + length);
			},
		});
		expect(reader.metadata.eventCount).toBe(3);
		const chunks = await collect(reader.chunks({ chunkEvents: 2 }));
		expect(chunks.flatMap((chunk) => Array.from(chunk.data))).toEqual([-4, 2, 3, 4, 5000, 6]);
	});
	it("roundtrips negative and above-range floats, bounds all output, and reads subsets", async () => {
		const bytes = await output();
		const f = await openFcs(blobSource(new Blob([bytes])));
		expect(f.countPolicy).toBe("exact-declared");
		expect(f.metadata.eventCount).toBe(3);
		expect(f.metadata.channels.map((c) => c.amplification)).toEqual([
			[0, 0],
			[0, 0],
		]);
		const chunks = await collect(f.chunks({ chunkEvents: 1, startEvent: 1, eventCount: 2 }));
		expect(chunks.map((c) => [c.start, c.count, Array.from(c.data)])).toEqual([
			[1, 1, [3, 4]],
			[2, 1, [5000, 6]],
		]);
		expect(Array.from(readFcs(bytes.buffer as ArrayBuffer).data)).toEqual([-4, 2, 3, 4, 5000, 6]);
	});

	it.each([true, false])("decodes F/D/mixed I widths, little endian=%s", async (little) => {
		const variants = [
			{ datatype: "F", bits: [32, 32], values: [-2.5, 3, 4, 1.25] },
			{ datatype: "D", bits: [64, 64], values: [-2.5, 3, 4, 1.25] },
			{
				datatype: "I",
				bits: [8, 16, 24, 32, 64],
				values: [255, 65535, 16000000, 4000000000, 123456, 1, 2, 3, 4, 5],
			},
		];
		const actual: number[][] = [];
		for (const variant of variants) {
			const { source } = synthetic({ ...variant, little });
			const reader = await openFcs(source);
			actual.push(
				(await collect(reader.chunks({ chunkEvents: 1 }))).flatMap((c) => Array.from(c.data)),
			);
		}
		expect(actual).toEqual(variants.map((v) => Array.from(new Float32Array(v.values))));
	});

	it("reads sparse >100 MB offsets and supplemental TEXT without reading the gap", async () => {
		const { source, calls } = synthetic({
			dataStart: 100000123,
			supplement: { $CYT: "supplement", $TOT: "999" },
		});
		const reader = await openFcs(source);
		expect(calls.length).toBe(3);
		expect(reader.metadata.keywords.$CYT).toBe("supplement");
		expect(reader.metadata.eventCount).toBe(3);
		const chunks = await collect(reader.chunks({ chunkEvents: 2 }));
		expect(chunks.map((c) => [c.start, c.count, Array.from(c.data)])).toEqual([
			[0, 2, [1, 2, 3, 4]],
			[2, 1, [5, 6]],
		]);
		expect(calls.slice(3)).toEqual([
			[100000123, 16],
			[100000139, 8],
		]);
	});

	it("masks 64-bit integers before rounding and rounds full uint64 only to float32", async () => {
		const narrow = synthetic({ datatype: "I", bits: [64], values: [0], keywords: { $P1R: "256" } });
		const full = synthetic({
			datatype: "I",
			bits: [64],
			values: [0],
			keywords: { $P1R: String(2 ** 64) },
		});
		new DataView((narrow.segments[2] as { bytes: Uint8Array }).bytes.buffer).setBigUint64(
			0,
			(1n << 60n) + 3n,
			true,
		);
		new DataView((full.segments[2] as { bytes: Uint8Array }).bytes.buffer).setBigUint64(
			0,
			(1n << 64n) - 1n,
			true,
		);
		expect((await collect((await openFcs(narrow.source)).chunks()))[0]?.data[0]).toBe(3);
		expect((await collect((await openFcs(full.source)).chunks()))[0]?.data[0]).toBe(2 ** 64);
	});

	it("streams multiple input chunks across arbitrary output byte boundaries", async () => {
		const bytes = await output(
			base(),
			[new Float32Array([1, 2]), new Float32Array([3, 4, 5, 6])],
			7,
		);
		expect(Array.from(readFcs(bytes.buffer as ArrayBuffer).data)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("does not let mutable public metadata change subsequent decoding", async () => {
		const reader = await openFcs(synthetic().source);
		reader.metadata.eventCount = 100;
		(reader.metadata.channels[0] as FcsChannel).bits = 8;
		expect((await collect(reader.chunks())).flatMap((c) => Array.from(c.data))).toEqual([
			1, 2, 3, 4, 5, 6,
		]);
	});

	it("rejects truncation instead of silently changing declared event count", async () => {
		const { source } = synthetic();
		source.size -= 1;
		await expect(openFcs(source)).rejects.toThrow(/past end/);
		await expect(openFcs(synthetic({ keywords: { $TOT: "2" } }).source)).rejects.toThrow(
			/DATA length/,
		);
	});

	it("rejects conflicting and malformed header offsets", async () => {
		const conflict = synthetic();
		conflict.segments[0]?.bytes.set(encoder.encode("    4097"), 26);
		await expect(openFcs(conflict.source)).rejects.toThrow(/conflicting/);
		const malformed = synthetic();
		malformed.segments[0]?.bytes.set(encoder.encode("     58x"), 10);
		await expect(openFcs(malformed.source)).rejects.toThrow(/header offset/);
	});

	it.each(["-1", "1.5", "NaN", "Infinity", "9007199254740992", "2x"])(
		"rejects invalid counts %s",
		async (value) => {
			await expect(openFcs(synthetic({ keywords: { $TOT: value } }).source)).rejects.toThrow(
				FcsError,
			);
			await expect(openFcs(synthetic({ keywords: { $PAR: value } }).source)).rejects.toThrow(
				FcsError,
			);
		},
	);

	it.each([
		{ $P1B: "31" },
		{ $PAR: "0" },
		{ $PAR: "65537" },
		{ $P1R: "0" },
		{ $P1E: "NaN,0" },
		{ $P1E: "1," },
		{ $P1G: "Infinity" },
		{ $BYTEORD: "1,3,2,4" },
		{ $NEXTDATA: "12" },
		{ $MODE: "C" },
		{ $BEGINDATA: "4096.5" },
		{ $ENDDATA: "9007199254740992" },
		{ $BEGINSTEXT: "58", $ENDSTEXT: "100" },
	])("rejects malformed metadata %j", async (keywords) => {
		await expect(openFcs(synthetic({ keywords }).source)).rejects.toThrow(FcsError);
	});

	it("rejects oversized metadata before requesting it and exact-length failures on header/data", async () => {
		const { source, segments, calls } = synthetic();
		segments[0]?.bytes.set(encoder.encode("16777275"), 18);
		source.size = 20000000;
		await expect(openFcs(source)).rejects.toThrow(/16 MiB/);
		expect(calls).toEqual([[0, 58]]);
		await expect(
			openFcs({
				size: 100,
				async read() {
					return new Uint8Array(57);
				},
			}),
		).rejects.toThrow(/length mismatch/);
		const valid = synthetic();
		const reader = await openFcs(valid.source);
		valid.source.read = async (_, n) => new Uint8Array(n - 1);
		await expect(collect(reader.chunks())).rejects.toThrow(/length mismatch/);
	});

	it("checks cancellation before/after source reads, at each chunk, and for empty iteration", async () => {
		const controller = new AbortController();
		const { source, calls } = synthetic();
		const reader = await openFcs(source);
		const stream = reader
			.chunks({ chunkEvents: 1, signal: controller.signal })
			[Symbol.asyncIterator]();
		await stream.next();
		controller.abort();
		await expect(stream.next()).rejects.toThrow(/aborted/);
		expect(calls.length).toBe(3);
		await expect(openFcs(source, { signal: controller.signal })).rejects.toThrow(/aborted/);
		await expect(
			collect(reader.chunks({ eventCount: 0, signal: controller.signal })),
		).rejects.toThrow(/aborted/);
		const during = new AbortController();
		await expect(
			openFcs(
				{
					size: 100,
					async read() {
						during.abort();
						return new Uint8Array(58);
					},
				},
				{ signal: during.signal },
			),
		).rejects.toThrow(/aborted/);
	});

	it.each([
		{ chunkEvents: 0 },
		{ chunkEvents: 20000000 },
		{ chunkEvents: 1.2 },
		{ startEvent: -1 },
		{ startEvent: 4 },
		{ eventCount: 4 },
		{ startEvent: 2, eventCount: 2 },
	])("rejects invalid slice/chunk options %j", async (options) => {
		await expect(collect((await openFcs(synthetic().source)).chunks(options))).rejects.toThrow(
			FcsError,
		);
	});

	it("writes deliberate zero-event files with zero DATA offsets", async () => {
		const metadata = base();
		metadata.eventCount = 0;
		const bytes = await output(metadata, []);
		const reader = await openFcs(blobSource(new Blob([bytes])));
		expect(await collect(reader.chunks())).toEqual([]);
		expect(readHeader(bytes.buffer as ArrayBuffer).dataStart).toBe(0);
		expect(readFcs(bytes.buffer as ArrayBuffer).eventCount).toBe(0);
	});

	it("preserves UTF-8 and escaped delimiters, including leading slashes with another delimiter", async () => {
		const metadata = base();
		metadata.keywords = { $CYT: "測定器 🧪", COMMENT: "a/b/", "EXTRA/KEY": "μ / δ" };
		(metadata.channels[0] as FcsChannel).stain = "CD3 / α";
		let reader = await openFcs(blobSource(new Blob([await output(metadata)])));
		expect(reader.metadata.keywords).toMatchObject(metadata.keywords);
		expect(reader.metadata.channels[0]?.stain).toBe("CD3 / α");
		metadata.keywords.COMMENT = "/leading/slash";
		reader = await openFcs(blobSource(new Blob([await output(metadata)])));
		expect(reader.metadata.keywords.COMMENT).toBe("/leading/slash");
		expect(() => parseText(new Uint8Array([47, 75, 47, 233, 47]))).toThrow(/encoding/);
		expect(parseText(new Uint8Array([47, 75, 47, 233, 47]), "latin1").K).toBe("é");
	});

	it("regenerates/reindexes structural metadata and strips every spill alias unless explicit", async () => {
		const metadata = base();
		metadata.channels.reverse();
		metadata.keywords = {
			$P1N: "stale",
			$P99N: "stale",
			$P99B: "8",
			$NEXTDATA: "123",
			$BEGINANALYSIS: "999",
			$ENDANALYSIS: "1000",
			$SPILL: "invalid",
			SPILL: "invalid",
			SPILLOVER: "invalid",
			$SPILLOVER: "invalid",
			$DATATYPE: "I",
			$BEGINDATA: "999",
			$ENDDATA: "1000",
			$P1E: "4,1",
			NOTE: "keep",
		};
		let reader = await openFcs(blobSource(new Blob([await output(metadata)])));
		expect(reader.metadata.channels.map((c) => [c.index, c.name])).toEqual([
			[1, "B"],
			[2, "A"],
		]);
		expect(reader.metadata.spill).toBeUndefined();
		expect(reader.metadata.keywords).toMatchObject({
			NOTE: "keep",
			$NEXTDATA: "0",
			$BEGINANALYSIS: "0",
			$ENDANALYSIS: "0",
			$P1E: "0,0",
		});
		expect(Object.keys(reader.metadata.keywords).filter((k) => /SPILL|P99/.test(k))).toEqual([]);
		metadata.spill = {
			channels: ["A", "B"],
			matrix: new Float64Array([1, 0.2, 0.1, 1]),
			source: "$SPILL",
		};
		reader = await openFcs(blobSource(new Blob([await output(metadata)])));
		expect(reader.metadata.spill).toEqual({ ...metadata.spill, source: "$SPILLOVER" });
		metadata.spill.channels[0] = "missing";
		await expect(output(metadata)).rejects.toThrow(/named channels/);
	});

	it("uses zero header offsets and exact TEXT inclusive offsets for >99,999,999 output", async () => {
		const metadata = base();
		metadata.eventCount = 13000000;
		let pulled = 0;
		async function* input() {
			pulled++;
			yield new Float32Array(2);
		}
		const writer = writeFcs(metadata, input())[Symbol.asyncIterator]();
		const h = (await writer.next()).value as Uint8Array;
		const text = (await writer.next()).value as Uint8Array;
		const header = readHeader(h.buffer as ArrayBuffer);
		const kw = parseText(text);
		expect([header.dataStart, header.dataEnd, pulled]).toEqual([0, 0, 0]);
		expect(Number(kw.$ENDDATA) - Number(kw.$BEGINDATA) + 1).toBe(metadata.eventCount * 8);
		expect(Number(kw.$BEGINDATA)).toBe(header.textEnd + 1);
		await writer.return?.();
	});

	it("rejects short/excess/incomplete input and propagates upstream errors", async () => {
		await expect(output(base(), [new Float32Array(4)])).rejects.toThrow(/premature/);
		await expect(output(base(), [new Float32Array(8)])).rejects.toThrow(/excess/);
		await expect(output(base(), [new Float32Array(3), new Float32Array(3)])).rejects.toThrow(
			/complete event rows/,
		);
		async function* fails() {
			yield new Float32Array(2);
			throw new Error("upstream failure");
		}
		await expect(collect(writeFcs(base(), fails()))).rejects.toThrow("upstream failure");
	});

	it("cancels writing and closes the input iterator on early consumer return", async () => {
		const controller = new AbortController();
		let closed = false;
		async function* input() {
			try {
				yield new Float32Array(6);
			} finally {
				closed = true;
			}
		}
		const writer = writeFcs(base(), input(), { chunkBytes: 1024, signal: controller.signal })[
			Symbol.asyncIterator
		]();
		await writer.next();
		await writer.next();
		await writer.next();
		controller.abort();
		await expect(writer.next()).rejects.toThrow(/aborted/);
		expect(closed).toBe(true);
		closed = false;
		const early = writeFcs(base(), input())[Symbol.asyncIterator]();
		await early.next();
		await early.next();
		await early.next();
		await early.return?.();
		expect(closed).toBe(true);
	});

	it("does not pull input if cancelled after metadata emission", async () => {
		const controller = new AbortController();
		let pulls = 0;
		async function* input() {
			pulls++;
			yield new Float32Array(6);
		}
		const writer = writeFcs(base(), input(), { signal: controller.signal })[Symbol.asyncIterator]();
		await writer.next();
		await writer.next();
		controller.abort();
		await expect(writer.next()).rejects.toThrow(/aborted/);
		expect(pulls).toBe(0);
	});

	it("rejects gain/log export, malformed metadata, unsafe output lengths and chunk limits", async () => {
		const metadata = base();
		const channel = metadata.channels[0] as FcsChannel;
		channel.amplification = [4, 1];
		await expect(output(metadata)).rejects.toThrow(/amplification/);
		channel.amplification = [0, 0];
		channel.gain = 2;
		await expect(output(metadata)).rejects.toThrow(/gain/);
		channel.gain = 1;
		metadata.keywords.EMPTY = "";
		await expect(output(metadata)).rejects.toThrow(/nonempty/);
		delete metadata.keywords.EMPTY;
		metadata.keywords.BAD = "\ud800";
		await expect(output(metadata)).rejects.toThrow(/Unicode/);
		await expect(output(base(), [], 3)).rejects.toThrow(/chunkBytes/);
		await expect(output(base(), [], 128 * 1024 * 1024 + 1)).rejects.toThrow(/chunkBytes/);
		metadata.eventCount = Number.MAX_SAFE_INTEGER;
		await expect(output(metadata)).rejects.toThrow(/value count/);
	});

	it.each([
		"",
		"2junk,A,B,1,0,0,1",
		"2,A,B,1,0,0,1,junk",
		"2,A,A,1,0,0,1",
		"2,,B,1,0,0,1",
		"1,A,NaN",
		"1,A,Infinity",
		"1,A,",
		"1,A,1junk",
		"100000000000000000000,A,1",
	])("rejects malformed spill %s", (value) => {
		expect(() => parseSpill({ $SPILL: value })).toThrow(FcsError);
	});
});
