import { table, UnsupportedTransformError } from "@flow-atlas/transforms";
import { expect, it } from "vitest";
import { readWsp } from "../src/index.js";

function workspace(transforms: string) {
	return readWsp(`<Workspace><SampleList><Sample>
		<DataSet sampleID="42" uri="sample.fcs"/>
		<Transformations>${transforms}</Transformations>
		<SampleNode sampleID="42" name="Donor A"/>
	</Sample></SampleList></Workspace>`);
}

it.each(["logicle", "hyperlog", "fasinh", "fatanh", "ArcSinh", "Logicle", "futureFamily"])(
	"preserves %s identity and string attributes without preventing metadata inspection",
	(family) => {
		const ws = workspace(`<tr:${family} tr:T="2.62144e5" tr:W="0.50" W="different"
			auto="true" label="a&amp;b" empty="" nonfinite="NaN" type="vendor">
			<data:parameter data:name="CD3-A"/>
		</tr:${family}>`);
		const expected = {
			type: "unsupported",
			originalType: family,
			element: `tr:${family}`,
			attributes: {
				"tr:T": "2.62144e5",
				"tr:W": "0.50",
				W: "different",
				auto: "true",
				label: "a&b",
				empty: "",
				nonfinite: "NaN",
				type: "vendor",
			},
		};
		const sample = ws.samples[0];
		expect(sample).toMatchObject({ id: "42", name: "Donor A", basename: "sample.fcs" });
		expect(sample?.transforms["CD3-A"]).toEqual(expected);
		expect(JSON.parse(JSON.stringify(ws))).toEqual(ws);
		const spec = sample?.transforms["CD3-A"];
		if (!spec) throw new Error("missing transform");
		expect(() => table(spec)).toThrow(UnsupportedTransformError);
	},
);

it("preserves supported imports beside unsupported and absent transforms", () => {
	const ws = workspace(`
		<tr:linear tr:minRange="-2" tr:maxRange="10" tr:gain="2"><parameter name="FSC"/></tr:linear>
		<tr:log tr:offset="2" tr:decades="3" tr:maxRange="20"><parameter name="SSC"/></tr:log>
		<tr:biex tr:width="-100" tr:neg="0" tr:pos="3.8" tr:maxRange="262144" tr:length="256"><parameter name="CD4"/></tr:biex>
		<hyperlog T="262144"><parameter name="CD3"/></hyperlog>`);
	expect(ws.samples[0]?.transforms).toEqual({
		FSC: { type: "linear", minRange: -2, maxRange: 10, gain: 2 },
		SSC: { type: "log", offset: 2, decades: 3, maxRange: 20 },
		CD4: { type: "biex", width: -100, neg: 0, pos: 3.8, maxRange: 262144, length: 256 },
		CD3: {
			type: "unsupported",
			originalType: "hyperlog",
			element: "hyperlog",
			attributes: { T: "262144" },
		},
	});
	expect(ws.samples[0]?.transforms.Time).toBeUndefined();
});
