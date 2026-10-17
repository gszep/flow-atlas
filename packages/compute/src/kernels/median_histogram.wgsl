struct Params { rows: u32, stride: u32, targets: u32, ranges: u32, digit: u32, hasMask: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> input: array<u32>;
// Target indices followed by (channel, lower key, upper key) range triples.
@group(0) @binding(2) var<storage, read> metadata: array<u32>;
@group(0) @binding(3) var<storage, read> state: array<u32>;
@group(0) @binding(4) var<storage, read_write> histogram: array<atomic<u32>>;
// Selected rows, nonfinite target flag, impossible rank flag.
@group(0) @binding(5) var<storage, read_write> counts: array<atomic<u32>>;
// Window-local borrowed membership, uploaded without CPU event filtering. Dummy when hasMask=0.
@group(0) @binding(6) var<storage, read> membership: array<u32>;
fn finite(bits: u32) -> bool { return (bits & 0x7f800000u) != 0x7f800000u; }
fn key(raw: u32) -> u32 {
    var bits = raw;
    if ((bits & 0x7fffffffu) == 0u) { bits = 0u; }
    if ((bits & 0x80000000u) != 0u) { return ~bits; }
    return bits ^ 0x80000000u;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let row = id.x;
    if (row >= p.rows) { return; }
    if (p.hasMask != 0u) {
        if (membership[row] == 0u) { return; }
    }
    for (var r = 0u; r < p.ranges; r++) {
        let m = p.targets + 3u * r;
        let bits = input[row * p.stride + metadata[m]];
        let v = key(bits);
        if (!finite(bits) || v < metadata[m + 1u] || v > metadata[m + 2u]) { return; }
    }
    atomicAdd(&counts[0], 1u);
    let shift = 24u - 8u * p.digit;
    var mask = 0u;
    if (p.digit != 0u) { mask = 0xffffffffu << (32u - 8u * p.digit); }
    for (var t = 0u; t < p.targets; t++) {
        let bits = input[row * p.stride + metadata[t]];
        if (!finite(bits)) { atomicOr(&counts[1], 1u); continue; }
        let v = key(bits);
        for (var endpoint = 0u; endpoint < 2u; endpoint++) {
            let lane = 2u * t + endpoint;
            if ((v & mask) == state[2u * lane]) {
                atomicAdd(&histogram[lane * 256u + ((v >> shift) & 255u)], 1u);
            }
        }
    }
}
