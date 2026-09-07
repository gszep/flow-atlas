// Per-event RGBA8 colour + visibility from labels/groups or a channel value.
struct Params {
  count: u32, words: u32, mode: u32, npop: u32,   // mode 0 = labels, 1 = channel
  lo: f32, hi: f32, nlevels: u32, defaultColor: u32,
  unlabelledSelected: u32, _p0: u32, _p1: u32, _p2: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> labels: array<u32>;
@group(0) @binding(2) var<storage, read> sampleId: array<u32>;
@group(0) @binding(3) var<storage, read> sampleVisible: array<u32>;
@group(0) @binding(4) var<storage, read> popSelected: array<u32>;   // words
@group(0) @binding(5) var<storage, read> popColor: array<u32>;      // npop RGBA8
@group(0) @binding(6) var<storage, read> channel: array<f32>;
@group(0) @binding(7) var<storage, read> palette: array<u32>;       // nlevels RGBA8
@group(0) @binding(8) var<storage, read_write> color: array<u32>;

fn isNan(v: f32) -> bool { return (bitcast<u32>(v) & 0x7fffffffu) > 0x7f800000u; }

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.count) { return; }
  var visible = sampleVisible[sampleId[i]] != 0u;
  var anySelected = false;
  var c = params.defaultColor;
  var lastPop = 0xffffffffu;
  for (var w = 0u; w < params.words; w++) {
    let bits = labels[i * params.words + w];
    if ((bits & popSelected[w]) != 0u) { anySelected = true; }
    var b = bits;
    while (b != 0u) {
      let t = firstTrailingBit(b);
      lastPop = w * 32u + t;
      b &= b - 1u;
    }
  }
  if (lastPop == 0xffffffffu) { anySelected = params.unlabelledSelected != 0u; }
  visible = visible && anySelected;
  if (params.mode == 0u) {
    if (lastPop != 0xffffffffu && lastPop < params.npop) { c = popColor[lastPop]; }
  } else {
    let v = channel[i];
    if (isNan(v)) { visible = false; } else {
      let t = clamp((v - params.lo) / max(params.hi - params.lo, 1e-9), 0.0, 0.999999);
      c = palette[u32(t * f32(params.nlevels))];
    }
  }
  color[i] = select(c & 0x00ffffffu, c, visible);   // alpha 0 hides
}
