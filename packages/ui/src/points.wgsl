struct View { scale: vec2f, offset: vec2f, pointSize: vec2f, _pad: vec2f };
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> pos: array<vec2f>;
@group(0) @binding(2) var<storage, read> color: array<u32>;

struct VOut { @builtin(position) p: vec4f, @location(0) c: vec4f, @location(1) uv: vec2f };

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var quad = array<vec2f, 4>(vec2f(-1,-1), vec2f(1,-1), vec2f(-1,1), vec2f(1,1));
  let c = color[ii];
  let foreground = (c >> 24u) == 254u;
  var o: VOut;
  let a = f32(c >> 24u) / 255.0;
  if (a == 0.0) { o.p = vec4f(2.0, 2.0, 2.0, 1.0); return o; }   // clipped away
  let q = quad[vi];
  let center = pos[ii] * view.scale + view.offset;
  o.p = vec4f(center + q * view.pointSize, select(0.5, 0.0, foreground), 1.0);
  o.c = vec4f(vec3f(f32(c & 255u), f32((c >> 8u) & 255u), f32((c >> 16u) & 255u)) / 255.0, select(0.85, 1.0, foreground));
  o.uv = q;
  return o;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
  if (dot(in.uv, in.uv) > 1.0) { discard; }
  return in.c;
}
