import type { WspGate, WspSample } from "@flow-atlas/wsp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type BooleanOp, evaluateBooleanGate } from "../src/boolean.js";
import { createStorage, readback, upload } from "../src/buffers.js";
import { setLabelBit } from "../src/gate.js";
import { gateSample, orderGates } from "../src/gating.js";
import { Kernels } from "../src/kernels.js";
import { getDevice, releaseDevice } from "./setup.js";

afterAll(() => releaseDevice());

function boolean(
	id: string,
	op: BooleanOp,
	refs: string[],
	parentId: string | null = null,
): WspGate {
	return {
		id,
		name: id,
		parentId,
		count: null,
		dimensions: [],
		geometry: { type: "boolean", op, refs },
	};
}
function rectangle(id: string, min: number, max: number, parentId: string | null = null): WspGate {
	return {
		id,
		name: id,
		parentId,
		count: null,
		dimensions: ["x"],
		geometry: { type: "rectangle", min: [min], max: [max] },
	};
}
function sample(gates: WspGate[]): WspSample {
	return {
		id: "s",
		name: "s",
		uri: "",
		basename: "s.fcs",
		keywords: {},
		channels: [],
		transforms: {},
		eventCount: null,
		gates,
	};
}

describe("normalized combined gate DAG", () => {
	it("sorts later operands and ancestry, including repeated refs", () => {
		const gates = [
			boolean("b", "and", ["a", "a"], "p"),
			rectangle("a", 0, 1, "p"),
			rectangle("p", 0, 2),
		];
		expect(orderGates(gates).map((g) => g.id)).toEqual(["p", "a", "b"]);
	});
	it.each([
		["duplicate", [boolean("a", "and", []), boolean("a", "or", [])], /duplicate/],
		["dangling operand", [boolean("a", "or", ["missing"])], /Dangling dependency missing/],
		["dangling parent", [boolean("a", "and", [], "missing")], /Dangling dependency missing/],
		["self cycle", [boolean("a", "not", ["a"])], /cycle/],
		["ancestry cycle", [rectangle("a", 0, 1, "b"), rectangle("b", 0, 1, "a")], /cycle/],
		["reference cycle", [boolean("a", "not", ["b"]), boolean("b", "not", ["a"])], /cycle/],
		["mixed cycle", [boolean("a", "not", ["b"]), rectangle("b", 0, 1, "a")], /cycle/],
		["empty NOT", [boolean("a", "not", [])], /exactly one/],
		["multi NOT", [boolean("a", "not", ["b", "c"])], /exactly one/],
	] as const)("rejects %s", (_name, gates, error) => {
		expect(() => orderGates([...gates])).toThrow(error);
	});
	it("rejects malformed normalized Boolean operations", () => {
		const g = boolean("a", "or", []);
		Object.assign(g.geometry, { op: "xor" });
		expect(() => orderGates([g])).toThrow(/Unknown Boolean/);
		Object.assign(g.geometry, { op: "or", refs: null });
		expect(() => orderGates([g])).toThrow(/Invalid Boolean refs/);
	});
	it("handles deep ancestry without recursive stack overflow", () => {
		const gates = Array.from({ length: 20_000 }, (_, i) =>
			rectangle(`${i}`, 0, 1, i ? `${i - 1}` : null),
		);
		expect(orderGates(gates.reverse()).map((g) => g.id)).toEqual(
			Array.from({ length: gates.length }, (_, i) => `${i}`),
		);
	});
	it("gateSample rejects bad DAGs before touching the GPU", async () => {
		await expect(
			gateSample(
				{} as Kernels,
				sample([boolean("a", "not", ["a"])]),
				{ columns: new Map(), tables: new Map(), count: 1 },
				1024,
			),
		).rejects.toThrow(/cycle/);
	});
});

