import { chmodSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernels } from "@flow-atlas/compute";
import { type FcsFile, openFcs, writeFcs } from "@flow-atlas/fcs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDevice, releaseDevice } from "../../compute/test/setup.js";
import { ArtifactStore } from "../src/artifact-store.js";
import * as gates from "../src/gate-counts.js";
import {
	type PopulationMedianRequest,
	resolvePopulationMedians,
	runPopulationMedians,
} from "../src/population-medians.js";

type Fixture = {
	sampleId: string;
	path: string;
	bytes: Buffer;
	metadata: Omit<FcsFile, "data">;
};
let root: string;
let store: ArtifactStore;
let k: Kernels;
let serial = 0;

async function fixture(rows = 8, columns = 2): Promise<Fixture> {
	const fixtureIndex = serial++;
	const metadata: Omit<FcsFile, "data"> = {
		version: "FCS3.1",
		eventCount: rows,
		keywords: { FIXTURE: String(fixtureIndex) },
		channels: Array.from({ length: columns }, (_, index) => ({
			index: index + 1,
			name: `C${index}`,
			bits: 32,
			range: 4096,
			amplification: [0, 0] as [number, number],
			gain: 1,
		})),
	};
	async function* chunks() {
		// An offset view also prevents accidental serialization of its entire backing store.
		const data = new Float32Array(17 + rows * columns).subarray(17);
		for (let row = 0; row < rows; row++)
			for (let column = 0; column < columns; column++) data[row * columns + column] = row + column;
		yield data;
	}
	const parts: Uint8Array[] = [];
	for await (const bytes of writeFcs(metadata, chunks())) parts.push(bytes.slice());
	const bytes = Buffer.concat(parts);
	const name = `invariant-${fixtureIndex}.fcs`;
	await writeFile(join(root, name), bytes);
	const snapshot = await store.snapshot(name);
	const parsed = await openFcs({
		size: bytes.length,
		read: async (offset, length) => bytes.subarray(offset, offset + length),
	});
	return { sampleId: snapshot.sha256, path: snapshot.path, bytes, metadata: parsed.metadata };
}
function gate(id = "all"): PopulationMedianRequest["gates"][number] {
	return {
		id,
		name: id,
		parentId: null,
		dimensions: ["C0"],
		geometry: { type: "rectangle", min: [null], max: [null] },
	};
}
function recipe(source: Fixture): PopulationMedianRequest {
	return {
		sampleId: source.sampleId,
		coordinateSpace: "stored-f32",
		populationId: "all",
		gates: [gate()],
		channels: ["C0"],
	};
}
function run(
	source: Fixture,
	request = recipe(source),
	signal = new AbortController().signal,
	progress: (count: number, pass: number) => void = () => {},
	chunkBytes = 256,
) {
	return runPopulationMedians(
		k,
		store,
		resolvePopulationMedians(request, source.metadata),
		256,
		chunkBytes,
		signal,
		progress,
	);
}

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "flow-atlas-population-invariants-"));
	store = await ArtifactStore.create(root);
	k = new Kernels((await getDevice()).device);
}, 30_000);
afterAll(async () => {
	k?.device.destroy();
	releaseDevice();
	if (root) await rm(root, { recursive: true, force: true });
});

