struct Params { count: u32, histogram: u32, _p0: u32, _p1: u32 };
struct Summary { low: atomic<u32>, high: atomic<u32>, finiteCount: atomic<u32>, bins: array<atomic<u32>, 128> };
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> column: array<f32>;
@group(0) @binding(2) var<storage, read> mask: array<u32>;
@group(0) @binding(3) var<storage, read_write> summary: Summary;

fn ordered(v: f32) -> u32 {
  // Canonicalize negative zero so min/max do not depend on its sign.
  let bits = bitcast<u32>(select(v, 0.0, v == 0.0));
  return select(bits ^ 0x80000000u, ~bits, (bits & 0x80000000u) != 0u);
}
fn decode(bits: u32) -> f32 {
  return bitcast<f32>(select(~bits, bits ^ 0x80000000u, (bits & 0x80000000u) != 0u));
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= p.count || mask[i] == 0u) { return; }
  let v = column[i];
  if ((bitcast<u32>(v) & 0x7fffffffu) >= 0x7f800000u) { return; }
  if (p.histogram == 0u) {
    atomicMin(&summary.low, ordered(v));
    atomicMax(&summary.high, ordered(v));
    atomicAdd(&summary.finiteCount, 1u);
  } else {
    let lo = decode(atomicLoad(&summary.low));
    let hi = decode(atomicLoad(&summary.high));
    var t = 0.0;
    if (hi > lo) {
      if ((bitcast<u32>(hi - lo) & 0x7fffffffu) >= 0x7f800000u) {
        t = (v * 0.5 - lo * 0.5) / (hi * 0.5 - lo * 0.5);
      } else { t = (v - lo) / (hi - lo); }
    }
    atomicAdd(&summary.bins[min(127u, u32(clamp(t, 0.0, 1.0) * 128.0))], 1u);
  }
}
