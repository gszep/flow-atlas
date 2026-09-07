/**
 * Parity: GPU gating vs FlowJo's recorded population counts across the whole oracle workspace.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFcs } from "@flow-atlas/fcs";
import { type Table, table } from "@flow-atlas/transforms";
import { readWsp } from "@flow-atlas/wsp";
import { afterAll, describe, expect, it } from "vitest";
import { createStorage, upload } from "../src/buffers.js";
import { gateSample } from "../src/gating.js";
import { Kernels } from "../src/kernels.js";
import { transformColumn, uploadTable } from "../src/transform.js";
import { getDevice, releaseDevice } from "./setup.js";

const ORACLE =
	process.env.FLOW_ATLAS_ORACLE ?? join(homedir(), "Documents/repos/FlowAtlas.jl/data");
const WSP = join(ORACLE, "workspace.wsp");

function findFcs(dir: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (d: string) => {
		for (const e of readdirSync(d)) {
			const p = join(d, e);
			if (statSync(p).isDirectory()) walk(p);
			else if (e.toLowerCase().endsWith(".fcs")) out.set(e, p);
		}
	};
	if (existsSync(dir)) walk(dir);
	return out;
}

afterAll(() => releaseDevice());

describe.skipIf(!existsSync(WSP))("gating parity vs FlowJo counts", () => {
	it("all 1067 gates within tolerance", async () => {
		const { device, limits } = await getDevice();
		const k = new Kernels(device);
		const ws = readWsp(readFileSync(WSP, "utf8"));
		const files = findFcs(ORACLE);
		const tableCache = new Map<string, Table>();
		const gpuTableCache = new Map<string, ReturnType<typeof uploadTable>>();

		let total = 0;
		let exact = 0;
		let within1pct = 0;
		const worst: Array<{ sample: string; gate: string; got: number; want: number }> = [];
		let skipped = 0;
		const t0 = performance.now();
		const julia = JSON.parse(
			readFileSync(join(import.meta.dirname, "../../../fixtures/labels-390C_tLN_023.json"), "utf8"),
		) as { sample: string; counts: Record<string, number> };
		const juliaMismatch: string[] = [];

		for (const s of ws.samples) {
			const path = files.get(s.basename);
			if (!path) throw new Error(`missing FCS ${s.basename}`);
			const b = readFileSync(path);
			const f = readFcs(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
			expect(f.eventCount).toBe(s.eventCount);

			const columns = new Map<string, { buffer: GPUBuffer; offset: number }>();
			const tables = new Map<string, Table>();
			const par = f.channels.length;
			const usedDims = new Set(s.gates.flatMap((g) => g.dimensions));
			for (let p = 0; p < par; p++) {
				const ch = f.channels[p];
				if (!ch || !usedDims.has(ch.name)) continue;
				const col = new Float32Array(f.eventCount);
				for (let i = 0; i < f.eventCount; i++) col[i] = f.data[i * par + p] as number;
				const raw = upload(device, col);
				const spec = s.transforms[ch.name];
				if (spec) {
					const key = JSON.stringify(spec);
					let t = tableCache.get(key);
					if (!t) {
						t = table(spec);
						tableCache.set(key, t);
					}
					let gt = gpuTableCache.get(key);
					if (!gt) {
						gt = uploadTable(device, t);
						gpuTableCache.set(key, gt);
					}
					tables.set(ch.name, t);
					const out = createStorage(device, f.eventCount * 4);
					transformColumn(k, gt, raw, out, f.eventCount, limits.maxStorageBufferBindingSize);
					raw.destroy();
					columns.set(ch.name, { buffer: out, offset: 0 });
				} else {
					columns.set(ch.name, { buffer: raw, offset: 0 });
				}
			}

			const r = await gateSample(
				k,
				s,
				{ columns, count: f.eventCount, tables },
				limits.maxStorageBufferBindingSize,
			);
			skipped += r.skipped.length;
			if (s.basename === julia.sample) {
				// FlowWorkspace.jl merges same-named gates with OR; here names are unique per sample.
				for (const c of r.counts) {
					const want = julia.counts[c.gate.name];
					if (want !== undefined && want !== c.count) {
						juliaMismatch.push(`${c.gate.name}: gpu=${c.count} julia=${want}`);
					}
				}
			}
			for (const c of r.counts) {
				total++;
				const want = c.expected ?? 0;
				const diff = Math.abs(c.count - want);
				if (diff === 0) exact++;
				const rel = want === 0 ? diff : diff / want;
				if (rel <= 0.01 || diff <= 2) within1pct++;
				else
					worst.push({
						sample: s.basename,
						gate: `${c.gate.name} [${c.gate.geometry.type} ${c.gate.dimensions.map((d) => s.transforms[d]?.type ?? "raw").join(",")} parent=${c.gate.parentId ? "y" : "n"}]`,
						got: c.count,
						want,
					});
			}
			for (const c of columns.values()) c.buffer.destroy();
		}
		const ms = performance.now() - t0;
		worst.sort(
			(a, b) => Math.abs(b.got - b.want) / (b.want || 1) - Math.abs(a.got - a.want) / (a.want || 1),
		);
		console.log(
			`gates=${total} exact=${exact} within1%=${within1pct} skipped=${skipped} in ${ms.toFixed(0)}ms`,
		);
		if (worst.length) {
			console.log("worst:", worst.slice(0, 15));
			const over = worst.filter((w) => w.got > w.want).length;
			console.log(`over=${over} under=${worst.length - over}`);
		}
		expect(total).toBe(1067);
		expect(skipped).toBe(0);
		// Exact parity with FlowAtlas.jl/FlowWorkspace.jl (the Phase 1 oracle).
		expect(juliaMismatch).toEqual([]);
		// FlowJo's own counts differ by up to ~5% on polygon gates near the biex zero region — this is
		// inherited from the FlowKit biex approximation and shared with the Julia oracle.
		expect(within1pct / total).toBeGreaterThan(0.85);
		const over = worst.filter((w) => Math.abs(w.got - w.want) / (w.want || 1) > 0.1);
		expect(over).toEqual([]);
		// Julia parity is exact; report the FlowJo-relative statistics for the record.
		expect(exact).toBeGreaterThan(300);
	}, 120_000);
});
