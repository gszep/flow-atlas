/**
 * Prototype pipeline: files → FCS/WSP → GPU transform → gating (labels) → SOM → EmbedSOM.
 * Everything stays on the GPU except small readbacks for SOM statistics.
 */
import {
	createStorage,
	gateSample,
	gatherFeatures,
	initSom,
	Kernels,
	readback,
	type Som,
	trainSom,
	transformColumn,
	upload,
	uploadTable,
} from "@flow-atlas/compute";
import { type FcsFile, openFcs, readFcs } from "@flow-atlas/fcs";
import { type Table, table, UnsupportedTransformError } from "@flow-atlas/transforms";
import { displayName, leafGates, readWsp, type WspSample } from "@flow-atlas/wsp";
import { projectAllEvents } from "./projection.js";
import { copySelectedRows, planSystematicSample, type SamplingSummary } from "./sampling.js";

export { PROJECTION_BATCH_EVENTS } from "./projection.js";

export interface SampleInfo {
	name: string;
	basename: string;
	offset: number;
	count: number;
	sourceCount: number;
	sourceOffset: number;
	groups: string[];
	gateCounts: Array<{
		name: string;
		count: number;
		expected: number | null;
		sourceReportedCount: number | null;
	}>;
}

export interface LoadedWorkspace {
	n: number;
	sourceEventCount: number;
	sampling: SamplingSummary | null;
	channels: string[];
	/** Transformed columns over all events; NaN where the sample lacks the channel. */
	channelBuffers: GPUBuffer[];
	channelPresent: Array<Array<{ start: number; count: number }>>;
	embedChannels: number[]; // indices into channels
	sampleId: GPUBuffer;
	samples: SampleInfo[];
	populations: string[];
	labels: GPUBuffer;
	words: number;
	conditions: string[];
	batches: string[];
	som: Som | null;
	bmu: GPUBuffer | null;
	embedding: GPUBuffer | null;
	bounds: { minX: number; maxX: number; minY: number; maxY: number } | null;
}

export type Progress = (msg: string) => void;
export interface WorkspaceLoadOptions {
	sampling?: { maximumEvents: number };
	expectedSource?: { eventCount: number; samples: Array<{ basename: string; events?: number }> };
}

/** CPU decode/row-selection preprocessing, completed before any GPU buffer allocation. */
export async function prepareWorkspaceSamples(
	samples: WspSample[],
	fcsFiles: Map<string, File>,
	progress: Progress,
	options: WorkspaceLoadOptions = {},
) {
	const metadata: Array<{ s: WspSample; sourceCount: number }> = [];
	if (options.sampling || options.expectedSource) {
		for (const s of samples) {
			const file = fcsFiles.get(s.basename) as File;
			const reader = await openFcs({
				size: file.size,
				read: async (offset, length) =>
					new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
			});
			metadata.push({ s, sourceCount: reader.metadata.eventCount });
		}
		const expected = options.expectedSource;
		if (expected) {
			const counts = new Map(expected.samples.map((sample) => [sample.basename, sample.events]));
			if (
				samples.length !== expected.samples.length ||
				new Set(samples.map((sample) => sample.basename)).size !== counts.size ||
				metadata.reduce((sum, item) => sum + item.sourceCount, 0) !== expected.eventCount ||
				metadata.some(
					({ s, sourceCount }) =>
						!counts.has(s.basename) ||
						(counts.get(s.basename) !== undefined && counts.get(s.basename) !== sourceCount),
				)
			)
				throw new Error("Full source sample/event counts differ from the publication manifest");
		}
	}
	const plan = options.sampling
		? planSystematicSample(
				metadata.map(({ s, sourceCount }) => ({
					sampleId: s.id,
					basename: s.basename,
					eventCount: sourceCount,
				})),
				options.sampling.maximumEvents,
			)
		: null;
	const parsed: Array<{
		s: WspSample;
		f: FcsFile;
		offset: number;
		sourceCount: number;
		sourceOffset: number;
	}> = [];
	let n = 0,
		sourceEventCount = 0;
	for (const [index, s] of samples.entries()) {
		const file = fcsFiles.get(s.basename) as File;
		progress(`Reading ${s.basename}`);
		await yieldToUi();
		const source = readFcs(await file.arrayBuffer());
		if (metadata[index] && metadata[index].sourceCount !== source.eventCount)
			throw new Error("Source row count changed during sampling preparation");
		const indices = plan?.indices[index];
		const f = indices
			? {
					...source,
					eventCount: indices.length,
					data: copySelectedRows(source.data, source.channels.length, indices),
				}
			: source;
		parsed.push({
			s,
			f,
			offset: n,
			sourceCount: source.eventCount,
			sourceOffset: sourceEventCount,
		});
		n += f.eventCount;
		sourceEventCount += source.eventCount;
	}
	if (plan && n !== plan.summary.selectedEventCount)
		throw new Error("Prepared sample does not match selection plan");
	return { parsed, n, sourceEventCount, sampling: plan?.summary ?? null };
}

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

