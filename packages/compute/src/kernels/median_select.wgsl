struct Params { rows: u32, stride: u32, targets: u32, ranges: u32, digit: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read_write> state: array<u32>;
@group(0) @binding(2) var<storage, read> histogram: array<u32>;
@group(0) @binding(3) var<storage, read_write> counts: array<atomic<u32>>;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let lane = id.x;
    if (lane >= 2u * p.targets) { return; }
    var rank = state[2u * lane + 1u];
    if (p.digit == 0u) {
        let count = atomicLoad(&counts[0]);
        rank = (count - 1u) / 2u;
        if ((lane & 1u) == 1u) { rank = count / 2u; }
    }
    for (var bin = 0u; bin < 256u; bin++) {
        let n = histogram[lane * 256u + bin];
        if (rank < n) {
            state[2u * lane] |= bin << (24u - 8u * p.digit);
            state[2u * lane + 1u] = rank;
            return;
        }
        rank -= n;
    }
    atomicOr(&counts[2], 1u);
}
