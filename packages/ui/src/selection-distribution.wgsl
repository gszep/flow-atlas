struct Params { count: u32, histogram: u32, stride: u32, offset: u32 };
struct Summary { low: atomic<u32>, high: atomic<u32>, finiteCount: atomic<u32>, bins: array<atomic<u32>, 128> };
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> column: array<f32>;
@group(0) @binding(2) var<storage, read> mask: array<u32>;
@group(0) @binding(3) var<storage, read_write> summary: Summary;
var<workgroup> low: atomic<u32>;
var<workgroup> high: atomic<u32>;
var<workgroup> count: atomic<u32>;
var<workgroup> bins: array<atomic<u32>, 128>;
fn ordered(v: f32) -> u32 {
  let bits = bitcast<u32>(select(v, 0.0, v == 0.0));
  return select(bits ^ 0x80000000u, ~bits, (bits & 0x80000000u) != 0u);
}
fn decode(bits: u32) -> f32 {
  return bitcast<f32>(select(~bits, bits ^ 0x80000000u, (bits & 0x80000000u) != 0u));
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  if (lid.x == 0u) { atomicStore(&low, 0xffffffffu); atomicStore(&high, 0u); atomicStore(&count, 0u); }
  if (lid.x < 128u) { atomicStore(&bins[lid.x], 0u); }
  workgroupBarrier();
  // Every lane reaches both barriers, including unselected/tail/nonfinite lanes.
  if (gid.x < p.count) {
    if (mask[gid.x] != 0u) {
      let stride = max(1u, p.stride);
      let v = column[gid.x * stride + p.offset];
      var pairedFinite = true;
      if (stride == 2u) { pairedFinite = (bitcast<u32>(column[gid.x * 2u + (1u-p.offset)]) & 0x7fffffffu) < 0x7f800000u; }
      if ((bitcast<u32>(v) & 0x7fffffffu) < 0x7f800000u && pairedFinite) {
        if (p.histogram == 0u) {
          atomicMin(&low, ordered(v)); atomicMax(&high, ordered(v)); atomicAdd(&count, 1u);
        } else {
          let lo = decode(atomicLoad(&summary.low)); let hi = decode(atomicLoad(&summary.high));
          var t = 0.0;
          if (hi > lo) {
            if ((bitcast<u32>(hi-lo) & 0x7fffffffu) >= 0x7f800000u) { t = (v*0.5-lo*0.5)/(hi*0.5-lo*0.5); }
            else { t = (v-lo)/(hi-lo); }
          }
          atomicAdd(&bins[min(127u, u32(clamp(t, 0.0, 1.0)*128.0))], 1u);
        }
      }
    }
  }
  workgroupBarrier();
  if (p.histogram == 0u && lid.x == 0u) {
    let n = atomicLoad(&count);
    if (n > 0u) { atomicMin(&summary.low, atomicLoad(&low)); atomicMax(&summary.high, atomicLoad(&high)); atomicAdd(&summary.finiteCount, n); }
  }
  if (p.histogram != 0u && lid.x < 128u) {
    let n = atomicLoad(&bins[lid.x]); if (n > 0u) { atomicAdd(&summary.bins[lid.x], n); }
  }
}
