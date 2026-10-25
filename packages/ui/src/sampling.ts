export const QUICK_DEMO_EVENTS = 100000;
export interface SamplingSource {
	sampleId: string;
	basename: string;
	eventCount: number;
}
export interface SamplingSummary {
	method: "global-systematic-midpoint-v1";
	seed: null;
	indexFormula: "floor((i + 0.5) * N / K), i = 0..K-1";
	sourceOrder: "concatenated-wsp-sample-order";
	sourceEventCount: number;
	selectedEventCount: number;
	maximumEvents: number;
	files: Array<{
		sampleIndex: number;
		sampleId: string;
		basename: string;
		sourceOffset: number;
		sourceEventCount: number;
		selectedOffset: number;
		selectedEventCount: number;
	}>;
}

/** Metadata-only selection. Exact integer arithmetic avoids large-count rounding ambiguity. */
export function planSystematicSample(
	sources: readonly SamplingSource[],
	maximumEvents = QUICK_DEMO_EVENTS,
) {
	if (
		!Number.isSafeInteger(maximumEvents) ||
		maximumEvents < 1 ||
		maximumEvents > QUICK_DEMO_EVENTS
	)
		throw new Error("Sampling maximum must be an integer in 1..100000");
	let total = 0;
	const files = sources.map((source, sampleIndex) => {
		if (
			!Number.isSafeInteger(source.eventCount) ||
			source.eventCount < 0 ||
			source.eventCount > Number.MAX_SAFE_INTEGER - total
		)
			throw new Error("Invalid or unsafe source event count");
		const result = {
			sampleIndex,
			sampleId: source.sampleId,
			basename: source.basename,
			sourceOffset: total,
			sourceEventCount: source.eventCount,
			selectedOffset: 0,
			selectedEventCount: 0,
		};
		total += source.eventCount;
		return result;
	});
	const selected = Math.min(total, maximumEvents);
	const indices = sources.map(() => [] as number[]);
	let fileIndex = 0;
	for (let i = 0; i < selected; i++) {
		const global = Number(((2n * BigInt(i) + 1n) * BigInt(total)) / (2n * BigInt(selected)));
		while (
			global >=
			(files[fileIndex]?.sourceOffset ?? 0) + (files[fileIndex]?.sourceEventCount ?? 0)
		)
			fileIndex++;
		const file = files[fileIndex] as SamplingSummary["files"][number];
		indices[fileIndex]?.push(global - file.sourceOffset);
		file.selectedEventCount++;
	}
	let offset = 0;
	for (const file of files) {
		file.selectedOffset = offset;
		offset += file.selectedEventCount;
	}
	const summary: SamplingSummary = {
		method: "global-systematic-midpoint-v1",
		seed: null,
		indexFormula: "floor((i + 0.5) * N / K), i = 0..K-1",
		sourceOrder: "concatenated-wsp-sample-order",
		sourceEventCount: total,
		selectedEventCount: selected,
		maximumEvents,
		files,
	};
	return { summary, indices };
}

/** Row selection/layout copy only; no event filtering, statistics or embedding arithmetic. */
export function copySelectedRows(
	data: Float32Array,
	channels: number,
	indices: readonly number[],
): Float32Array {
	if (
		!(data instanceof Float32Array) ||
		!Number.isSafeInteger(channels) ||
		channels < 1 ||
		data.length % channels !== 0
	)
		throw new Error("Sampling requires complete F32 rows");
	const rows = data.length / channels;
	if (
		indices.some(
			(index, i) =>
				!Number.isSafeInteger(index) ||
				index < 0 ||
				index >= rows ||
				(i > 0 && index <= (indices[i - 1] as number)),
		)
	)
		throw new Error("Sampling indices must be ordered, unique and within the source");
	const selected = new Float32Array(indices.length * channels);
	indices.forEach((index, row) => {
		selected.set(data.subarray(index * channels, (index + 1) * channels), row * channels);
	});
	return selected;
}
