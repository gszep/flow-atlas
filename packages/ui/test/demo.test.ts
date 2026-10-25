import { readFcs } from "@flow-atlas/fcs";
import { table } from "@flow-atlas/transforms";
import { readWsp } from "@flow-atlas/wsp";
import { describe, expect, it } from "vitest";
import { createSyntheticDemoFiles, DEMO_EMBED_OPTIONS, DEMO_EVENT_COUNT } from "../src/demo.js";

describe("browser synthetic demo fixture (no GPU)", () => {
	it("encodes deterministic FCS/WSP files with valid biex metadata and three separated synthetic populations", async () => {
		const files = await createSyntheticDemoFiles();
		const repeated = await createSyntheticDemoFiles();
		expect(files.map((file) => file.name)).toEqual([
			"flow-atlas-synthetic.fcs",
			"flow-atlas-synthetic.wsp",
		]);
		const bytes = await (files[0] as File).arrayBuffer();
		expect(new Uint8Array(bytes)).toEqual(
			new Uint8Array(await (repeated[0] as File).arrayBuffer()),
		);
		const text = await (files[1] as File).text();
		expect(text).toBe(await (repeated[1] as File).text());
		const fcs = readFcs(bytes);
		const wsp = readWsp(text);
		const sample = wsp.samples[0];
		expect(fcs.version).toBe("FCS3.1");
		expect(fcs.eventCount).toBe(DEMO_EVENT_COUNT);
		expect(fcs.eventCount).toBeLessThanOrEqual(4096);
		expect(fcs.channels.map(({ name }) => name)).toEqual(["Marker A", "Marker B", "Marker C"]);
		expect(sample?.basename).toBe(files[0]?.name);
		expect(sample?.gates.map(({ name }) => name)).toEqual([
			"Synthetic population A",
			"Synthetic population B",
			"Synthetic population C",
		]);
		expect(Object.values(sample?.transforms ?? {}).map((spec) => spec.type)).toEqual([
			"biex",
			"biex",
			"biex",
		]);
		const tables = Object.values(sample?.transforms ?? {}).map((spec) => table(spec));
		expect(
			tables.every((transform) => transform.x.length > 1 && transform.x.every(Number.isFinite)),
		).toBe(true);
		const counts = [0, 0, 0];
		let invalidRows = 0;
		for (let row = 0; row < fcs.eventCount; row++) {
			let selected = 0;
			for (let channel = 0; channel < 3; channel++) {
				const value = fcs.data[row * 3 + channel] as number;
				if (!Number.isFinite(value)) invalidRows++;
				if (value >= 20000 && value <= 100000) {
					counts[channel] = (counts[channel] as number) + 1;
					selected++;
				}
			}
			if (selected !== 1) invalidRows++;
		}
		expect({ counts, invalidRows }).toEqual({ counts: [1024, 1024, 1024], invalidRows: 0 });
		expect(DEMO_EMBED_OPTIONS).toMatchObject({ xdim: 8, ydim: 8, epochs: 5, trainMax: 4096 });
	});
});
