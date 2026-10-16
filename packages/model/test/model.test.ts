import { describe, expect, it } from "vitest";
import {
	applyTransaction,
	createWorkspace,
	type GateDefinition,
	type GateOperation,
	inspectWorkspace,
	ModelError,
	parseWorkspace,
	serializeWorkspace,
	type Transaction,
	validateWorkspace,
	type WorkspaceDocument,
} from "../src/index.js";

function workspace(): WorkspaceDocument {
	return {
		...createWorkspace("workspace"),
		samples: [
			{
				id: "sample",
				file: { sha256: "a".repeat(64), basename: "sample.fcs", size: 100 },
				channels: [
					{ id: "x", name: "FSC-A", transform: { type: "linear", gain: 2 } },
					{ id: "y", name: "SSC-A" },
				],
			},
		],
		groups: [{ id: "group", name: "All", sampleIds: ["sample"] }],
	};
}

function gate(id = "gate", parentId: string | null = null): GateDefinition {
	return {
		id,
		name: id,
		sampleId: "sample",
		parentId,
		dimensions: ["x"],
		geometry: { type: "rectangle", min: [null], max: [10] },
	};
}

function tx(operations: GateOperation[], expectedRevision = 0): Transaction {
	return { agentId: "test-agent", expectedRevision, operations };
}

function at<T>(items: T[], index: number): T {
	const item = items[index];
	if (item === undefined) throw new Error(`Missing test item ${index}`);
	return item;
}

function rejects(code: ModelError["code"], run: () => unknown) {
	expect(run).toThrowError(ModelError);
	expect(run).toThrowError(expect.objectContaining({ code }));
}

function dag(): WorkspaceDocument {
	const document = workspace();
	document.gates = [
		gate("root"),
		gate("child", "root"),
		{
			...gate("boolean"),
			dimensions: [],
			geometry: { type: "boolean", op: "not", refs: ["child"] },
		},
	];
	document.annotations = [{ id: "note", gateId: "boolean", text: "Review this population" }];
	return document;
}

