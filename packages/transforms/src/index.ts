/**
 * FlowJo-compatible display transforms, ported from FlowWorkspace.jl (itself a port of FlowKit).
 * Every transform is a monotone lookup table (x ascending → y) evaluated by linear interpolation
 * with flat extrapolation. The same tables are uploaded to the GPU and evaluated by binary search.
 *
 * Biex output is in FlowJo "channel" units (0..channelRange), not decades.
 */

export interface Table {
	/** Ascending raw-space x values. */
	x: Float64Array;
	/** Transformed y values, same length as x. */
	y: Float64Array;
}

export interface BiexParams {
	width?: number;
	neg?: number;
	pos?: number;
	maxRange?: number;
	channelRange?: number;
	length?: number;
}

export interface LinearParams {
	minRange?: number;
	maxRange?: number;
	gain?: number;
}

export interface LogParams {
	offset?: number;
	decades?: number;
	minRange?: number;
	maxRange?: number;
}

export type TransformSpec =
	| ({ type: "biex" } & BiexParams)
	| ({ type: "linear" } & LinearParams)
	| ({ type: "log" } & LogParams);

/** Julia `round(Int, x)`: round half to even. */
function roundEven(x: number): number {
	const r = Math.round(x);
	if (Math.abs(x % 1) === 0.5 && r % 2 !== 0) return r - 1;
	return r;
}

/** Newton/bisection solve used by biex (ported verbatim, quirks included). */
function logRoot(b: number, w: number): number {
	let xLo = 0;
	let xHi = b;
	let d = (xLo + xHi) / 2;
	let dx = Math.abs(Math.round(xLo - xHi));
	let dxLast = dx;
	const fb = -2 * Math.log(b) + w * b;
	let f = 2.0 * Math.log(d) + w * b + fb;
	let df = 2 / d + w;
	if (w === 0) return b;
	for (let i = 0; i < 100; i++) {
		if ((d - xHi) * df - f - ((d - xLo) * df - f) > 0 || Math.abs(2 * f) > Math.abs(dxLast * df)) {
			dx = (xHi - xLo) / 2;
			d = xLo + dx;
			if (d === xLo) return d;
		} else {
			dx = f / df;
			const t = d;
			d -= dx;
			if (d === t) return d;
		}
		if (Math.abs(dx) < 1.0e-12) return d;
		dxLast = dx;
		f = 2 * Math.log(d) + w * d + fb;
		df = 2 / d + w;
		if (f < 0) xLo = d;
		else xHi = d;
	}
	return d;
}

export function biexTable({
	width = -10,
	neg = 0,
	pos = 4.41854,
	maxRange = 262144,
	channelRange = 4096,
	length = 256,
}: BiexParams = {}): Table {
	if (length !== 256) throw new Error(`length ${length} not supported for transforms:biex`);
	let w = Math.log10(-width);
	let decades = pos - w / 2;
	const extra = Math.max(neg, 0) + w / 2;

	let zero = roundEven((extra * channelRange) / (extra + decades));
	zero = roundEven(Math.min(zero, channelRange / 2));
	if (zero > 0) decades = (extra * channelRange) / zero;

	w = w / (2 * decades);
	const positiveRange = Math.LN10 * decades;
	const negativeRange = logRoot(positiveRange, w);

	const n = channelRange + 1;
	const positive = new Float64Array(n);
	const negative = new Float64Array(n);
	const values = new Float64Array(n);
	for (let v = 0; v < n; v++) {
		values[v] = v;
		positive[v] = Math.exp((v / n) * positiveRange);
		negative[v] = Math.exp((-v / n) * negativeRange);
	}
	let s = Math.exp((positiveRange + negativeRange) * (w + extra / decades));
	for (let v = 0; v < n; v++) negative[v] = (negative[v] as number) * s;
	s = (positive[zero] as number) - (negative[zero] as number);
	const k = maxRange / Math.exp(positiveRange);
	for (let v = zero; v < n; v++) {
		positive[v] = k * ((positive[v] as number) - (negative[v] as number) - s);
	}
	for (let i = 0; i < zero; i++) positive[i] = -(positive[2 * zero - i] as number);
	return { x: positive, y: values };
}

export function linearTable({
	minRange = 0,
	maxRange = 262144,
	gain = 1,
}: LinearParams = {}): Table {
	const n = Math.floor(maxRange - minRange) + 1;
	const x = new Float64Array(n);
	const y = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		x[i] = minRange + i;
		y[i] = gain * (minRange + i);
	}
	return { x, y };
}

export function logTable({
	offset = 1,
	decades = 1,
	minRange = 0,
	maxRange = 262144,
}: LogParams = {}): Table {
	const n = Math.floor(maxRange - minRange) + 1;
	const x = new Float64Array(n);
	const y = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		x[i] = minRange + i;
		y[i] = Math.log10((minRange + i + offset) / decades);
	}
	return { x, y };
}

export function table(spec: TransformSpec): Table {
	switch (spec.type) {
		case "biex":
			return biexTable(spec);
		case "linear":
			return linearTable(spec);
		case "log":
			return logTable(spec);
	}
}

/** Linear interpolation with flat extrapolation; binary search over ascending x. */
export function interpolate(t: Table, v: number): number {
	const { x, y } = t;
	const n = x.length;
	if (Number.isNaN(v)) return Number.NaN;
	if (v <= (x[0] as number)) return y[0] as number;
	if (v >= (x[n - 1] as number)) return y[n - 1] as number;
	let lo = 0;
	let hi = n - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >>> 1;
		if ((x[mid] as number) <= v) lo = mid;
		else hi = mid;
	}
	const x0 = x[lo] as number;
	const x1 = x[hi] as number;
	const y0 = y[lo] as number;
	const y1 = y[hi] as number;
	if (x1 === x0) return y0;
	return y0 + ((v - x0) / (x1 - x0)) * (y1 - y0);
}

/** Apply in place over a Float32Array column (TS reference; GPU twin in `compute`). */
export function applyInPlace(t: Table, col: Float32Array): void {
	for (let i = 0; i < col.length; i++) col[i] = interpolate(t, col[i] as number);
}

/** Inverse: transformed → raw (for drawing gates in display space). */
export function invert(t: Table, yv: number): number {
	const { x, y } = t;
	const n = y.length;
	if (yv <= (y[0] as number)) return x[0] as number;
	if (yv >= (y[n - 1] as number)) return x[n - 1] as number;
	let lo = 0;
	let hi = n - 1;
	while (hi - lo > 1) {
		const mid = (lo + hi) >>> 1;
		if ((y[mid] as number) <= yv) lo = mid;
		else hi = mid;
	}
	const y0 = y[lo] as number;
	const y1 = y[hi] as number;
	const x0 = x[lo] as number;
	const x1 = x[hi] as number;
	if (y1 === y0) return x0;
	return x0 + ((yv - y0) / (y1 - y0)) * (x1 - x0);
}
