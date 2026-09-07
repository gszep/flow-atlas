// labels[i*words + word] |= mask[i] << bit
struct Params { count: u32, words: u32, word: u32, bit: u32, labelsBase: u32, _p0: u32, _p1: u32, _p2: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> mask: array<u32>;
@group(0) @binding(2) var<storage, read_write> labels: array<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  if (mask[i] != 0u) { labels[(params.labelsBase + i) * params.words + params.word] |= (1u << params.bit); }
}