describe("workspace definitions", () => {
	it("rejects malformed JSON and hostile discriminator shapes with model errors", () => {
		rejects("INVALID_DOCUMENT", () => parseWorkspace("{"));
		rejects("UNSUPPORTED_CAPABILITY", () =>
			validateWorkspace({
				...workspace(),
				gates: [{ ...gate(), geometry: { type: { toString: null } } }],
			}),
		);
		const extended = Array(1);
		Object.defineProperty(extended, "4294967295", { enumerable: true, value: "x" });
		rejects("INVALID_DOCUMENT", () => validateWorkspace({ ...workspace(), samples: extended }));
	});

	it("validates deep DAGs without recursive graph traversal", () => {
		const document = workspace();
		document.gates = Array.from({ length: 1500 }, (_, i) =>
			gate(`g${i}`, i === 0 ? null : `g${i - 1}`),
		);
		expect(() => validateWorkspace(document)).not.toThrow();
		const deleted = applyTransaction(
			document,
			tx([{ type: "deleteGate", id: "g0", mode: "cascade" }]),
		);
		expect(deleted.invalidatedGateIds).toHaveLength(1500);
		expect(deleted.document.gates).toEqual([]);
	});

	it("roundtrips canonically, preserves raw unbounded geometry and differing sample panels", () => {
		const document = dag();
		document.samples.push({
			id: "other",
			file: { sha256: "b".repeat(64), basename: "other.fcs", size: 123 },
			channels: [{ id: "x", name: "FSC-A", transform: { type: "biex", width: -50.1 } }],
		});
		const json = serializeWorkspace(document);
		expect(parseWorkspace(json)).toEqual(document);
		expect(serializeWorkspace(parseWorkspace(json))).toBe(json);
		expect(
			serializeWorkspace({
				...document,
				samples: document.samples.map((s) => ({ channels: s.channels, file: s.file, id: s.id })),
			}),
		).toBe(json);
	});

	it("supports polygon definitions without computing numerical results", () => {
		const polygon: GateDefinition = {
			...gate(),
			dimensions: ["x", "y"],
			geometry: {
				type: "polygon",
				vertices: [
					[0, 0],
					[1, 0],
					[1, 1],
				],
			},
		};
		const result = applyTransaction(workspace(), tx([{ type: "addGate", gate: polygon }]));
		expect(result.document.gates[0]?.geometry).toEqual(polygon.geometry);
		expect(inspectWorkspace(result.document).capabilities.compute).toBe(false);
	});

	it.each(["data", "events", "embeddings", "masks", "results", "histograms", "labels"])(
		"rejects %s at document, sample, gate, and operation ingress",
		(field) => {
			const document = dag();
			const payload = [1, 2, 3];
			rejects("INVALID_DOCUMENT", () => validateWorkspace({ ...document, [field]: payload }));
			rejects("INVALID_DOCUMENT", () =>
				validateWorkspace({ ...document, samples: [{ ...document.samples[0], [field]: payload }] }),
			);
			rejects("INVALID_DOCUMENT", () =>
				validateWorkspace({ ...document, gates: [{ ...gate(), [field]: payload }] }),
			);
			rejects("INVALID_DOCUMENT", () =>
				applyTransaction(
					workspace(),
					tx([{ type: "addGate", gate: { ...gate(), [field]: payload } }]),
				),
			);
		},
	);

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0])(
		"rejects lossy numeric value %s before JSON serialization",
		(number) => {
			const document = workspace();
			document.gates = [{ ...gate(), geometry: { type: "rectangle", min: [number], max: [null] } }];
			rejects("INVALID_DOCUMENT", () => serializeWorkspace(document));
		},
	);

	it("rejects non-JSON values, sparse arrays, accessors, and cycles without invoking getters", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		let invoked = false;
		const accessor = Object.defineProperty({}, "samples", {
			enumerable: true,
			get() {
				invoked = true;
				return [];
			},
		});
		const values = [
			undefined,
			new Float32Array([1]),
			new Date(),
			1n,
			() => 1,
			Symbol("x"),
			cyclic,
			Array(1),
			accessor,
		];
		expect(
			values.map((value) => {
				try {
					validateWorkspace({ ...workspace(), samples: value });
					return false;
				} catch (error) {
					return error instanceof ModelError;
				}
			}),
		).toEqual(values.map(() => true));
		expect(invoked).toBe(false);
	});

	it("rejects missing references and cross-sample references", () => {
		const document = workspace();
		document.gates = [gate("child", "missing")];
		rejects("MISSING_REFERENCE", () => validateWorkspace(document));
		document.gates = [{ ...gate(), dimensions: ["absent"] }];
		rejects("MISSING_REFERENCE", () => validateWorkspace(document));
		document.gates = [{ ...gate(), sampleId: "missing" }];
		rejects("MISSING_REFERENCE", () => validateWorkspace(document));
		document.gates = [];
		at(document.groups, 0).sampleIds = ["missing"];
		rejects("MISSING_REFERENCE", () => validateWorkspace(document));
		const cross = dag();
		cross.samples.push({ ...at(cross.samples, 0), id: "other" });
		at(cross.gates, 1).sampleId = "other";
		rejects("INVALID_DOCUMENT", () => validateWorkspace(cross));
	});

	it("rejects duplicate IDs, reversed bounds, invalid shapes and incomplete human stamps", () => {
		const base = gate();
		const invalidGates = [
			[base, base],
			[{ ...base, geometry: { type: "rectangle", min: [20], max: [10] } }],
			[{ ...base, geometry: { type: "rectangle", min: [], max: [] } }],
			[
				{
					...base,
					geometry: {
						type: "polygon",
						vertices: [
							[0, 0],
							[1, 1],
						],
					},
				},
			],
			[{ ...base, author: "human" }],
			[{ ...base, dimensions: [], geometry: { type: "boolean", op: "not", refs: [] } }],
		];
		expect(
			invalidGates.map((gates) => {
				try {
					validateWorkspace({ ...workspace(), gates });
					return false;
				} catch (error) {
					return error instanceof ModelError;
				}
			}),
		).toEqual(invalidGates.map(() => true));
	});

	it("returns explicit unsupported capability errors", () => {
		rejects("UNSUPPORTED_CAPABILITY", () =>
			parseWorkspace(JSON.stringify({ ...workspace(), schemaVersion: 2 })),
		);
		rejects("UNSUPPORTED_CAPABILITY", () =>
			validateWorkspace({
				...workspace(),
				gates: [{ ...gate(), geometry: { type: "ellipsoid" } }],
			}),
		);
		rejects("UNSUPPORTED_CAPABILITY", () =>
			applyTransaction(workspace(), tx([{ type: "compute" } as unknown as GateOperation])),
		);
		const document = workspace();
		(at(document.samples, 0).channels[0] as unknown as Record<string, unknown>).transform = {
			type: "logicle",
		};
		rejects("UNSUPPORTED_CAPABILITY", () => validateWorkspace(document));
	});
});

