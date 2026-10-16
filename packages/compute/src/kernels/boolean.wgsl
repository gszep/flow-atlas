// Fold one operand into a sample-local mask. The final fold restricts to the parent
// domain and counts members. Empty AND/OR use their true/false identities.
struct Params {
  count: u32, op: u32, first: u32, last: u32,
  hasOperand: u32, hasParent: u32, _p0: u32, _p1: u32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> operand: array<u32>;
@group(0) @binding(2) var<storage, read> parent: array<u32>;
@group(0) @binding(3) var<storage, read_write> mask: array<u32>;
@group(0) @binding(4) var<storage, read_write> counter: atomic<u32>;
var<workgroup> partial: array<u32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let i = gid.x;
  var hit = 0u;
  if (i < params.count) {
    var ok = params.op == 0u;
    if (params.first == 0u) { ok = mask[i] != 0u; }
    if (params.hasOperand != 0u) {
      let value = operand[i] != 0u;
      if (params.op == 0u) { ok = ok && value; }
      else if (params.op == 1u) { ok = ok || value; }
      else { ok = !value; }
    }
    if (params.last != 0u && params.hasParent != 0u) { ok = ok && parent[i] != 0u; }
    mask[i] = select(0u, 1u, ok);
    if (params.last != 0u) { hit = mask[i]; }
  }
  partial[lid.x] = hit;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (lid.x < s) { partial[lid.x] += partial[lid.x + s]; }
    workgroupBarrier();
  }
  if (lid.x == 0u && partial[0] > 0u) { atomicAdd(&counter, partial[0]); }
}
