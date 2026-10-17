struct Params { rows: u32, inputs: u32, outputs: u32, detectors: u32, fluorochromes: u32, residual: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> input: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@group(0) @binding(3) var<storage, read> inverse: array<f32>;
@group(0) @binding(4) var<storage, read> original: array<f32>;
@group(0) @binding(5) var<storage, read> indices: array<u32>;
@group(0) @binding(6) var<storage, read_write> errors: atomic<u32>;
fn finite(v: f32) -> bool { return (bitcast<u32>(v) & 0x7f800000u) != 0x7f800000u; }
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let row = id.x;
  if (row >= p.rows) { return; }
  for (var c = 0u; c < p.inputs; c++) { output[row*p.outputs+c] = input[row*p.inputs+c]; }
  var valid = true;
  for (var c = 0u; c < p.fluorochromes; c++) {
    var value = 0.0;
    for (var j = 0u; j < p.detectors; j++) {
      let y = bitcast<f32>(input[row*p.inputs+indices[j]]);
      value += y*inverse[c*p.detectors+j];
      valid = valid && finite(y) && finite(value);
    }
    output[row*p.outputs+p.inputs+c] = bitcast<u32>(value);
  }
  if (p.residual != 0u) {
    // Scaled sum-of-squares avoids squaring large residuals directly.
    var scale = 0.0; var ssq = 1.0;
    for (var j = 0u; j < p.detectors; j++) {
      var prediction = 0.0;
      for (var c = 0u; c < p.fluorochromes; c++) {
        prediction += bitcast<f32>(output[row*p.outputs+p.inputs+c])*original[c*p.detectors+j];
        valid = valid && finite(prediction);
      }
      let r = abs(bitcast<f32>(input[row*p.inputs+indices[j]])-prediction);
      valid = valid && finite(r);
      if (r != 0.0) {
        if (scale < r) { let ratio = scale/r; ssq = 1.0+ssq*ratio*ratio; scale = r; }
        else { let ratio = r/scale; ssq += ratio*ratio; }
      }
    }
    let residual = scale*sqrt(ssq);
    valid = valid && finite(residual);
    output[row*p.outputs+p.outputs-1u] = bitcast<u32>(residual);
  }
  // Count failing rows in this window, not an imported metadata warning or whole-file total.
  if (!valid) { atomicAdd(&errors, 1u); }
}
