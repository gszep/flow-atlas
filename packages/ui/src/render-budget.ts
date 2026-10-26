export const RENDER_BATCH_EVENTS = 65536;

export function renderBatches(count: number) {
	if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid render count");
	const result: Array<{ first: number; count: number }> = [];
	for (let first = 0; first < count; first += RENDER_BATCH_EVENTS)
		result.push({ first, count: Math.min(RENDER_BATCH_EVENTS, count - first) });
	return result;
}

/** Bound pixel work, not event coverage. Mobile uses a lower backing resolution. */
export function canvasBudget(
	cssWidth: number,
	cssHeight: number,
	devicePixelRatio: number,
	maxDimension: number,
	compact: boolean,
) {
	const width = Math.max(1, cssWidth),
		height = Math.max(1, cssHeight);
	const ratio = Math.min(
		Math.max(1, devicePixelRatio || 1),
		compact ? 1.5 : 2,
		Math.sqrt((compact ? 2_000_000 : 8_000_000) / (width * height)),
		maxDimension / width,
		maxDimension / height,
	);
	return {
		width: Math.max(1, Math.floor(width * ratio)),
		height: Math.max(1, Math.floor(height * ratio)),
		ratio,
	};
}
