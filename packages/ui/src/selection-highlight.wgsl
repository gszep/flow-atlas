struct Params { count: u32, selectedColor: u32, mode: u32, _p2: u32 };
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> mask: array<u32>;
@group(0) @binding(2) var<storage, read> source: array<u32>;
@group(0) @binding(3) var<storage, read_write> outputColors: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= p.count) { return; }
  if (p.mode == 1u) { outputColors[i] = (source[i] & 0xff000000u) | 0x00383838u; return; }
  // 254 marks an opaque foreground population. Explicit selection overrides
  // display-only filters; the original source color/visibility buffer is untouched.
  if (p.mode == 2u) { if (mask[i]!=0u) { outputColors[i]=0xfe000000u | p.selectedColor; } return; }
  // RGBA8 selection / dim neutral context; retain original visibility and alpha.
  outputColors[i] = (source[i] & 0xff000000u) | select(0x00383838u, p.selectedColor, mask[i] != 0u);
}
