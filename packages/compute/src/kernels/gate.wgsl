// Evaluate one 2-D gate (polygon or rectangle) over a window of events, AND with the parent mask,
// write a 0/1 mask, and count members (workgroup reduction + one atomic per workgroup).
// Coordinates are in the space the gate was drawn in (transformed display space).

struct Params {
  count: u32,
  nverts: u32,      // polygon vertex count (0 → rectangle)
  hasParent: u32,
  _pad: u32,
  rect: vec4f,      // minx, maxx, miny, maxy (rectangle only)
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> x: array<f32>;
@group(0) @binding(2) var<storage, read> y: array<f32>;
@group(0) @binding(3) var<storage, read> parent: array<u32>;
@group(0) @binding(4) var<storage, read> verts: array<vec2f>;
@group(0) @binding(5) var<storage, read_write> mask: array<u32>;
@group(0) @binding(6) var<storage, read_write> counter: atomic<u32>;

var<workgroup> partial: array<u32, 256>;

fn inPolygon(p: vec2f) -> bool {
  // Even-odd crossing test; boundary is treated as outside for horizontal-ray ties.
  var inside = false;
  let n = params.nverts;
  var j = n - 1u;
  for (var i = 0u; i < n; i++) {
    let a = verts[i];
    let b = verts[j];
    if ((a.y > p.y) != (b.y > p.y)) {
      let xint = a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y);
      if (p.x < xint) { inside = !inside; }
    }
    j = i;
  }
  return inside;
}

fn isNan(v: f32) -> bool { return (bitcast<u32>(v) & 0x7fffffffu) > 0x7f800000u; }

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let i = gid.x;
  var hit = 0u;
  if (i < params.count) {
    let p = vec2f(x[i], y[i]);
    var ok = !isNan(p.x) && !isNan(p.y);
    if (ok && params.hasParent != 0u) { ok = parent[i] != 0u; }
    if (ok) {
      if (params.nverts == 0u) {
        ok = p.x >= params.rect.x && p.x <= params.rect.y && p.y >= params.rect.z && p.y <= params.rect.w;
      } else {
        ok = inPolygon(p);
      }
    }
    hit = select(0u, 1u, ok);
    mask[i] = hit;
  }
  partial[lid.x] = hit;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (lid.x < s) { partial[lid.x] += partial[lid.x + s]; }
    workgroupBarrier();
  }
  if (lid.x == 0u && partial[0] > 0u) { atomicAdd(&counter, partial[0]); }
}
