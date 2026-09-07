// BMU index per event.
struct Params { count: u32, d: u32, ncodes: u32, _p: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> features: array<f32>;
@group(0) @binding(2) var<storage, read> codes: array<f32>;
@group(0) @binding(3) var<storage, read_write> bmu: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let d = params.d;
  let base = i * d;
  var best = 0u;
  var bestDist = 3.4e38;
  for (var j = 0u; j < params.ncodes; j++) {
    var s = 0.0;
    for (var k = 0u; k < d; k++) { let t = features[base + k] - codes[j * d + k]; s += t * t; }
    if (s < bestDist) { bestDist = s; best = j; }
  }
  bmu[i] = best;
}
