// EmbedSOM (Kratochvíl et al. 2019) per event: k nearest codes → local linear projection to the
// SOM grid. Ported from GigaSOM.jl/EmbedSOM with the original C semantics for the I→J vector
// (difference, not product). k ≤ 31.

struct Params { count: u32, d: u32, ncodes: u32, k: u32, adjust: f32, boost: f32, m: f32, _p: f32 };

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> features: array<f32>;
@group(0) @binding(2) var<storage, read> codes: array<f32>;
@group(0) @binding(3) var<storage, read> grid: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> out: array<vec2f>;

const MAXK: u32 = 32u;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let d = params.d;
  let base = i * d;
  let k = params.k;
  var nk = k;
  if (nk < params.ncodes) { nk += 1u; }

  // k+1 nearest codes by insertion.
  var idx: array<u32, MAXK>;
  var dist: array<f32, MAXK>;
  for (var t = 0u; t < nk; t++) { dist[t] = 3.4e38; idx[t] = 0u; }
  for (var j = 0u; j < params.ncodes; j++) {
    var s = 0.0;
    for (var q = 0u; q < d; q++) { let t = features[base + q] - codes[j * d + q]; s += t * t; }
    s = sqrt(s);
    if (s < dist[nk - 1u]) {
      var p = nk - 1u;
      while (p > 0u && dist[p - 1u] > s) { dist[p] = dist[p - 1u]; idx[p] = idx[p - 1u]; p -= 1u; }
      dist[p] = s; idx[p] = j;
    }
  }

  // Score distribution.
  var mean = 0.0; var sd = 0.0; var wsum = 0.0;
  for (var t = 0u; t < nk; t++) {
    let w = 1.0 / f32(t + 1u);
    mean += dist[t] * w; sd += dist[t] * dist[t] * w; wsum += w;
  }
  mean /= wsum;
  sd = params.boost / sqrt(max(sd / wsum - mean * mean, 1e-20));
  let nmax = params.m / max(dist[nk - 1u], 1e-20);
  var score: array<f32, MAXK>;
  for (var t = 0u; t < k; t++) {
    var s = exp((mean - dist[t]) * sd);
    if (k < nk) { s *= (1.0 - exp(dist[t] * nmax - params.m)); }
    score[t] = s;
  }

  // Accumulate the 2x3 system.
  var m11 = 0.0; var m12 = 0.0; var m21 = 0.0; var m22 = 0.0; var m13 = 0.0; var m23 = 0.0;
  for (var a = 0u; a < k; a++) {
    let ia = idx[a];
    let gi = grid[ia];
    let is = score[a];
    let gs = 1e-9 * is;
    m11 += gs; m22 += gs; m13 += gs * gi.x; m23 += gs * gi.y;
    for (var b = a + 1u; b < k; b++) {
      let jb = idx[b];
      let gj = grid[jb];
      let js = score[b];
      var scalar = 0.0; var sqdist = 0.0;
      for (var q = 0u; q < d; q++) {
        let ci = codes[ia * d + q];
        let t = codes[jb * d + q] - ci;
        sqdist += t * t;
        scalar += t * (features[base + q] - ci);
      }
      if (scalar != 0.0) {
        if (sqdist == 0.0) { continue; }
        scalar /= sqdist;
      }
      let h = gj - gi;
      let hp = h.x * h.x + h.y * h.y;
      if (hp == 0.0) { continue; }
      let s = is * js * pow(1.0 + hp, -params.adjust) * exp(-((scalar - 0.5) * (scalar - 0.5)));
      let sihp = s / hp;
      let rhsc = s * (scalar + (h.x * gi.x + h.y * gi.y) / hp);
      m11 += h.x * h.x * sihp; m12 += h.x * h.y * sihp; m21 += h.y * h.x * sihp; m22 += h.y * h.y * sihp;
      m13 += h.x * rhsc; m23 += h.y * rhsc;
    }
  }
  let det = m11 * m22 - m12 * m21;
  out[i] = vec2f((m13 * m22 - m12 * m23) / det, (m11 * m23 - m21 * m13) / det);
}
