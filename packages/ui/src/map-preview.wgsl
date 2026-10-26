struct Transform { scale: vec2f, offset: vec2f };
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var imageSampler: sampler;
@group(0) @binding(2) var<uniform> transform: Transform;
struct Vertex { @builtin(position) position: vec4f, @location(0) ndc: vec2f };
@vertex
fn vs(@builtin(vertex_index) index: u32) -> Vertex {
  var triangle = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var out: Vertex;
  out.ndc = triangle[index];
  out.position = vec4f(out.ndc, 0, 1);
  return out;
}
@fragment
fn fs(in: Vertex) -> @location(0) vec4f {
  let source = (in.ndc - transform.offset) / transform.scale;
  let uv = vec2f(source.x * 0.5 + 0.5, 0.5 - source.y * 0.5);
  let pixel = textureSampleLevel(image, imageSampler, uv, 0);
  if (any(uv < vec2f(0)) || any(uv > vec2f(1))) { return vec4f(0.07, 0.07, 0.07, 1); }
  return pixel;
}
