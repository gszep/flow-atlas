import { expect, it } from "vitest";
import {
	biexTable,
	linearTable,
	logTable,
	table,
	UnsupportedTransformError,
	type UnsupportedTransformSpec,
} from "../src/index.js";

const spec: UnsupportedTransformSpec = {
	type: "unsupported",
	originalType: "logicle",
	element: "transforms:logicle",
	attributes: { "transforms:T": "262144", "transforms:W": "0.5", auto: "true" },
};

it("rejects unsupported table generation with inspectable metadata, including after JSON roundtrip", () => {
	const restored = JSON.parse(JSON.stringify(spec)) as UnsupportedTransformSpec;
	expect(() => table(restored)).toThrow(UnsupportedTransformError);
	expect(() => table(restored)).toThrowError(
		expect.objectContaining({
			name: "UnsupportedTransformError",
			code: "UNSUPPORTED_TRANSFORM",
			spec,
			context: {},
			message: expect.stringContaining('Unsupported transform "logicle"'),
		}),
	);
});

it("carries optional import context in structured fields and the displayed message", () => {
	const context = { sampleId: "42", sampleName: "Donor A", channel: "CD3-A" };
	const error = new UnsupportedTransformError(spec, context);
	expect(error.context).toEqual(context);
	expect(error.message).toContain('sample ID "42"');
	expect(error.message).toContain('sample "Donor A"');
	expect(error.message).toContain('channel "CD3-A"');
	expect(error.message).toContain("transforms:logicle");
});

it("keeps all supported table dispatch paths unchanged", () => {
	expect(table({ type: "linear", maxRange: 10, gain: 2 })).toEqual(
		linearTable({ maxRange: 10, gain: 2 }),
	);
	expect(table({ type: "log", maxRange: 10, offset: 2 })).toEqual(
		logTable({ maxRange: 10, offset: 2 }),
	);
	expect(table({ type: "biex", width: -100, pos: 3.8 })).toEqual(
		biexTable({ width: -100, pos: 3.8 }),
	);
});
