// features[i*d + c] = column[i], imputing NaN by simple random sampling from the events where the
// column is present (Impute.srs equivalent). Present events are given as [start,count) ranges.

struct Params { count: u32, d: u32, c: u32, nranges: u32, totalPresent: u32, seed: u32, _p0: u32, _p1: u32 };

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> column: array<f32>;
@group(0) @binding(2) var<storage, read_write> features: array<f32>;
@group(0) @binding(3) var<storage, read> ranges: array<vec2u>;   // (start, count) in column index space
@group(0) @binding(4) var<storage, read> full: array<f32>;       // the whole column (for sampling)

fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn isNan(v: f32) -> bool { return (bitcast<u32>(v) & 0x7fffffffu) > 0x7f800000u; }

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  var v = column[i];
  if (isNan(v) && params.totalPresent > 0u) {
    var r = pcg(i ^ params.seed ^ (params.c * 0x9E3779B9u)) % params.totalPresent;
    var idx = 0u;
    for (var k = 0u; k < params.nranges; k++) {
      let rg = ranges[k];
      if (r < rg.y) { idx = rg.x + r; break; }
      r -= rg.y;
    }
    v = full[idx];
  }
  features[i * params.d + params.c] = v;
}