describe("Boolean GPU masks", () => {
	// Cold software-adapter startup has its own bound; kernel assertions keep their test timeout.
	beforeAll(async () => {
		await getDevice();
	}, 30_000);
	it("labels support unaligned three-word strides across windows", async () => {
		const { device } = await getDevice();
		const n = 333,
			offset = 63,
			words = 3;
		const k = new Kernels(device);
		const mask = upload(
			device,
			Uint32Array.from({ length: n }, (_, i) => Number(i % 3 === 0)),
		);
		const labels = createStorage(device, (offset + n + 1) * words * 4);
		device.pushErrorScope("validation");
		try {
			setLabelBit(k, mask, labels, offset, n, words, 65, 2048);
			const expected = new Uint32Array((offset + n + 1) * words);
			for (let i = 0; i < n; i += 3) expected[(offset + i) * words + 2] = 2;
			expect(await readback(device, labels, Uint32Array)).toEqual(expected);
			expect(await device.popErrorScope()).toBeNull();
		} finally {
			mask.destroy();
			labels.destroy();
		}
	});
	it("truth tables, empty identities, repeated operands and parent restriction over multiple windows", async () => {
		const { device } = await getDevice();
		const k = new Kernels(device);
		const n = 777;
		const a = Uint32Array.from({ length: n }, (_, i) => i & 1);
		const b = Uint32Array.from({ length: n }, (_, i) => (i >> 1) & 1);
		const p = Uint32Array.from({ length: n }, (_, i) => (i >> 2) & 1);
		const ab = upload(device, a),
			bb = upload(device, b),
			pb = upload(device, p);
		const cases: Array<{ op: BooleanOp; refs: GPUBuffer[]; ref: (i: number) => boolean }> = [
			{ op: "and", refs: [ab, bb], ref: (i) => !!a[i] && !!b[i] },
			{ op: "or", refs: [ab, bb], ref: (i) => !!a[i] || !!b[i] },
			{ op: "not", refs: [ab], ref: (i) => !a[i] },
			{ op: "and", refs: [], ref: () => true },
			{ op: "or", refs: [], ref: () => false },
			{ op: "and", refs: [ab, ab, ab], ref: (i) => !!a[i] },
			{ op: "and", refs: [ab, bb, pb], ref: (i) => !!a[i] && !!b[i] && !!p[i] },
			{ op: "or", refs: [ab, bb, pb], ref: (i) => !!a[i] || !!b[i] || !!p[i] },
			{ op: "or", refs: [ab], ref: (i) => !!a[i] },
		];
		const actual: number[][] = [],
			expected: number[][] = [];
		device.pushErrorScope("validation");
		try {
			for (const c of cases)
				for (const parent of [null, pb]) {
					const r = await evaluateBooleanGate(
						k,
						{ op: c.op, operands: c.refs, parent, count: n },
						1024,
					);
					try {
						const want = Array.from({ length: n }, (_, i) =>
							Number(c.ref(i) && (!parent || !!p[i])),
						);
						actual.push([r.count, ...(await readback(device, r.mask, Uint32Array))]);
						expected.push([want.reduce((s, v) => s + v, 0), ...want]);
					} finally {
						r.mask.destroy();
					}
				}
			expect(actual).toEqual(expected);
			expect(await device.popErrorScope()).toBeNull();
		} finally {
			ab.destroy();
			bb.destroy();
			pb.destroy();
		}
	});

	it("zero events return an owned empty mask; invalid arity/size rejects", async () => {
		const { device } = await getDevice();
		const k = new Kernels(device);
		const r = await evaluateBooleanGate(
			k,
			{ op: "and", operands: [], parent: null, count: 0 },
			1024,
		);
		expect(r.count).toBe(0);
		r.mask.destroy();
		await expect(
			evaluateBooleanGate(k, { op: "not", operands: [], parent: null, count: 1 }, 1024),
		).rejects.toThrow(/exactly one/);
		const tiny = createStorage(device, 4);
		try {
			await expect(
				evaluateBooleanGate(k, { op: "not", operands: [tiny], parent: null, count: 2 }, 1024),
			).rejects.toThrow(/shorter/);
		} finally {
			tiny.destroy();
		}
	});

	it("integrates later/non-leaf references, Boolean ancestry, unaligned columns and two-word labels", async () => {
		const { device } = await getDevice();
		const k = new Kernels(device);
		const n = 777,
			offset = 7;
		const x = upload(
			device,
			Float32Array.from({ length: n + offset }, (_, i) => (i - offset + 8) % 8),
		);
		const labels = createStorage(device, (n + offset + 3) * 8);
		const gates = [
			boolean("union", "or", ["a", "b"]),
			boolean("neg", "not", ["union"], "domain"),
			boolean("all", "and", ["a", "b"], "domain"),
			rectangle("child", 0, 7, "neg"),
			rectangle("a", 0, 3),
			rectangle("b", 2, 5),
			rectangle("a-child", 1, 2, "a"),
			rectangle("domain", 1, 6),
		];
		device.pushErrorScope("validation");
		const bindingSpy = vi.spyOn(device, "createBindGroup");
		try {
			const r = await gateSample(
				k,
				sample(gates),
				{ count: n, columns: new Map([["x", { buffer: x, offset }]]), tables: new Map() },
				1024,
				{
					keepMasks: true,
					labels: { buffer: labels, offset, words: 2 },
					populationBits: new Map([
						["union", 0],
						["all", 33],
						["child", 34],
					]),
				},
			);
			try {
				const predicates: Record<string, (v: number) => boolean> = {
					union: (v) => v <= 5,
					neg: (v) => v === 6,
					all: (v) => v === 2 || v === 3,
					child: (v) => v === 6,
					a: (v) => v <= 3,
					b: (v) => v >= 2 && v <= 5,
					"a-child": (v) => v === 1 || v === 2,
					domain: (v) => v >= 1 && v <= 6,
				};
				const expected = Object.fromEntries(
					Object.entries(predicates).map(([id, predicate]) => [
						id,
						Array.from({ length: n }, (_, i) => Number(predicate(i % 8))),
					]),
				);
				const actual = Object.fromEntries(
					await Promise.all(
						[...r.masks].map(async ([id, mask]) => [
							id,
							[...(await readback(device, mask, Uint32Array))],
						]),
					),
				);
				expect(actual).toEqual(expected);
				expect(Object.fromEntries(r.counts.map((c) => [c.gate.id, c.count]))).toEqual(
					Object.fromEntries(
						Object.entries(expected).map(([id, mask]) => [id, mask.reduce((s, v) => s + v, 0)]),
					),
				);
				const wantLabels = new Uint32Array((n + offset + 3) * 2);
				// union is referenced but not an ancestry parent, so remains a label leaf.
				for (let i = 0; i < n; i++) {
					wantLabels[(offset + i) * 2] = Number(i % 8 <= 5);
					wantLabels[(offset + i) * 2 + 1] =
						Number(i % 8 === 2 || i % 8 === 3) * 2 + Number(i % 8 === 6) * 4;
				}
				expect(await readback(device, labels, Uint32Array)).toEqual(wantLabels);
				expect(r.skipped).toEqual([]);
				const sizes = bindingSpy.mock.calls.flatMap(([desc]) =>
					[...desc.entries].map((e) =>
						"buffer" in e.resource ? (e.resource.size ?? e.resource.buffer.size) : 0,
					),
				);
				expect(Math.max(...sizes)).toBeLessThanOrEqual(1024);
				expect(await device.popErrorScope()).toBeNull();
			} finally {
				for (const mask of r.masks.values()) mask.destroy();
			}
		} finally {
			bindingSpy.mockRestore();
			x.destroy();
			labels.destroy();
		}
	});

	it("cleans owned buffers on success/error and never destroys borrowed buffers", async () => {
		const { device } = await getDevice();
		const k = new Kernels(device);
		const source = upload(device, new Uint32Array([1, 0]));
		const borrowed = vi.spyOn(source, "destroy");
		const destroyed: Array<ReturnType<typeof vi.spyOn>> = [];
		const create = device.createBuffer.bind(device);
		const spy = vi.spyOn(device, "createBuffer").mockImplementation((desc) => {
			const buffer = create(desc);
			destroyed.push(vi.spyOn(buffer, "destroy"));
			return buffer;
		});
		try {
			const good = boolean("good", "and", []);
			const unsupported: WspGate = {
				...rectangle("bad", 0, 1),
				geometry: { type: "unsupported", element: "test" },
			};
			const cols = { count: 2, columns: new Map(), tables: new Map() };
			const r = await gateSample(k, sample([good]), cols, 1024);
			expect(r.masks.size).toBe(0);
			await expect(
				gateSample(
					k,
					sample([good, unsupported, boolean("fail", "or", ["good", "bad"])]),
					cols,
					1024,
					{ keepMasks: true },
				),
			).rejects.toThrow(/unevaluated gate bad/);
			const result = await evaluateBooleanGate(
				k,
				{ op: "not", operands: [source], parent: null, count: 2 },
				1024,
			);
			result.mask.destroy();
			expect(destroyed.every((s) => s.mock.calls.length === 1)).toBe(true);
			expect(borrowed).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
			borrowed.mockRestore();
			source.destroy();
		}
	});
});
