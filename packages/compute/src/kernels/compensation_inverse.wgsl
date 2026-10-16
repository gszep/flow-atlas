// Small, setup-only partial-pivot Gauss-Jordan inversion. No CPU numerical solve.
struct Params { n: u32 }
struct Diagnostics { status: u32, errors: u32, condition: f32, residual: f32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> original: array<f32>;
@group(0) @binding(2) var<storage, read_write> a: array<f32>;
@group(0) @binding(3) var<storage, read_write> inverse: array<f32>;
@group(0) @binding(4) var<storage, read_write> d: Diagnostics;
fn finite(v: f32) -> bool { return (bitcast<u32>(v) & 0x7f800000u) != 0x7f800000u; }
fn fail(code: u32) { d.status = code; d.errors = d.errors + 1u; }
@compute @workgroup_size(1)
fn main() {
  let n = p.n;
  d.status = 0u; d.errors = 0u; d.condition = 0.0; d.residual = 0.0;
  for (var i = 0u; i < n; i++) {
    for (var j = 0u; j < n; j++) {
      a[i*n+j] = original[i*n+j];
      inverse[i*n+j] = select(0.0, 1.0, i == j);
    }
  }
  for (var c = 0u; c < n; c++) {
    var pivot = c;
    for (var r = c+1u; r < n; r++) {
      if (abs(a[r*n+c]) > abs(a[pivot*n+c])) { pivot = r; }
    }
    let v = a[pivot*n+c];
    if (!finite(v) || abs(v) < 1.17549435e-38) { fail(1u); return; }
    for (var j = 0u; j < n; j++) {
      let av = a[c*n+j]; a[c*n+j] = a[pivot*n+j]; a[pivot*n+j] = av;
      let iv = inverse[c*n+j]; inverse[c*n+j] = inverse[pivot*n+j]; inverse[pivot*n+j] = iv;
    }
    for (var j = 0u; j < n; j++) {
      a[c*n+j] = a[c*n+j] / v;
      inverse[c*n+j] = inverse[c*n+j] / v;
      if (!finite(a[c*n+j]) || !finite(inverse[c*n+j])) { fail(2u); return; }
    }
    for (var r = 0u; r < n; r++) {
      if (r == c) { continue; }
      let factor = a[r*n+c];
      for (var j = 0u; j < n; j++) {
        a[r*n+j] = a[r*n+j] - factor*a[c*n+j];
        inverse[r*n+j] = inverse[r*n+j] - factor*inverse[c*n+j];
        if (!finite(a[r*n+j]) || !finite(inverse[r*n+j])) { fail(2u); return; }
      }
    }
  }
  var norm = 0.0; var invnorm = 0.0; var residual = 0.0;
  for (var i = 0u; i < n; i++) {
    var rowsum = 0.0; var invsum = 0.0; var leftsum = 0.0; var rightsum = 0.0;
    for (var j = 0u; j < n; j++) {
      rowsum += abs(original[i*n+j]); invsum += abs(inverse[i*n+j]);
      var left = 0.0; var right = 0.0;
      for (var t = 0u; t < n; t++) {
        left += original[i*n+t]*inverse[t*n+j];
        right += inverse[i*n+t]*original[t*n+j];
      }
      leftsum += abs(left-select(0.0, 1.0, i == j));
      rightsum += abs(right-select(0.0, 1.0, i == j));
    }
    if (!finite(rowsum) || !finite(invsum) || !finite(leftsum) || !finite(rightsum)) { fail(2u); return; }
    norm = max(norm, rowsum); invnorm = max(invnorm, invsum);
    residual = max(residual, max(leftsum, rightsum));
  }
  let condition = norm*invnorm;
  if (!finite(condition)) { fail(2u); return; }
  d.condition = condition; d.residual = residual;
  if (condition > 10000.0 || residual > 0.001) { fail(3u); }
}
