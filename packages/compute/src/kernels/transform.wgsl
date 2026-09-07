// Apply a monotone lookup table (x ascending → y) to a column: linear interpolation, flat
// extrapolation, NaN passthrough. Binary search over the table (4097 entries for biex).

struct Params { count: u32, tableLen: u32 };

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> input: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;
@group(0) @binding(3) var<storage, read> tableX: array<f32>;
@group(0) @binding(4) var<storage, read> tableY: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  let v = input[i];
  if (v != v) { output[i] = v; return; }
  let n = params.tableLen;
  if (v <= tableX[0]) { output[i] = tableY[0]; return; }
  if (v >= tableX[n - 1u]) { output[i] = tableY[n - 1u]; return; }
  var lo = 0u;
  var hi = n - 1u;
  while (hi - lo > 1u) {
    let mid = (lo + hi) >> 1u;
    if (tableX[mid] <= v) { lo = mid; } else { hi = mid; }
  }
  let x0 = tableX[lo];
  let x1 = tableX[hi];
  let y0 = tableY[lo];
  let y1 = tableY[hi];
  if (x1 == x0) { output[i] = y0; return; }
  output[i] = y0 + (v - x0) / (x1 - x0) * (y1 - y0);
}
