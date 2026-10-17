// Setup only: column-pivoted Householder QR of A = reference.T / maxAbs(reference).
// One invocation owns all scratch. No normal equations or CPU numerical fallback.
struct Params { detectors: u32, fluorochromes: u32 }
struct Diagnostics {
  status: u32, errors: u32, rank: u32, reserved: u32,
  condition: f32, leftResidual: f32, symmetryResidual: f32, scale: f32,
}
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> original: array<f32>;
@group(0) @binding(2) var<storage, read_write> a: array<f32>;
@group(0) @binding(3) var<storage, read_write> qt: array<f32>;
@group(0) @binding(4) var<storage, read_write> inverse: array<f32>;
@group(0) @binding(5) var<storage, read_write> d: Diagnostics;
fn finite(v: f32) -> bool { return (bitcast<u32>(v) & 0x7f800000u) != 0x7f800000u; }
fn fail(code: u32) { d.status = code; d.errors = 1u; }
@compute @workgroup_size(1)
fn main() {
  let m = p.detectors; let n = p.fluorochromes;
  var permutation: array<u32, 128>;
  var v: array<f32, 128>;
  var x: array<f32, 128>;
  var scale = 0.0;
  for (var i = 0u; i < m*n; i++) { scale = max(scale, abs(original[i])); }
  d.scale = scale;
  if (scale == 0.0) { fail(1u); return; }
  for (var i = 0u; i < m; i++) {
    for (var j = 0u; j < n; j++) { a[i*n+j] = original[j*m+i]/scale; }
    for (var j = 0u; j < m; j++) { qt[i*m+j] = select(0.0, 1.0, i == j); }
  }
  for (var j = 0u; j < n; j++) { permutation[j] = j; }
  var initialNorm = 0.0;
  for (var c = 0u; c < n; c++) {
    var pivot = c; var normSquared = 0.0;
    // Recompute trailing norms, avoiding unstable downdates.
    for (var j = c; j < n; j++) {
      var s = 0.0;
      for (var i = c; i < m; i++) { s += a[i*n+j]*a[i*n+j]; }
      if (!finite(s)) { fail(2u); return; }
      if (s > normSquared) { normSquared = s; pivot = j; }
    }
    let norm = sqrt(normSquared);
    if (c == 0u) { initialNorm = norm; }
    if (norm <= 0.000001*initialNorm) { fail(1u); return; }
    let oldIndex = permutation[c]; permutation[c] = permutation[pivot]; permutation[pivot] = oldIndex;
    for (var i = 0u; i < m; i++) {
      let old = a[i*n+c]; a[i*n+c] = a[i*n+pivot]; a[i*n+pivot] = old;
    }
    // Unit Householder vector: normalized column plus a same-sign unit vector.
    for (var i = c; i < m; i++) { v[i] = a[i*n+c]/norm; }
    v[c] += select(-1.0, 1.0, v[c] >= 0.0);
    var vv = 0.0;
    for (var i = c; i < m; i++) { vv += v[i]*v[i]; }
    let beta = 2.0/vv;
    for (var j = c; j < n; j++) {
      var dot = 0.0;
      for (var i = c; i < m; i++) { dot += v[i]*a[i*n+j]; }
      for (var i = c; i < m; i++) { a[i*n+j] -= beta*v[i]*dot; }
    }
    for (var j = 0u; j < m; j++) {
      var dot = 0.0;
      for (var i = c; i < m; i++) { dot += v[i]*qt[i*m+j]; }
      for (var i = c; i < m; i++) { qt[i*m+j] -= beta*v[i]*dot; }
    }
    d.rank = c+1u;
  }
  // Triangular solve for every RHS; restore fluorochrome order.
  for (var j = 0u; j < m; j++) {
    for (var step = 0u; step < n; step++) {
      let i = n-1u-step;
      var value = qt[i*m+j];
      for (var t = i+1u; t < n; t++) { value -= a[i*n+t]*x[t]; }
      x[i] = value/a[i*n+i];
      if (!finite(x[i])) { fail(2u); return; }
      inverse[permutation[i]*m+j] = x[i];
    }
  }
  // Infinity condition of the rectangular map; left inverse and orthogonal-projector checks.
  var normA = 0.0; var normP = 0.0;
  for (var i = 0u; i < m; i++) {
    var rowNorm = 0.0;
    for (var j = 0u; j < n; j++) { rowNorm += abs(original[j*m+i]/scale); }
    normA = max(normA, rowNorm);
  }
  for (var i = 0u; i < n; i++) {
    var rowNorm = 0.0; var residual = 0.0;
    for (var t = 0u; t < m; t++) { rowNorm += abs(inverse[i*m+t]); }
    normP = max(normP, rowNorm);
    for (var j = 0u; j < n; j++) {
      var value = 0.0;
      for (var t = 0u; t < m; t++) { value += inverse[i*m+t]*(original[j*m+t]/scale); }
      residual += abs(value-select(0.0, 1.0, i == j));
    }
    if (!finite(residual)) { fail(2u); return; }
    d.leftResidual = max(d.leftResidual, residual);
  }
  for (var i = 0u; i < m; i++) {
    var residual = 0.0;
    for (var j = 0u; j < m; j++) {
      var left = 0.0; var right = 0.0;
      for (var t = 0u; t < n; t++) {
        left += (original[t*m+i]/scale)*inverse[t*m+j];
        right += (original[t*m+j]/scale)*inverse[t*m+i];
      }
      residual += abs(left-right);
    }
    if (!finite(residual)) { fail(2u); return; }
    d.symmetryResidual = max(d.symmetryResidual, residual);
  }
  d.condition = normA*normP;
  if (!finite(d.condition)) { fail(2u); return; }
  if (d.condition > 10000.0 || d.leftResidual > 0.001 || d.symmetryResidual > 0.001) { fail(3u); return; }
  for (var i = 0u; i < n*m; i++) {
    let before = inverse[i];
    inverse[i] = before/scale;
    if (!finite(inverse[i]) || (before != 0.0 && abs(inverse[i]) < 1.17549435e-38)) { fail(2u); return; }
  }
}