export async function loadWorkspace(
	device: GPUDevice,
	maxBinding: number,
	wspText: string,
	fcsFiles: Map<string, File>,
	progress: Progress,
	options: WorkspaceLoadOptions = {},
): Promise<LoadedWorkspace> {
	const ws = readWsp(wspText);
	const samples = ws.samples.filter((s) => fcsFiles.has(s.basename));
	if (samples.length === 0) throw new Error("no FCS files match the workspace's DataSets");
	// Reject before file reads or GPU allocation; readWsp itself remains metadata-only.
	for (const s of samples) {
		for (const [channel, spec] of Object.entries(s.transforms)) {
			if (spec.type === "unsupported") {
				throw new UnsupportedTransformError(spec, {
					sampleId: s.id,
					sampleName: s.name,
					channel,
				});
			}
		}
	}
	const k = new Kernels(device);
	progress(`workspace: ${ws.samples.length} samples in wsp, ${samples.length} FCS files matched`);

	// Channel union by display name; populations = union of leaf gate names.
	const channelNames: string[] = [];
	const chIndex = new Map<string, number>();
	const popIndex = new Map<string, number>();
	for (const s of samples) {
		for (const c of s.channels) {
			const dn = displayName(c);
			if (!chIndex.has(dn)) {
				chIndex.set(dn, channelNames.length);
				channelNames.push(dn);
			}
		}
		for (const g of leafGates(s)) if (!popIndex.has(g.name)) popIndex.set(g.name, popIndex.size);
	}
	const populations = [...popIndex.keys()];
	const words = Math.max(1, Math.ceil(populations.length / 32));

	// Groups → conditions / batches (FlowAtlas heuristic: names containing a digit are batches).
	const allIds = new Set(samples.map((s) => s.id));
	const groups = ws.groups.filter((g) => {
		const ids = g.sampleIds.filter((id) => allIds.has(id));
		return ids.length > 0 && ids.length < allIds.size;
	});
	const conditions = groups.filter((g) => !/\d/.test(g.name)).map((g) => g.name);
	const batches = groups.filter((g) => /\d/.test(g.name)).map((g) => g.name);

	const { parsed, n, sourceEventCount, sampling } = await prepareWorkspaceSamples(
		samples,
		fcsFiles,
		progress,
		options,
	);
	if (options.sampling && n === 0) throw new Error("No source events available to sample");
	progress(
		`${n.toLocaleString()} events, ${channelNames.length} channels, ${populations.length} populations`,
	);

	// Global column buffers prefilled with NaN.
	const nan = new Float32Array(n).fill(Number.NaN);
	const channelBuffers = channelNames.map((name) => {
		const b = createStorage(device, n * 4, undefined, `col:${name}`);
		device.queue.writeBuffer(b, 0, nan);
		return b;
	});
	const channelPresent: LoadedWorkspace["channelPresent"] = channelNames.map(() => []);
	const sampleIdArr = new Uint32Array(n);
	const labels = createStorage(device, n * words * 4, undefined, "labels");
	device.queue.writeBuffer(labels, 0, new Uint32Array(n * words));

	const tableCache = new Map<string, { t: Table; gpu: ReturnType<typeof uploadTable> }>();
	const sampleInfos: SampleInfo[] = [];
	const embedSet = new Set<number>();

	for (let si = 0; si < parsed.length; si++) {
		const { s, f, offset, sourceCount, sourceOffset } = parsed[si] as (typeof parsed)[number];
		if (f.eventCount === 0 && sampling) {
			sampleInfos.push({
				name: s.name,
				basename: s.basename,
				offset,
				count: 0,
				sourceCount,
				sourceOffset,
				groups: groups.filter((group) => group.sampleIds.includes(s.id)).map((group) => group.name),
				gateCounts: s.gates.map((gate) => ({
					name: gate.name,
					count: 0,
					expected: null,
					sourceReportedCount: gate.count,
				})),
			});
			continue;
		}
		progress(`transform + gate ${s.basename} (${si + 1}/${parsed.length})`);
		await yieldToUi();
		sampleIdArr.fill(si, offset, offset + f.eventCount);
		const par = f.channels.length;
		const columns = new Map<string, { buffer: GPUBuffer; offset: number }>();
		const tables = new Map<string, Table>();
		const enc = device.createCommandEncoder();
		const temps: GPUBuffer[] = [];
		for (let p = 0; p < par; p++) {
			const ch = f.channels[p];
			if (!ch) continue;
			const wch = s.channels.find((c) => c.name === ch.name) ?? ch;
			const dn = displayName(wch);
			const ci = chIndex.get(dn);
			if (ci === undefined) continue;
			const col = new Float32Array(f.eventCount);
			for (let i = 0; i < f.eventCount; i++) col[i] = f.data[i * par + p] as number;
			const raw = upload(device, col);
			let out = raw;
			const spec = s.transforms[ch.name];
			if (spec) {
				const key = JSON.stringify(spec);
				let entry = tableCache.get(key);
				if (!entry) {
					const t = table(spec);
					entry = { t, gpu: uploadTable(device, t) };
					tableCache.set(key, entry);
				}
				tables.set(ch.name, entry.t);
				out = createStorage(device, f.eventCount * 4);
				transformColumn(k, entry.gpu, raw, out, f.eventCount, maxBinding);
				temps.push(raw);
				if (spec.type === "biex") embedSet.add(ci);
			}
			columns.set(ch.name, { buffer: out, offset: 0 });
			temps.push(out);
			enc.copyBufferToBuffer(out, 0, channelBuffers[ci] as GPUBuffer, offset * 4, f.eventCount * 4);
			channelPresent[ci]?.push({ start: offset, count: f.eventCount });
		}
		device.queue.submit([enc.finish()]);

		const r = await gateSample(k, s, { columns, count: f.eventCount, tables }, maxBinding, {
			populationBits: popIndex,
			labels: { buffer: labels, offset, words },
		});
		for (const t of temps) t.destroy();
		sampleInfos.push({
			name: s.name,
			basename: s.basename,
			offset,
			count: f.eventCount,
			sourceCount,
			sourceOffset,
			groups: groups.filter((g) => g.sampleIds.includes(s.id)).map((g) => g.name),
			gateCounts: r.counts.map((c) => ({
				name: c.gate.name,
				count: c.count,
				expected: sampling ? null : c.expected,
				sourceReportedCount: c.expected,
			})),
		});
	}
	const sampleId = upload(device, sampleIdArr, "sampleId");

	// Merge present ranges (adjacent samples) to keep the impute kernel's loop short.
	for (const ranges of channelPresent) {
		ranges.sort((a, b) => a.start - b.start);
		let w = 0;
		for (let i = 1; i < ranges.length; i++) {
			const prev = ranges[w] as { start: number; count: number };
			const cur = ranges[i] as { start: number; count: number };
			if (prev.start + prev.count === cur.start) prev.count += cur.count;
			else ranges[++w] = cur;
		}
		ranges.length = Math.min(ranges.length, w + 1);
	}

	return {
		n,
		sourceEventCount,
		sampling,
		channels: channelNames,
		channelBuffers,
		channelPresent,
		embedChannels: [...embedSet].sort((a, b) => a - b),
		sampleId,
		samples: sampleInfos,
		populations,
		labels,
		words,
		conditions,
		batches,
		som: null,
		bmu: null,
		embedding: null,
		bounds: null,
	};
}

