import { describe, expect, it } from "vitest";
import {
	AnalysisError,
	boundedJson,
	type OperationArgs,
	type OperationName,
	operationSchemas,
	validateOperation,
} from "../src/contracts.js";

describe("operation contracts", () => {
	const valid: { [N in OperationName]: OperationArgs<N> } = {
		list_capabilities: {},
		import_fcs: { path: "relative/sample.fcs" },
		list_samples: { offset: 0, limit: 100 },
		inspect_fcs: { sampleId: "a".repeat(64), channelOffset: 0, channelLimit: 100 },
		get_spillover: { sampleId: "sample" },
		preview_fcs: {
			sampleId: "sample",
			channels: ["A"],
			limit: 100,
			offset: 0,
			compensationId: "matrix",
		},
		register_compensation: { sampleId: "sample", spillover: { channels: ["A"], matrix: [1] } },
		start_fcs_export: {
			sampleId: "sample",
			compensationId: "matrix",
			channels: ["A"],
			renameChannels: { A: "B" },
			keywords: { note: "test" },
			startEvent: 0,
			eventCount: 0,
			outputName: "result.fcs",
		},
		get_job: { jobId: "job" },
		cancel_job: { jobId: "job" },
		get_receipt: { jobId: "job" },
	};
	it.each(Object.keys(valid) as OperationName[])(
		"validates %s and rejects unknown fields",
		(name) => {
			expect(validateOperation(name, valid[name])).toEqual(valid[name]);
			expect(() => validateOperation(name, { ...valid[name], unknown: true })).toThrow(
				AnalysisError,
			);
			expect(() => validateOperation(name, null)).toThrow(AnalysisError);
		},
	);
	it("retains backend ownership of filesystem and numerical validation", () => {
		// Schemas do not authorize paths or infer whether a matrix has a valid inverse.
		expect(operationSchemas.import_fcs.parse({ path: "../outside.fcs" })).toEqual({
			path: "../outside.fcs",
		});
		expect(operationSchemas.register_compensation.parse({ sampleId: "s" })).toEqual({
			sampleId: "s",
		});
		expect(
			operationSchemas.register_compensation.safeParse({
				sampleId: "s",
				spillover: { channels: ["A"], matrix: [0] },
			}).success,
		).toBe(true);
	});
	it("enforces page/channel bounds, strict nested metadata, integer indices and finite coefficients", () => {
		const invalid: [OperationName, unknown][] = [
			["list_samples", { offset: -1 }],
			["list_samples", { offset: 0.5 }],
			["list_samples", { limit: 0 }],
			["inspect_fcs", { sampleId: "s", channelLimit: 101 }],
			["preview_fcs", { sampleId: "s", channels: Array(33).fill("A") }],
			["register_compensation", { sampleId: "s", spillover: { channels: [], matrix: [] } }],
			["register_compensation", { sampleId: "s", spillover: { channels: ["A"], matrix: [NaN] } }],
			[
				"register_compensation",
				{ sampleId: "s", spillover: { channels: ["A"], matrix: [1], other: true } },
			],
			["start_fcs_export", { sampleId: "s", channels: [] }],
			["start_fcs_export", { sampleId: "s", eventCount: -1 }],
		];
		expect(invalid.map(([name, args]) => operationSchemas[name].safeParse(args).success)).toEqual(
			invalid.map(() => false),
		);
	});
	it("bounds escaping, traversal and nesting and preserves JSON omission semantics", () => {
		expect(boundedJson({ undefined: undefined, finite: 3, text: '\n"' })).toBe(
			JSON.stringify({ finite: 3, text: '\n"' }),
		);
		expect(() => boundedJson("\n".repeat(30), 40)).toThrow(AnalysisError);
		expect(() => boundedJson(Array(50001).fill(null))).toThrow(AnalysisError);
		let deep: unknown = null;
		for (let i = 0; i < 66; i++) deep = { next: deep };
		expect(() => boundedJson(deep)).toThrow(AnalysisError);
	});
});
