// Exploratory embedding-space selection; this is NOT a raw-channel gate.
struct Params {
  count: u32, words: u32, population: u32, vertices: u32,
  mode: u32, intersect: u32, finalPass: u32, rangeFlags: u32,
  lo: f32, hi: f32, boundsLow: vec2f, boundsHigh: vec2f, _pad: vec2f,
};
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> positions: array<vec2f>;
@group(0) @binding(2) var<storage, read> labels: array<u32>;
@group(0) @binding(3) var<storage, read> column: array<f32>;
@group(0) @binding(4) var<storage, read_write> mask: array<u32>;
@group(0) @binding(5) var<storage, read> polygon: array<vec2f>;
@group(0) @binding(6) var<storage, read_write> selected: atomic<u32>;

fn finite(v: f32) -> bool { return (bitcast<u32>(v) & 0x7fffffffu) < 0x7f800000u; }
fn inside(v: vec2f) -> bool {
  if (!finite(v.x) || !finite(v.y)) { return false; }
  if (any(v < p.boundsLow) || any(v > p.boundsHigh)) { return false; }
  var hit = false;
  var j = p.vertices - 1u;
  for (var k = 0u; k < p.vertices; k++) {
    let a = polygon[j];
    let b = polygon[k];
    // Scale before subtraction to avoid overflow for finite extreme coordinates.
    let scale = max(max(max(abs(a.x), abs(a.y)), max(abs(b.x), abs(b.y))), max(max(abs(v.x), abs(v.y)), 1.0));
    let aa = a / scale; let bb = b / scale; let vv = v / scale;
    let cross = (vv.x - aa.x) * (bb.y - aa.y) - (vv.y - aa.y) * (bb.x - aa.x);
    if (cross == 0.0 && all(v >= min(a, b)) && all(v <= max(a, b))) { return true; }
    if ((a.y > v.y) != (b.y > v.y)) {
      let x = aa.x + (vv.y - aa.y) / (bb.y - aa.y) * (bb.x - aa.x);
      if (vv.x < x) { hit = !hit; }
    }
    j = k;
  }
  return hit;
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= p.count) { return; }
  var hit = false;
  if (p.mode == 0u) {
    hit = inside(positions[i]);
  } else if (p.mode == 1u) {
    hit = (labels[i * p.words + p.population / 32u] & (1u << (p.population % 32u))) != 0u;
  } else if (p.mode == 2u) {
    let v = column[i];
    hit = finite(v) && ((p.rangeFlags & 1u) == 0u || v >= p.lo) && ((p.rangeFlags & 2u) == 0u || v <= p.hi);
  } else { hit = true; }
  if (p.intersect != 0u) { hit = hit && mask[i] != 0u; }
  mask[i] = select(0u, 1u, hit);
  if (p.finalPass != 0u && hit) { atomicAdd(&selected, 1u); }
}
