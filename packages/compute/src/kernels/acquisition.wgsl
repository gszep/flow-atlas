struct Params { count: u32, channels: u32 }
struct Channel { mode: u32, decades: f32, log0: f32, range: f32, gain: f32, timestep: f32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var<storage, read> input: array<u32>;
@group(0) @binding(2) var<storage, read_write> output: array<u32>;
@group(0) @binding(3) var<storage, read> channels: array<Channel>;
@group(0) @binding(4) var<storage, read_write> errors: atomic<u32>;
const MIN: f32 = 0x1p-126;
const MAX: f32 = 0x1.fffffep127;
fn valid(v: f32) -> bool {
    let bits = bitcast<u32>(v) & 0x7fffffffu;
    return bits == 0u || (bits >= 0x00800000u && bits < 0x7f800000u);
}
// Guard before arithmetic: WGSL can assume finite values and flush subnormals.
fn multiply_ok(a: f32, b: f32) -> bool {
    if a == 0.0 { return true; }
    if b > 1.0 { return abs(a) <= MAX / b; }
    return abs(a) >= MIN / b;
}
fn divide_ok(a: f32, b: f32) -> bool {
    if a == 0.0 { return true; }
    if b < 1.0 { return abs(a) <= MAX * b; }
    return abs(a) >= MIN * b;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = id.x;
    if i >= p.count { return; }
    let c = channels[i % p.channels];
    let bits = input[i];
    if c.mode == 0u { output[i] = bits; return; }
    var v = bitcast<f32>(bits);
    var ok = valid(v);
    if ok && c.mode == 2u {
        ok = multiply_ok(v, c.decades);
        if ok { v *= c.decades; ok = valid(v) && divide_ok(v, c.range); }
        if ok { v /= c.range; ok = valid(v) && multiply_ok(v, 3.321928094887362); }
        if ok {
            v *= 3.321928094887362;
            ok = valid(v) && v >= -126.0 && v <= 127.99998;
        }
        if ok { v = exp2(v); ok = valid(v) && v != 0.0 && multiply_ok(v, c.log0); }
        if ok { v *= c.log0; ok = valid(v) && v != 0.0; }
    }
    if ok {
        if c.mode == 3u {
            ok = multiply_ok(v, c.timestep);
            if ok { v *= c.timestep; }
        } else {
            ok = divide_ok(v, c.gain);
            if ok { v /= c.gain; }
        }
    }
    if !ok || !valid(v) { atomicAdd(&errors, 1u); return; }
    output[i] = bitcast<u32>(v);
}
