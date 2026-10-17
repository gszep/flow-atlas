// One invocation per control. The CPU only maps names and packs endpoint metadata.
struct Params { n: u32, min_events: u32, min_separation: f32, pad: u32 }
struct Endpoints { pl: f32, pu: f32, nl: f32, nu: f32 }
struct Quality { status: u32, separation: f32, available: u32, invalid: u32, negative: u32, attempted: u32 }
struct Checked { value: f32, ok: bool }
@group(0) @binding(0) var<storage, read> p: Params;
@group(0) @binding(1) var<storage, read> endpoints: array<Endpoints>;
@group(0) @binding(2) var<storage, read> counts: array<vec2<u32>>;
@group(0) @binding(3) var<storage, read_write> matrix: array<f32>;
@group(0) @binding(4) var<storage, read_write> quality: array<Quality>;
const MIN: f32 = 0x1p-126;
// Deliberate headroom: reject unsafe intermediates, not saturate or rescale them.
const LIMIT: f32 = 0x1p126;
fn valid(v: f32) -> bool {
    let bits = bitcast<u32>(v) & 0x7fffffffu;
    return bits == 0u || (bits >= 0x00800000u && bits < 0x7f800000u);
}
fn subtract(a: f32, b: f32) -> Checked {
    if (a > 0.0 && b < 0.0) || (a < 0.0 && b > 0.0) {
        if abs(a) > LIMIT || abs(b) > LIMIT || abs(a) > LIMIT - abs(b) {
            return Checked(0.0, false);
        }
    }
    // A potentially subnormal difference of normal inputs can only occur in this
    // small range. Scale exactly by a power of two before checking to defeat FTZ.
    if abs(a) < 0x1p-102 && abs(b) < 0x1p-102 {
        let scaled = a * 0x1p24 - b * 0x1p24;
        if scaled != 0.0 && abs(scaled) < 0x1p-102 { return Checked(0.0, false); }
    }
    let v = a - b;
    return Checked(v, valid(v) && abs(v) <= LIMIT && (v != 0.0 || a == b));
}
fn difference(e: Endpoints) -> Checked {
    let lo = subtract(e.pl, e.nl);
    let hi = subtract(e.pu, e.nu);
    if !lo.ok || !hi.ok { return Checked(0.0, false); }
    let sum = subtract(lo.value, -hi.value);
    if !sum.ok || (sum.value != 0.0 && abs(sum.value) < 2.0 * MIN) {
        return Checked(0.0, false);
    }
    return Checked(sum.value * 0.5, true);
}
fn ratio(a: f32, b: f32) -> Checked {
    if a == 0.0 { return Checked(0.0, true); }
    if b < 1.0 && abs(a) > LIMIT * b { return Checked(0.0, false); }
    if b > 1.0 && abs(a) < MIN * b { return Checked(0.0, false); }
    let v = a / b;
    return Checked(v, valid(v) && v != 0.0 && abs(v) <= LIMIT);
}
@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = id.x;
    if i >= p.n { return; }
    var q = Quality(0u, 0.0, 0u, 0u, 0u, 0u);
    let primary = difference(endpoints[i * p.n + i]);
    if primary.ok { q.separation = primary.value; q.available = 1u; }
    if counts[i].x < p.min_events || counts[i].y < p.min_events { q.status = 1u; }
    else if !primary.ok { q.status = 2u; }
    else if primary.value <= p.min_separation { q.status = 3u; }
    else {
        q.attempted = 1u;
        for (var j = 0u; j < p.n; j++) {
            let delta = difference(endpoints[i * p.n + j]);
            var coefficient = Checked(0.0, false);
            if delta.ok { coefficient = ratio(delta.value, primary.value); }
            if !coefficient.ok { q.invalid++; }
            else {
                matrix[i * p.n + j] = coefficient.value;
                if coefficient.value < 0.0 { q.negative++; }
            }
        }
        if q.invalid > 0u { q.status = 4u; }
    }
    quality[i] = q;
}