describe("atomic agent transactions", () => {
	it("adds and updates gates, attributes agents, never generates human stamps or aliases inputs", () => {
		const document = workspace();
		const input = gate();
		const result = applyTransaction(document, tx([{ type: "addGate", gate: input }]));
		expect(document.gates).toEqual([]);
		expect(result.document.revision).toBe(1);
		expect(result.document.gates[0]).toEqual({
			...input,
			agentEdit: { agentId: "test-agent", revision: 1 },
		});
		expect(result.invalidatedGateIds).toEqual(["gate"]);
		input.dimensions.push("y");
		expect(result.document.gates[0]?.dimensions).toEqual(["x"]);
		const updated = applyTransaction(
			result.document,
			tx([{ type: "updateGate", id: "gate", changes: { name: "Renamed" } }], 1),
		);
		expect(updated.document.gates[0]?.name).toBe("Renamed");
		expect(updated.document.revision).toBe(2);
		expect(result.document.gates[0]?.name).toBe("gate");
		expect(updated.document.gates[0]).not.toHaveProperty("author");
		expect(updated.document.gates[0]).not.toHaveProperty("modified");
	});

	it("rejects whole batches atomically, including malformed updates", () => {
		const document = workspace();
		const before = serializeWorkspace(document);
		rejects("MISSING_REFERENCE", () =>
			applyTransaction(
				document,
				tx([
					{ type: "addGate", gate: gate() },
					{ type: "addGate", gate: gate("child", "missing") },
				]),
			),
		);
		rejects("INVALID_DOCUMENT", () =>
			applyTransaction(
				dag(),
				tx([
					{
						type: "updateGate",
						id: "root",
						changes: { geometry: { type: "rectangle", min: [50], max: [10] } },
					},
				]),
			),
		);
		expect(serializeWorkspace(document)).toBe(before);
	});

	it("checks stale revisions even on no-ops, and guards revision overflow", () => {
		rejects("REVISION_CONFLICT", () => applyTransaction(workspace(), tx([], 1)));
		const document = workspace();
		document.revision = Number.MAX_SAFE_INTEGER;
		rejects("INVALID_DOCUMENT", () =>
			applyTransaction(document, tx([{ type: "addGate", gate: gate() }], document.revision)),
		);
		expect(applyTransaction(document, tx([], document.revision)).changed).toBe(false);
	});

	it("does not bump revision or attribution for empty, identical, or net-zero edits", () => {
		const document = dag();
		expect(applyTransaction(document, tx([])).changed).toBe(false);
		const result = applyTransaction(
			document,
			tx([{ type: "updateGate", id: "root", changes: { name: "root" } }]),
		);
		expect(result.document).toEqual(document);
		expect(result.invalidatedGateIds).toEqual([]);
		expect(
			applyTransaction(
				workspace(),
				tx([
					{ type: "addGate", gate: gate() },
					{ type: "deleteGate", id: "gate", mode: "reject" },
				]),
			).document,
		).toEqual(workspace());
	});

	it("permits forward references but rejects parent, boolean and mixed cycles", () => {
		const result = applyTransaction(
			workspace(),
			tx([
				{ type: "addGate", gate: gate("child", "root") },
				{ type: "addGate", gate: gate("root") },
			]),
		);
		expect(result.document.gates).toHaveLength(2);
		rejects("CYCLE", () =>
			applyTransaction(
				dag(),
				tx([{ type: "updateGate", id: "root", changes: { parentId: "child" } }]),
			),
		);
		rejects("CYCLE", () =>
			applyTransaction(
				dag(),
				tx([{ type: "updateGate", id: "root", changes: { parentId: "boolean" } }]),
			),
		);
		rejects("CYCLE", () =>
			applyTransaction(
				dag(),
				tx([
					{
						type: "updateGate",
						id: "boolean",
						changes: { geometry: { type: "boolean", op: "not", refs: ["boolean"] } },
					},
				]),
			),
		);
	});

	it("rejects dependent deletion by default and cascades descendants, boolean dependents, and annotations explicitly", () => {
		const document = dag();
		rejects("DEPENDENTS_EXIST", () =>
			applyTransaction(document, tx([{ type: "deleteGate", id: "root", mode: "reject" }])),
		);
		rejects("DEPENDENTS_EXIST", () =>
			applyTransaction(document, tx([{ type: "deleteGate", id: "boolean", mode: "reject" }])),
		);
		const result = applyTransaction(
			document,
			tx([{ type: "deleteGate", id: "root", mode: "cascade" }]),
		);
		expect(result.document.gates).toEqual([]);
		expect(result.document.annotations).toEqual([]);
		expect(result.invalidatedGateIds).toEqual(["boolean", "child", "root"]);
		expect(result.deletedAnnotationIds).toEqual(["note"]);
		expect(document.gates).toHaveLength(3);
	});

	it("protects human-finalized gates and annotations including indirectly affected dependents", () => {
		const document = dag();
		Object.assign(at(document.gates, 2), { author: "human", modified: "2026-10-17T00:00:00Z" });
		expect(parseWorkspace(serializeWorkspace(document))).toEqual(document);
		rejects("HUMAN_FINALIZED", () =>
			applyTransaction(document, tx([{ type: "deleteGate", id: "root", mode: "cascade" }])),
		);
		rejects("HUMAN_FINALIZED", () =>
			applyTransaction(
				document,
				tx([{ type: "updateGate", id: "root", changes: { name: "rename" } }]),
			),
		);
		rejects("HUMAN_FINALIZED", () =>
			applyTransaction(
				document,
				tx([{ type: "updateGate", id: "boolean", changes: { name: "rename" } }]),
			),
		);
		expect(
			applyTransaction(
				document,
				tx([{ type: "updateGate", id: "boolean", changes: { name: "boolean" } }]),
			).changed,
		).toBe(false);
		const annotated = dag();
		Object.assign(at(annotated.annotations, 0), {
			author: "human",
			modified: "2026-10-17T00:00:00Z",
		});
		rejects("HUMAN_FINALIZED", () =>
			applyTransaction(annotated, tx([{ type: "deleteGate", id: "root", mode: "cascade" }])),
		);
	});

	it("rejects finalized annotation deletion even when its gate is identically resurrected", () => {
		const document = workspace();
		const originalGateDefinition = gate("g");
		document.gates = [originalGateDefinition];
		document.annotations = [
			{ id: "a", gateId: "g", text: "Human final", author: "human", modified: "2026-10-17" },
		];
		const before = serializeWorkspace(document);
		rejects("HUMAN_FINALIZED", () =>
			applyTransaction(document, {
				expectedRevision: 0,
				agentId: "agent",
				operations: [
					{ type: "deleteGate", id: "g", mode: "cascade" },
					{ type: "addGate", gate: originalGateDefinition },
				],
			}),
		);
		expect(serializeWorkspace(document)).toBe(before);
		expect(document.revision).toBe(0);
		expect(document).not.toHaveProperty("agentEdit");
	});

	it("rejects finalized annotation deletion after resurrecting an entire dependency closure", () => {
		const document = dag();
		Object.assign(at(document.annotations, 0), { author: "human", modified: "2026-10-17" });
		const before = serializeWorkspace(document);
		rejects("HUMAN_FINALIZED", () =>
			applyTransaction(
				document,
				tx([
					{ type: "deleteGate", id: "root", mode: "cascade" },
					...document.gates.map((gate): GateOperation => ({ type: "addGate", gate })),
				]),
			),
		);
		expect(serializeWorkspace(document)).toBe(before);
		expect(document.revision).toBe(0);
	});

	it("rejects resurrecting a finalized dependent gate without its human stamps", () => {
		const document = dag();
		const definitions = document.gates.map((gate) => ({ ...gate }));
		Object.assign(at(document.gates, 2), { author: "human", modified: "2026-10-17" });
		const before = serializeWorkspace(document);
		rejects("HUMAN_FINALIZED", () =>
			applyTransaction(
				document,
				tx([
					{ type: "deleteGate", id: "root", mode: "cascade" },
					...definitions.map((gate): GateOperation => ({ type: "addGate", gate })),
				]),
			),
		);
		expect(serializeWorkspace(document)).toBe(before);
		expect(document.revision).toBe(0);
	});

	it("retains cascade deletion of an unstamped annotation when its gate is identically resurrected", () => {
		const document = workspace();
		const definition = gate("g");
		document.gates = [definition];
		document.annotations = [{ id: "a", gateId: "g", text: "Agent draft" }];
		const before = serializeWorkspace(document);
		const result = applyTransaction(
			document,
			tx([
				{ type: "deleteGate", id: "g", mode: "cascade" },
				{ type: "addGate", gate: definition },
			]),
		);
		expect(result.changed).toBe(true);
		expect(result.document.revision).toBe(1);
		expect(result.document.agentEdit).toEqual({ agentId: "test-agent", revision: 1 });
		expect(result.document.gates).toEqual([definition]);
		expect(result.document.annotations).toEqual([]);
		expect(result.deletedAnnotationIds).toEqual(["a"]);
		expect(result.invalidatedGateIds).toEqual([]);
		expect(serializeWorkspace(document)).toBe(before);
	});

	it("cannot forge or remove human stamps or agent attribution via operation payloads", () => {
		for (const field of ["author", "modified", "agentEdit"]) {
			rejects("INVALID_DOCUMENT", () =>
				applyTransaction(
					workspace(),
					tx([{ type: "addGate", gate: { ...gate(), [field]: "forged" } }]),
				),
			);
			rejects("INVALID_DOCUMENT", () =>
				applyTransaction(
					dag(),
					tx([{ type: "updateGate", id: "root", changes: { [field]: null } }]),
				),
			);
		}
	});

	it("reports invalidation without storing derived results or restamping unaffected definitions", () => {
		const result = applyTransaction(
			dag(),
			tx([
				{
					type: "updateGate",
					id: "root",
					changes: { geometry: { type: "rectangle", min: [1], max: [2] } },
				},
			]),
		);
		expect(result.invalidatedGateIds).toEqual(["boolean", "child", "root"]);
		expect(result.document.gates[1]).not.toHaveProperty("agentEdit");
		expect(result.document).not.toHaveProperty("invalidatedGateIds");
	});

	it("provides bounded inspection with deterministic pagination and no geometry", () => {
		const summary = inspectWorkspace(dag(), { limit: 2 });
		expect(summary.counts).toEqual({
			samples: 1,
			channels: 2,
			gates: 3,
			groups: 1,
			annotations: 1,
		});
		expect(summary.nextOffset).toBe(2);
		expect(summary.gates[0]).not.toHaveProperty("geometry");
		expect(inspectWorkspace(dag(), { offset: 2, limit: 2 }).nextOffset).toBeNull();
		rejects("INVALID_DOCUMENT", () => inspectWorkspace(dag(), { limit: 101 }));
	});
});
