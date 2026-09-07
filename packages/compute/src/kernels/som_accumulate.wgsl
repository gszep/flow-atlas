// Batch-SOM epoch: for a strided subsample of events, find the BMU and accumulate the event into
// per-code numerator (sum of features) and denominator (count). Float sums use CAS atomics.

struct Params { count: u32, d: u32, ncodes: u32, stride: u32 };

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> features: array<f32>;
@group(0) @binding(2) var<storage, read> codes: array<f32>;
@group(0) @binding(3) var<storage, read_write> num: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> den: array<atomic<u32>>;

fn atomicAddF32(idx: u32, v: f32) {
  var old = atomicLoad(&num[idx]);
  loop {
    let nw = bitcast<u32>(bitcast<f32>(old) + v);
    let r = atomicCompareExchangeWeak(&num[idx], old, nw);
    if (r.exchanged) { break; }
    old = r.old_value;
  }
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x * params.stride;
  if (i >= params.count) { return; }
  let d = params.d;
  let base = i * d;
  var best = 0u;
  var bestDist = 3.4e38;
  for (var j = 0u; j < params.ncodes; j++) {
    var s = 0.0;
    for (var k = 0u; k < d; k++) {
      let t = features[base + k] - codes[j * d + k];
      s += t * t;
    }
    if (s < bestDist) { bestDist = s; best = j; }
  }
  for (var k = 0u; k < d; k++) { atomicAddF32(best * d + k, features[base + k]); }
  atomicAdd(&den[best], 1u);
}
