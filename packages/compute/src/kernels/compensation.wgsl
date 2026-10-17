struct Params { rows: u32, channels: u32, n: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> input: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@group(0) @binding(3) var<storage, read> inverse: array<f32>;
@group(0) @binding(4) var<storage, read> indices: array<u32>;
@group(0) @binding(5) var<storage, read_write> errors: atomic<u32>;
fn finite(v: f32) -> bool { return (bitcast<u32>(v) & 0x7f800000u) != 0x7f800000u; }
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let row = id.x;
  if (row >= p.rows) { return; }
  // Copy as bits to preserve even nonparticipating NaN payloads and subnormals.
  for (var c = 0u; c < p.channels; c++) { output[row*p.channels+c] = input[row*p.channels+c]; }
  for (var c = 0u; c < p.n; c++) {
    var value = 0.0;
    var valid = true;
    for (var j = 0u; j < p.n; j++) {
      let y = bitcast<f32>(input[row*p.channels+indices[j]]);
      value += y*inverse[j*p.n+c]; // row x = row y * inverse(S), NOT inverse(S).T
      valid = valid && finite(y) && finite(value);
    }
    if (!valid) { atomicAdd(&errors, 1u); }
    output[row*p.channels+indices[c]] = bitcast<u32>(value);
  }
}
