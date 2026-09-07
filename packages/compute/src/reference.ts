/** CPU reference implementations used only to test kernels. */
import type { Som } from "./som.js";

export function embedSomReference(
	som: Som,
	x: ArrayLike<number>,
	k: number,
	adjust = 1,
	smooth = 0,
	m = 10,
): [number, number] {
	const { d, codes, grid } = som;
	const ncodes = codes.length / d;
	const boost = Math.exp(-smooth - 1);
	const nk = k < ncodes ? k + 1 : k;
	const dist: number[] = [];
	for (let j = 0; j < ncodes; j++) {
		let s = 0;
		for (let q = 0; q < d; q++) {
			const t = (x[q] as number) - (codes[j * d + q] as number);
			s += t * t;
		}
		dist.push(Math.sqrt(s));
	}
	const order = dist.map((_, i) => i).sort((a, b) => (dist[a] as number) - (dist[b] as number));
	const idx = order.slice(0, nk);
	const kd = idx.map((i) => dist[i] as number);
	let mean = 0;
	let sd = 0;
	let wsum = 0;
	for (let i = 0; i < nk; i++) {
		const w = 1 / (i + 1);
		mean += (kd[i] as number) * w;
		sd += (kd[i] as number) ** 2 * w;
		wsum += w;
	}
	mean /= wsum;
	sd = boost / Math.sqrt(sd / wsum - mean * mean);
	const nmax = m / (kd[nk - 1] as number);
	const score: number[] = [];
	for (let i = 0; i < k; i++) {
		let s = Math.exp((mean - (kd[i] as number)) * sd);
		if (k < nk) s *= 1 - Math.exp((kd[i] as number) * nmax - m);
		score.push(s);
	}
	let m11 = 0;
	let m12 = 0;
	let m21 = 0;
	let m22 = 0;
	let m13 = 0;
	let m23 = 0;
	for (let a = 0; a < k; a++) {
		const ia = idx[a] as number;
		const ix = grid[ia * 2] as number;
		const iy = grid[ia * 2 + 1] as number;
		const is = score[a] as number;
		const gs = 1e-9 * is;
		m11 += gs;
		m22 += gs;
		m13 += gs * ix;
		m23 += gs * iy;
		for (let b = a + 1; b < k; b++) {
			const jb = idx[b] as number;
			const jx = grid[jb * 2] as number;
			const jy = grid[jb * 2 + 1] as number;
			const js = score[b] as number;
			let scalar = 0;
			let sqdist = 0;
			for (let q = 0; q < d; q++) {
				const ci = codes[ia * d + q] as number;
				const t = (codes[jb * d + q] as number) - ci;
				sqdist += t * t;
				scalar += t * ((x[q] as number) - ci);
			}
			if (scalar !== 0) {
				if (sqdist === 0) continue;
				scalar /= sqdist;
			}
			const hx = jx - ix;
			const hy = jy - iy;
			const hp = hx * hx + hy * hy;
			if (hp === 0) continue;
			const s = is * js * (1 + hp) ** -adjust * Math.exp(-((scalar - 0.5) ** 2));
			const sihp = s / hp;
			const rhsc = s * (scalar + (hx * ix + hy * iy) / hp);
			m11 += hx * hx * sihp;
			m12 += hx * hy * sihp;
			m21 += hy * hx * sihp;
			m22 += hy * hy * sihp;
			m13 += hx * rhsc;
			m23 += hy * rhsc;
		}
	}
	const det = m11 * m22 - m12 * m21;
	return [(m13 * m22 - m12 * m23) / det, (m11 * m23 - m21 * m13) / det];
}
