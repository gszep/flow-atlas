import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { column, openFcs, readFcs, readHeader } from "../src/index.js";

// Oracle dataset from FlowAtlas.jl (not committed). Tests skip when absent.
const ORACLE =
	process.env.FLOW_ATLAS_ORACLE ?? join(homedir(), "Documents/repos/FlowAtlas.jl/data");

function findFcs(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) out.push(...findFcs(p));
		else if (e.toLowerCase().endsWith(".fcs")) out.push(p);
	}
	return out.sort();
}

const files = findFcs(ORACLE);
const toArrayBuffer = (p: string): ArrayBuffer => {
	const b = readFileSync(p);
	return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

describe.skipIf(files.length === 0)("oracle FCS files", () => {
	it("finds the expected number of files", () => {
		expect(files.length).toBe(33);
	});

	it.each(files.map((f) => [f.slice(ORACLE.length + 1), f]))("reads %s", async (_, path) => {
		const buf = toArrayBuffer(path);
		const h = readHeader(buf);
		expect(h.version).toBe("FCS3.0");
		const f = readFcs(buf);
		expect(f.eventCount).toBe(Number(f.keywords.$TOT));
		expect(f.channels.length).toBe(Number(f.keywords.$PAR));
		expect(f.data.length).toBe(f.eventCount * f.channels.length);
		expect(f.spill).toBeUndefined(); // FlowJo-exported, already compensated

		// Every value finite. Note: compensated FlowJo exports legitimately exceed $PnR
		// (observed up to ~1.26e6 vs $PnR=262144 in 403C_donor_Lung_026), so no range assertion.
		let nonFinite = 0;
		for (let p = 0; p < f.channels.length; p++) {
			const col = column(f, p);
			for (let i = 0; i < col.length; i++) if (!Number.isFinite(col[i] as number)) nonFinite++;
		}
		expect(nonFinite).toBe(0);

		const handle = await open(path, "r");
		try {
			const reader = await openFcs({
				size: (await handle.stat()).size,
				async read(offset, length) {
					const bytes = new Uint8Array(length);
					const result = await handle.read(bytes, 0, length, offset);
					return bytes.subarray(0, result.bytesRead);
				},
			});
			expect(reader.metadata.eventCount).toBe(f.eventCount);
			let mismatches = 0;
			let received = 0;
			for await (const chunk of reader.chunks({ chunkEvents: 4093 })) {
				for (let i = 0; i < chunk.data.length; i++)
					if (chunk.data[i] !== f.data[chunk.start * f.channels.length + i]) mismatches++;
				received += chunk.count;
			}
			expect([mismatches, received]).toEqual([0, f.eventCount]);
		} finally {
			await handle.close();
		}
	});

	it("channel names are unique and stains present for fluorescence channels", () => {
		const f = readFcs(toArrayBuffer(files[0] as string), { headerOnly: true });
		const names = f.channels.map((c) => c.name);
		expect(new Set(names).size).toBe(names.length);
		for (const c of f.channels) if (c.name.startsWith("FJComp-")) expect(c.stain).toBeTruthy();
	});
});