describe("population median source/replay/resource invariants", () => {
	it("rejects a pinned snapshot mutated after pass 0 data consumption, before returning a median", async () => {
		const source = await fixture();
		const altered = Buffer.from(source.bytes);
		altered[altered.length - 1] = (altered[altered.length - 1] as number) ^ 1;
		const visits: Array<[number, number]> = [];
		let changed = false;
		const returned = vi.fn();
		const result = run(source, recipe(source), new AbortController().signal, (count, pass) => {
			visits.push([pass, count]);
			if (pass === 0 && !changed) {
				// This callback runs after the median has consumed the yielded chunk.
				// Synchronous writes make the pass-boundary race deterministic, not timed.
				chmodSync(source.path, 0o600);
				try {
					writeFileSync(source.path, altered);
					utimesSync(source.path, new Date(0), new Date(0));
				} finally {
					chmodSync(source.path, 0o400);
				}
				changed = true;
			}
		}).then(returned);
		await expect(result).rejects.toMatchObject({ code: "INPUT_CHANGED" });
		expect(changed).toBe(true);
		expect(visits).toEqual([[0, 8]]);
		expect(returned).not.toHaveBeenCalled();
	});

	it.each(["zero-mask", "wrong-count"])(
		"rejects %s disagreement with the real GPU gate result",
		async (mode) => {
			const source = await fixture(4);
			const evaluate = gates.evaluateGateChunk;
			const seenCounts: number[] = [];
			const spy = vi.spyOn(gates, "evaluateGateChunk").mockImplementation(async (...args) => {
				const evaluated = await evaluate(...args);
				seenCounts.push(evaluated.counts[0] as number);
				if (mode === "zero-mask")
					return { ...evaluated, mask: new Uint32Array((evaluated.mask as Uint32Array).length) };
				return { ...evaluated, counts: evaluated.counts.map((count) => count + 1) };
			});
			try {
				await expect(run(source)).rejects.toMatchObject({ code: "POPULATION_MASK_MISMATCH" });
				expect(seenCounts).toEqual(Array(mode === "zero-mask" ? 1 : 4).fill(4));
			} finally {
				spy.mockRestore();
			}
		},
	);

	it.each(["cancel", "readback-failure"])(
		"drains work and releases owned buffers on selected-mask %s",
		async (mode) => {
			const source = await fixture();
			const controller = new AbortController();
			const injected = new Error(`injected ${mode}`);
			const destroyed: Array<ReturnType<typeof vi.spyOn>> = [];
			const mapped: Array<ReturnType<typeof vi.spyOn>> = [];
			const borrowed: Array<{ data: Float32Array; before: Float32Array }> = [];
			let completedDrains = 0,
				interceptions = 0;
			const create = k.device.createBuffer.bind(k.device);
			const wait = k.device.queue.onSubmittedWorkDone.bind(k.device.queue);
			const drainSpy = vi
				.spyOn(k.device.queue, "onSubmittedWorkDone")
				.mockImplementation(async () => {
					await wait();
					completedDrains++;
				});
			const createSpy = vi.spyOn(k.device, "createBuffer").mockImplementation((descriptor) => {
				const buffer = create(descriptor);
				destroyed.push(vi.spyOn(buffer, "destroy"));
				// Eight selected-mask words: distinguish this from 4-byte gate counters.
				if ((descriptor.usage & GPUBufferUsage.MAP_READ) !== 0 && descriptor.size === 32) {
					const map = buffer.mapAsync.bind(buffer);
					mapped.push(
						vi.spyOn(buffer, "mapAsync").mockImplementation(async (...args) => {
							interceptions++;
							if (mode === "readback-failure") throw injected;
							await map(...args);
							controller.abort(injected);
						}),
					);
				}
				return buffer;
			});
			const evaluate = gates.evaluateGateChunk;
			const gateSpy = vi.spyOn(gates, "evaluateGateChunk").mockImplementation(async (...args) => {
				borrowed.push({ data: args[2], before: args[2].slice() });
				return evaluate(...args);
			});
			try {
				await expect(run(source, recipe(source), controller.signal)).rejects.toBe(injected);
				expect(interceptions).toBe(1);
				expect(completedDrains).toBeGreaterThan(0);
				expect(destroyed.length).toBeGreaterThan(0);
				expect(destroyed.every((spy) => spy.mock.calls.length === 1)).toBe(true);
				expect(borrowed).toHaveLength(1);
				expect(borrowed.map(({ data }) => data)).toEqual(borrowed.map(({ before }) => before));
				expect(controller.signal.aborted).toBe(mode === "cancel");
			} finally {
				gateSpy.mockRestore();
				createSpy.mockRestore();
				drainSpy.mockRestore();
				for (const spy of [...mapped, ...destroyed]) spy.mockRestore();
			}
		},
	);

	it("checks root recipes, target uniqueness and safe u32 source ranges before GPU allocation", async () => {
		const source = await fixture();
		const rootRequest: PopulationMedianRequest = {
			...recipe(source),
			populationId: null,
			gates: [],
		};
		const allocations = vi.spyOn(k.device, "createBuffer");
		try {
			expect(resolvePopulationMedians(rootRequest, source.metadata)).toMatchObject({
				gateBinding: null,
				eventCount: 8,
				totalEventVisits: 32,
			});
			expect(() =>
				resolvePopulationMedians({ ...rootRequest, gates: [gate()] }, source.metadata),
			).toThrowError(expect.objectContaining({ code: "INVALID_POPULATION_RECIPE" }));
			expect(() =>
				resolvePopulationMedians({ ...rootRequest, channels: ["C0", "C0"] }, source.metadata),
			).toThrowError(expect.objectContaining({ code: "INVALID_POPULATION_CHANNEL" }));
			expect(() =>
				resolvePopulationMedians(rootRequest, { ...source.metadata, eventCount: 0x100000000 }),
			).toThrowError(expect.objectContaining({ code: "INVALID_POPULATION_RANGE" }));
			expect(() =>
				resolvePopulationMedians(rootRequest, {
					...source.metadata,
					eventCount: Number.MAX_SAFE_INTEGER + 1,
				}),
			).toThrowError(expect.objectContaining({ code: "INVALID_POPULATION_RANGE" }));
			expect(() =>
				resolvePopulationMedians({ ...rootRequest, startEvent: 7, eventCount: 2 }, source.metadata),
			).toThrowError(expect.objectContaining({ code: "INVALID_POPULATION_RANGE" }));
			expect(
				resolvePopulationMedians(
					{ ...rootRequest, eventCount: 0xffffffff },
					{ ...source.metadata, eventCount: 0xffffffff },
				),
			).toMatchObject({ eventCount: 0xffffffff, totalEventVisits: 4 * 0xffffffff });
			expect(
				resolvePopulationMedians(
					{ ...rootRequest, startEvent: Number.MAX_SAFE_INTEGER - 1, eventCount: 1 },
					{ ...source.metadata, eventCount: Number.MAX_SAFE_INTEGER },
				),
			).toMatchObject({
				startEvent: Number.MAX_SAFE_INTEGER - 1,
				eventCount: 1,
				totalEventVisits: 4,
			});
			expect(allocations).not.toHaveBeenCalled();
		} finally {
			allocations.mockRestore();
		}
	});

	it("validates the whole recipe but dispatches only the selected dependency closure", async () => {
		const source = await fixture();
		const request: PopulationMedianRequest = {
			...recipe(source),
			populationId: "chosen",
			gates: [
				{
					...gate("chosen"),
					parentId: "parent",
					dimensions: [],
					geometry: { type: "boolean", op: "and", refs: ["operand"] },
				},
				gate("unrelated"),
				{ ...gate("operand"), parentId: "ancestor" },
				{ ...gate("parent"), parentId: "ancestor" },
				gate("ancestor"),
			],
		};
		const planned = resolvePopulationMedians(request, source.metadata);
		expect(planned.request.gates).toHaveLength(5);
		expect(planned.gateBinding?.request.gates.map((g) => g.id)).toEqual([
			"chosen",
			"operand",
			"parent",
			"ancestor",
		]);
		const invalid = structuredClone(request);
		(invalid.gates[1] as PopulationMedianRequest["gates"][number]).dimensions = ["missing"];
		expect(() => resolvePopulationMedians(invalid, source.metadata)).toThrowError(
			expect.objectContaining({ code: "INVALID_GATE_RECIPE" }),
		);
		const executed: string[][] = [];
		const evaluate = gates.evaluateGateChunk;
		const spy = vi.spyOn(gates, "evaluateGateChunk").mockImplementation(async (...args) => {
			executed.push(args[1].request.gates.map((g) => g.id));
			return evaluate(...args);
		});
		try {
			expect(await run(source, request)).toMatchObject({ count: 8, diagnostics: { passCount: 4 } });
			expect(executed).toHaveLength(4);
			expect(new Set(executed.map((ids) => ids.join(",")))).toEqual(
				new Set(["chosen,operand,parent,ancestor"]),
			);
		} finally {
			spy.mockRestore();
		}
	});

	it("keeps data/mask bindings chunk-local at 32 target channels and 128 gates", async () => {
		const source = await fixture(5, 32);
		const request: PopulationMedianRequest = {
			...recipe(source),
			populationId: "g127",
			gates: Array.from({ length: 128 }, (_, index) => ({
				...gate(`g${index}`),
				parentId: index === 0 ? null : `g${index - 1}`,
			})),
			channels: source.metadata.channels.map(({ name }) => name),
		};
		const sizes: Array<{ label: string; bytes: number }> = [];
		const bind = k.device.createBindGroup.bind(k.device);
		const bindSpy = vi.spyOn(k.device, "createBindGroup").mockImplementation((descriptor) => {
			for (const entry of descriptor.entries) {
				const resource = entry.resource as GPUBufferBinding;
				const label = resource.buffer?.label;
				if (["gate-counts.column", "gate.mask", "median.input", "median.mask"].includes(label))
					sizes.push({ label, bytes: resource.size ?? resource.buffer.size });
			}
			return bind(descriptor);
		});
		const chunks: number[] = [];
		const evaluate = gates.evaluateGateChunk;
		const gateSpy = vi.spyOn(gates, "evaluateGateChunk").mockImplementation(async (...args) => {
			chunks.push(args[2].length / args[3]);
			return evaluate(...args);
		});
		try {
			const result = await run(source, request);
			expect(result).toMatchObject({
				count: 5,
				channels: request.channels,
				diagnostics: { sourceRows: 5, passCount: 4 },
			});
			expect(chunks).toEqual(Array.from({ length: 4 }, () => [2, 2, 1]).flat());
			expect(sizes.length).toBeGreaterThan(0);
			expect(Math.max(...sizes.map(({ bytes }) => bytes))).toBeLessThanOrEqual(256);
			expect(
				Math.max(
					...sizes
						.filter(({ label }) => label === "gate.mask" || label === "median.mask")
						.map(({ bytes }) => bytes),
				),
			).toBeLessThanOrEqual(8);
			// Fixed 64-lane radix histograms are intentionally outside the event-window
			// budget; this assertion concerns data/masks, not constant-size rank state.
		} finally {
			gateSpy.mockRestore();
			bindSpy.mockRestore();
		}
	}, 60_000);
});
