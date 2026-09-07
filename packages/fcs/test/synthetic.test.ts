import { describe, expect, it } from "vitest";
import { FcsError, parseSpill, parseText, readFcs } from "../src/index.js";

interface BuildOpts {
	version?: string;
	datatype?: "F" | "I" | "D";
	byteord?: "1,2,3,4" | "4,3,2,1";
	bits?: number[];
	delim?: string;
	extraKeywords?: Record<string, string>;
	useHeaderOffsets?: boolean;
}

/** Build a minimal FCS file in memory. */
function build(rows: number[][], opts: BuildOpts = {}): ArrayBuffer {
	const version = opts.version ?? "FCS3.0";
	const datatype = opts.datatype ?? "F";
	const byteord = opts.byteord ?? "4,3,2,1";
	const little = byteord === "1,2,3,4";
	const par = rows[0]?.length ?? 0;
	const bits = opts.bits ?? rows[0]?.map(() => (datatype === "D" ? 64 : 32)) ?? [];
	const d = opts.delim ?? "/";

	const rowBytes = bits.reduce((a, b) => a + b / 8, 0);
	const dataBytes = new Uint8Array(rowBytes * rows.length);
	const dv = new DataView(dataBytes.buffer);
	let o = 0;
	for (const r of rows) {
		for (let p = 0; p < par; p++) {
			const v = r[p] as number;
			const b = bits[p] as number;
			if (datatype === "F") dv.setFloat32(o, v, little);
			else if (datatype === "D") dv.setFloat64(o, v, little);
			else if (b === 8) dv.setUint8(o, v);
			else if (b === 16) dv.setUint16(o, v, little);
			else if (b === 32) dv.setUint32(o, v, little);
			else throw new Error("unsupported bits in test builder");
			o += b / 8;
		}
	}

	const kw: Record<string, string> = {
		$DATATYPE: datatype,
		$BYTEORD: byteord,
		$MODE: "L",
		$PAR: String(par),
		$TOT: String(rows.length),
		$NEXTDATA: "0",
	};
	for (let p = 1; p <= par; p++) {
		kw[`$P${p}N`] = `P${p}`;
		kw[`$P${p}B`] = String(bits[p - 1]);
		kw[`$P${p}R`] = datatype === "I" ? String(2 ** (bits[p - 1] as number)) : "262144";
		kw[`$P${p}E`] = "0,0";
	}
	Object.assign(kw, opts.extraKeywords);

	// Two-pass: text length depends on data offsets.
	const enc = (m: Record<string, string>) =>
		`${d}${Object.entries(m)
			.map(([k, v]) => `${k}${d}${v.replaceAll(d, d + d)}${d}`)
			.join("")}`;
	const headerLen = 58;
	let text = enc(kw);
	let dataStart = headerLen + text.length;
	for (let i = 0; i < 3; i++) {
		kw.$BEGINDATA = String(dataStart);
		kw.$ENDDATA = String(dataStart + dataBytes.length - 1);
		text = enc(kw);
		dataStart = headerLen + text.length;
	}
	const textEnd = headerLen + text.length - 1;
	const dataEnd = dataStart + dataBytes.length - 1;
	const pad = (n: number) => String(n).padStart(8, " ");
	const useHdr = opts.useHeaderOffsets ?? true;
	const header =
		version.padEnd(10, " ") +
		pad(headerLen) +
		pad(textEnd) +
		(useHdr ? pad(dataStart) + pad(dataEnd) : pad(0) + pad(0)) +
		pad(0) +
		pad(0);

	const out = new Uint8Array(headerLen + text.length + dataBytes.length);
	out.set(new TextEncoder().encode(header), 0);
	out.set(new TextEncoder().encode(text), headerLen);
	out.set(dataBytes, dataStart);
	return out.buffer;
}

const rows = [
	[1.5, 2.25, 3],
	[4, 5.5, 6],
	[7, 8, 9.75],
];

describe("synthetic FCS", () => {
	it("float big-endian 3.0", () => {
		const f = readFcs(build(rows));
		expect(f.version).toBe("FCS3.0");
		expect(f.eventCount).toBe(3);
		expect(Array.from(f.data)).toEqual(rows.flat());
	});

	it("float little-endian 3.1", () => {
		const f = readFcs(build(rows, { version: "FCS3.1", byteord: "1,2,3,4" }));
		expect(Array.from(f.data)).toEqual(rows.flat());
	});

	it("double", () => {
		const f = readFcs(build(rows, { datatype: "D" }));
		expect(Array.from(f.data)).toEqual(rows.flat());
	});

	it("integer mixed widths, FCS2.0", () => {
		const irows = [
			[1, 300, 70000],
			[255, 65535, 16777216],
		];
		const f = readFcs(build(irows, { version: "FCS2.0", datatype: "I", bits: [8, 16, 32] }));
		expect(Array.from(f.data)).toEqual(irows.flat());
	});

	it("integer values are masked to $PnR", () => {
		const f = readFcs(
			build([[0xffff]], {
				datatype: "I",
				bits: [16],
				extraKeywords: { $P1R: "1024" },
			}),
		);
		expect(f.data[0]).toBe(1023);
	});

	it("uses $BEGINDATA/$ENDDATA when header offsets are zero", () => {
		const f = readFcs(build(rows, { useHeaderOffsets: false }));
		expect(Array.from(f.data)).toEqual(rows.flat());
	});

	it("handles escaped delimiters and alternative delimiter", () => {
		const f = readFcs(
			build(rows, { delim: "|", extraKeywords: { $P1S: "CD3 a|b", $CYT: "Aurora" } }),
		);
		expect(f.channels[0]?.stain).toBe("CD3 a|b");
		expect(f.keywords.$CYT).toBe("Aurora");
	});

	it("keywords are case-insensitive", () => {
		const kw = parseText(new TextEncoder().encode("/$tot/5/$Par/2/"));
		expect(kw.$TOT).toBe("5");
		expect(kw.$PAR).toBe("2");
	});

	it("parses $SPILLOVER", () => {
		const s = parseSpill({ $SPILLOVER: "2,A,B,1,0.1,0.2,1" });
		expect(s?.channels).toEqual(["A", "B"]);
		expect(Array.from(s?.matrix ?? [])).toEqual([1, 0.1, 0.2, 1]);
		expect(s?.source).toBe("$SPILLOVER");
		expect(parseSpill({})).toBeUndefined();
		expect(() => parseSpill({ SPILL: "2,A,B,1" })).toThrow(FcsError);
	});

	it("rejects non-FCS input", () => {
		expect(() => readFcs(new ArrayBuffer(10))).toThrow(FcsError);
		expect(() => readFcs(new TextEncoder().encode("X".repeat(100)).buffer)).toThrow(/not an FCS/);
	});

	it("headerOnly skips data", () => {
		const f = readFcs(build(rows), { headerOnly: true });
		expect(f.eventCount).toBe(3);
		expect(f.data.length).toBe(0);
	});

	it("truncated data reads available events", () => {
		const full = build(rows);
		const f = readFcs(full.slice(0, full.byteLength - 12));
		expect(f.eventCount).toBe(2);
	});
});
