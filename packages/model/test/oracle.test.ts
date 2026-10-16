import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readWsp } from "@flow-atlas/wsp";
import { expect, it } from "vitest";
import {
	createWorkspace,
	parseWorkspace,
	type RawGeometry,
	serializeWorkspace,
} from "../src/index.js";

const oracle =
	process.env.FLOW_ATLAS_ORACLE ?? join(homedir(), "Documents/repos/FlowAtlas.jl/data");
const wspPath = join(oracle, "workspace.wsp");

it.skipIf(!existsSync(wspPath))(
	"persists a definition-only projection of the oracle without numerical results",
	async () => {
		// Test-only projection, not a shipped WSP importer. Hash bytes sequentially; never parse events.
		const wsp = readWsp(readFileSync(wspPath, "utf8"));
		const paths = new Map(
			readdirSync(oracle, { recursive: true, encoding: "utf8" })
				.filter((path) => path.endsWith(".fcs"))
				.map((path) => [basename(path), join(oracle, path)]),
		);
		const document = createWorkspace("oracle-projection");
		for (const sample of wsp.samples) {
			const path = paths.get(sample.basename);
			if (!path) throw new Error(`Oracle sample missing: ${sample.basename}`);
			const hash = createHash("sha256");
			for await (const chunk of createReadStream(path)) hash.update(chunk);
			document.samples.push({
				id: sample.id,
				file: { sha256: hash.digest("hex"), basename: sample.basename, size: statSync(path).size },
				channels: sample.channels.map((channel) => ({
					id: channel.name,
					name: channel.name,
					...(sample.transforms[channel.name]
						? { transform: sample.transforms[channel.name] }
						: {}),
				})),
			});
			for (const gate of sample.gates) {
				let geometry: RawGeometry;
				if (gate.geometry.type === "rectangle") {
					geometry = {
						type: "rectangle",
						min: gate.geometry.min.map((v) => (v === Number.NEGATIVE_INFINITY ? null : v)),
						max: gate.geometry.max.map((v) => (v === Number.POSITIVE_INFINITY ? null : v)),
					};
				} else if (gate.geometry.type === "polygon") geometry = gate.geometry;
				else throw new Error(`Unexpected oracle geometry ${gate.geometry.type}`);
				document.gates.push({
					id: `${sample.id}/${gate.id}`,
					sampleId: sample.id,
					name: gate.name,
					parentId: gate.parentId === null ? null : `${sample.id}/${gate.parentId}`,
					dimensions: gate.dimensions,
					geometry,
				});
			}
		}
		document.groups = wsp.groups.map((group, i) => ({
			id: `group-${i}`,
			name: group.name,
			// WSP parser exposes repeated membership refs; model membership is a set.
			sampleIds: [...new Set(group.sampleIds)],
		}));
		const json = serializeWorkspace(document);
		expect(parseWorkspace(json)).toEqual(document);
		expect(serializeWorkspace(parseWorkspace(json))).toBe(json);
		expect(document.samples).toHaveLength(33);
		expect(document.gates).toHaveLength(1067);
		expect(json).not.toMatch(/"(?:data|count|eventCount|events|keywords)":/);
	},
	30_000,
);
