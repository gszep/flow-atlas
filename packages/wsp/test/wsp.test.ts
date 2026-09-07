import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attr, gateTree, leafGates, parseXml, readWsp } from "../src/index.js";

const ORACLE =
	process.env.FLOW_ATLAS_ORACLE ?? join(homedir(), "Documents/repos/FlowAtlas.jl/data");
const WSP = join(ORACLE, "workspace.wsp");

describe("xml", () => {
	it("parses namespaces, entities, CDATA, comments, self-closing", () => {
		const d = parseXml(
			`<?xml version="1.0"?><!-- c --><a:root x="1" ns:y="a&amp;b"><k/><t><![CDATA[<raw>]]>&#65;&#x42;</t></a:root>`,
		);
		const root = d.children[0];
		expect(root?.name).toBe("a:root");
		expect(attr(root as never, "y")).toBe("a&b");
		expect(root?.children.map((c) => c.name)).toEqual(["k", "t"]);
		expect(root?.children[1]?.text).toBe("<raw>AB");
	});
	it("rejects mismatched tags", () => {
		expect(() => parseXml("<a><b></a>")).toThrow(/mismatched/);
	});
});

describe.skipIf(!existsSync(WSP))("oracle workspace.wsp", () => {
	const ws = readWsp(readFileSync(WSP, "utf8"));

	it("workspace metadata", () => {
		expect(ws.version).toBe("20.0");
		expect(ws.flowJoVersion).toBe("10.7.1");
		expect(ws.samples.length).toBe(33);
		expect(new Set(ws.samples.map((s) => s.basename)).size).toBe(33);
	});

	it("groups: All Samples + 5 donors + 8 tissues + Compensation", () => {
		const names = ws.groups.map((g) => g.name).sort();
		expect(names).toContain("All Samples");
		expect(names).toContain("390C");
		expect(names).toContain("Spleen");
		expect(names).toContain("Compensation");
		expect(ws.groups.find((g) => g.name === "All Samples")?.sampleIds.length).toBe(33);
	});

	it("samples: channels from keywords, biex transforms on FJComp channels", () => {
		for (const s of ws.samples) {
			// 27 samples have 19 params; 6 (donor 403C) have 18
			expect([18, 19]).toContain(s.channels.length);
			expect(s.eventCount).toBeGreaterThan(0);
			for (const c of s.channels) {
				const t = s.transforms[c.name];
				if (c.name.startsWith("FJComp-")) {
					expect(t?.type).toBe("biex");
					if (t?.type === "biex") {
						// widths vary per channel: -100, -79.4, -50.1, -31.6; pos 3.4..4.42
						expect(t.width as number).toBeLessThan(0);
						expect(t.neg).toBe(0);
						expect(t.maxRange as number).toBeGreaterThan(0);
					}
				}
			}
		}
	});

	it("gates: 1067 total, polygon/rectangle only, dims resolve to channels, raw-space vertices", () => {
		const all = ws.samples.flatMap((s) => s.gates);
		expect(all.length).toBe(1067);
		const types = new Set(all.map((g) => g.geometry.type));
		expect([...types].sort()).toEqual(["polygon", "rectangle"]);
		for (const s of ws.samples) {
			const names = new Set(s.channels.map((c) => c.name));
			for (const g of s.gates) {
				expect(g.id).toMatch(/^ID/);
				expect(g.count).not.toBeNull();
				for (const d of g.dimensions) expect(names.has(d)).toBe(true);
				if (g.geometry.type === "polygon") {
					expect(g.dimensions.length).toBe(2);
					expect(g.geometry.vertices.length).toBeGreaterThanOrEqual(3);
					for (const [x, y] of g.geometry.vertices) {
						expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
						// raw space: FlowJo channel values, not 0..4096
						expect(Math.abs(x)).toBeLessThan(3e5);
					}
				}
			}
		}
	});

	it("gate tree is a forest with correct parent links and monotone counts", () => {
		const s = ws.samples.find((x) => x.basename === "423_Donor_BM_028.fcs");
		expect(s).toBeDefined();
		if (!s) return;
		const roots = gateTree(s);
		expect(roots.map((r) => r.name)).toEqual(["B cells", "non-B"]);
		const nonB = roots[1];
		expect(nonB?.children.map((c) => c.name)).toEqual(["T cells"]);
		const walk = (g: (typeof roots)[number], parentCount: number) => {
			expect(g.count as number).toBeLessThanOrEqual(parentCount);
			for (const c of g.children) walk(c as never, g.count as number);
		};
		for (const r of roots) walk(r, s.eventCount as number);
		expect(leafGates(s).length).toBeGreaterThan(5);
	});

	it("33 distinct population names across workspace", () => {
		const names = new Set(ws.samples.flatMap((s) => s.gates.map((g) => g.name)));
		expect(names.size).toBe(33);
	});
});
