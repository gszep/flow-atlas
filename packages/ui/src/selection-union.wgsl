struct Params { count: u32, _p0: u32, _p1: u32, _p2: u32 };
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> inputMask: array<u32>;
@group(0) @binding(2) var<storage, read_write> outputMask: array<u32>;
@group(0) @binding(3) var<storage, read_write> selected: atomic<u32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i=gid.x;
  if (i>=p.count) { return; }
  if (inputMask[i]!=0u && outputMask[i]==0u) {
    outputMask[i]=1u;
    atomicAdd(&selected,1u);
  }
}
