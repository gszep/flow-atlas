import { writeFcs } from "@flow-atlas/fcs";

export const DEMO_EVENT_COUNT = 3072;
export const DEMO_EMBED_OPTIONS = Object.freeze({
	xdim: 8,
	ydim: 8,
	epochs: 5,
	trainMax: 4096,
	seed: 20261025,
});

/** Seeded fixture generation, not a CPU implementation/fallback for any compute kernel. */
export async function createSyntheticDemoFiles(): Promise<File[]> {
	const names = ["Marker A", "Marker B", "Marker C"];
	const populations = [
		"Synthetic population A",
		"Synthetic population B",
		"Synthetic population C",
	];
	let state = 20261025;
	const random = () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 4294967296;
	};
	const data = new Float32Array(DEMO_EVENT_COUNT * names.length);
	for (let row = 0; row < DEMO_EVENT_COUNT; row++) {
		const population = row % 3;
		for (let channel = 0; channel < names.length; channel++) {
			// Bounded clouds with one high marker per population, interleaved in event order.
			let noise = -3;
			for (let draw = 0; draw < 6; draw++) noise += random();
			data[row * names.length + channel] =
				channel === population ? 60000 + noise * 5000 : 1800 + noise * 400;
		}
	}
	const channels = names.map((name, index) => ({
		index: index + 1,
		name,
		bits: 32,
		range: 262144,
		amplification: [0, 0] as [number, number],
		gain: 1,
	}));
	async function* chunks() {
		yield data;
	}
	const parts: ArrayBuffer[] = [];
	for await (const bytes of writeFcs(
		{
			version: "FCS3.1",
			eventCount: DEMO_EVENT_COUNT,
			channels,
			keywords: { FLOW_ATLAS_DEMO: "Synthetic illustration only; no biological validation" },
		},
		chunks(),
	))
		parts.push(Uint8Array.from(bytes).buffer);
	const filename = "flow-atlas-synthetic.fcs";
	const keywords: Record<string, string> = { $PAR: "3", $TOT: String(DEMO_EVENT_COUNT) };
	for (const channel of channels) {
		const prefix = `$P${channel.index}`;
		Object.assign(keywords, {
			[`${prefix}N`]: channel.name,
			[`${prefix}B`]: "32",
			[`${prefix}R`]: "262144",
			[`${prefix}E`]: "0,0",
			[`${prefix}G`]: "1",
		});
	}
	// All attributes below are fixed application-owned strings/numbers, not user XML.
	const wsp = `<?xml version="1.0" encoding="UTF-8"?>
<Workspace version="20.0" flowJoVersion="synthetic-demo"><SampleList><Sample>
<DataSet sampleID="synthetic" uri="file:/${filename}"/>
<Keywords>${Object.entries(keywords)
		.map(([name, value]) => `<Keyword name="${name}" value="${value}"/>`)
		.join("")}</Keywords>
<Transformations>${names.map((name) => `<biex width="-50" neg="0" pos="4.5" maxRange="262144" channelRange="4096" length="256"><parameter name="${name}"/></biex>`).join("")}</Transformations>
<SampleNode sampleID="synthetic" name="Synthetic demonstration" count="${DEMO_EVENT_COUNT}"><Subpopulations>
${populations.map((name, index) => `<Population name="${name}" count="1024"><Gate id="synthetic-${index}"><RectangleGate><dimension min="20000" max="100000"><fcs-dimension name="${names[index]}"/></dimension></RectangleGate></Gate></Population>`).join("")}
</Subpopulations></SampleNode></Sample></SampleList></Workspace>`;
	return [
		new File(parts, filename, { type: "application/octet-stream", lastModified: 0 }),
		new File([wsp], "flow-atlas-synthetic.wsp", { type: "application/xml", lastModified: 0 }),
	];
}