export interface EmbedOptions {
	xdim?: number;
	ydim?: number;
	epochs?: number;
	seed?: number;
	trainMax?: number;
}

export interface EmbeddingWallTimings {
	featurePreparationMs: number;
	somTrainingMs: number;
	mapEmbedProjectionMs: number;
	boundsReadbackMs: number;
}

export async function computeEmbedding(
	device: GPUDevice,
	maxBinding: number,
	w: LoadedWorkspace,
	progress: Progress,
	opts: EmbedOptions = {},
): Promise<EmbeddingWallTimings> {
	const featureStarted = performance.now();
	const k = new Kernels(device);
	const d = w.embedChannels.length;
	if (d === 0) throw new Error("no channels selected for embedding");
	progress(`gather ${d} channels (impute missing)`);
	await yieldToUi();
	const features = gatherFeatures(
		k,
		w.embedChannels.map((ci) => ({
			buffer: w.channelBuffers[ci] as GPUBuffer,
			present: w.channelPresent[ci] as Array<{ start: number; count: number }>,
		})),
		w.n,
		maxBinding,
		opts.seed ?? 1,
	);

	// Column statistics for codebook init (from the imputed feature matrix, strided rows).
	const means = new Float64Array(d);
	const sds = new Float64Array(d);
	{
		const stride = Math.max(1, Math.floor(w.n / 200_000));
		const rows = Math.floor(w.n / stride);
		const sum = new Float64Array(d);
		const sum2 = new Float64Array(d);
		// Read back in chunks to keep staging buffers small.
		const chunkRows = 100_000;
		for (let r0 = 0; r0 < rows; r0 += chunkRows) {
			const cnt = Math.min(chunkRows, rows - r0);
			// Read contiguous rows [r0*stride, ...) then stride on CPU.
			const first = r0 * stride;
			const nrows = Math.min(cnt * stride, w.n - first);
			const buf = await readback(
				device,
				features.buffer,
				Float32Array,
				nrows * d * 4,
				first * d * 4,
			);
			for (let i = 0; i < nrows; i += stride) {
				for (let c = 0; c < d; c++) {
					const v = buf[i * d + c] as number;
					sum[c] = (sum[c] as number) + v;
					sum2[c] = (sum2[c] as number) + v * v;
				}
			}
		}
		for (let c = 0; c < d; c++) {
			means[c] = (sum[c] as number) / rows;
			sds[c] = Math.sqrt(Math.max((sum2[c] as number) / rows - (means[c] as number) ** 2, 1e-12));
		}
	}

	const xdim = opts.xdim ?? 20;
	const ydim = opts.ydim ?? 20;
	let som = initSom(d, means, sds, xdim, ydim, opts.seed ?? 42);
	await device.queue.onSubmittedWorkDone();
	const featurePreparationMs = performance.now() - featureStarted;
	const t0 = performance.now();
	som = await trainSom(
		k,
		features,
		som,
		maxBinding,
		{ epochs: opts.epochs ?? 20, trainMax: opts.trainMax ?? 500_000, seed: opts.seed ?? 42 },
		(p) => progress(`SOM epoch ${p.epoch}/${p.epochs} (radius ${p.radius.toFixed(2)})`),
	);
	await device.queue.onSubmittedWorkDone();
	const somTrainingMs = performance.now() - t0;
	progress(`SOM trained in ${((performance.now() - t0) / 1000).toFixed(1)}s; mapping + embedding`);
	const projectionStarted = performance.now();
	await yieldToUi();
	w.som = som;
	const projected = await projectAllEvents(k, features, som, maxBinding, progress);
	w.bmu = null;
	w.embedding = projected.embedding;
	await device.queue.onSubmittedWorkDone();
	// The full feature matrix is no longer needed. Release it before display
	// readback/allocation, rather than overlapping that peak with first rendering.
	features.buffer.destroy();
	progress("Preparing display…");
	const mapEmbedProjectionMs = performance.now() - projectionStarted;
	const boundsStarted = performance.now();
	// View bounds from a bounded prefix, not a claim to enumerate all output extrema.
	const emb = await readback(device, w.embedding, Float32Array, Math.min(w.n, 500_000) * 8);
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (let i = 0; i < emb.length; i += 2) {
		const x = emb[i] as number;
		const y = emb[i + 1] as number;
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	// Clamp to the SOM grid neighbourhood; EmbedSOM can produce far outliers.
	w.bounds = {
		minX: Math.max(minX, -2),
		maxX: Math.min(maxX, xdim + 1),
		minY: Math.max(minY, -2),
		maxY: Math.min(maxY, ydim + 1),
	};
	if (
		!Object.values(w.bounds).every(Number.isFinite) ||
		w.bounds.minX >= w.bounds.maxX ||
		w.bounds.minY >= w.bounds.maxY
	)
		throw new Error("Projection did not produce a usable map on this GPU");
	progress(
		`embedding ready: ${w.n.toLocaleString()} events in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
	);
	return {
		featurePreparationMs,
		somTrainingMs,
		mapEmbedProjectionMs,
		boundsReadbackMs: performance.now() - boundsStarted,
	};
}
