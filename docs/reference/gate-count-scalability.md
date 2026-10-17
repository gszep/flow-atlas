# Streamed gate counts: bounded scalability measurement

Measured 2026-10-17 on Node 24.18.0, Intel UHD Graphics 630 / Metal,
macOS 15.7.9 (24G830). This checks the delivered count job, without changing its
runtime or API. Runs were sequential because they share the GPU and disk.
Each used a fresh service process; OS/driver caches were not cleared.

## Workload and independent expectation

Each tile contains every integer pair `(X,Y)` in `0..1023 × 0..1023`, plus two
unused F32 columns: 1,048,576 events and exactly 16 MiB of DATA. Tiles repeat the
same local coordinates. Generation streams 65,536-event chunks; it does not build
a complete file array. The two measured files contain four and 64 tiles.

Sixteen copies of the following eight-gate family exercise the host's **128-gate
limit**. Gate IDs are distinct; this intentionally stresses retained masks and
repeated dispatch/readback, not the diversity of a typical experimental panel.

| Population | Definition | Count per tile | Parent denominator per tile |
|---|---|---:|---:|
| All | Null-bounded X rectangle | 1,048,576 | 1,048,576 |
| Left | X in [0,511], within All | 524,288 | 1,048,576 |
| Bottom | Y in [0,511], within All | 524,288 | 1,048,576 |
| Quarter | Y in [0,511], within Left | 262,144 | 524,288 |
| Triangle | Vertices (-0.5,-0.5), (1024,-0.5), (-0.5,1024), within All | 524,800 | 1,048,576 |
| Union | Left OR Bottom, within All | 786,432 | 1,048,576 |
| Not Left | NOT Left, within All | 524,288 | 1,048,576 |
| Union minus Quarter | NOT Quarter, within Union | 524,288 | 786,432 |

The triangle hypotenuse is `x+y=1023.5`; on the integer lattice membership is
`X+Y≤1023`, giving `1024×1025/2 = 524800`. No lattice point lies on a triangle
edge. Rectangle boundaries deliberately include integer ties. Boolean counts
follow inclusion–exclusion and parent-restricted complement. An independent
Lunaroute mathematical check confirmed these counts and denominators. This does
not assert that arbitrary polygon calculations are exact in F32.

The runner checks **every output row, integer count, denominator and frequency**
against these analytic expectations, and verifies source/output hashes and the
receipt/artifact agreement. Frequencies use the host's scalar JS-number division;
2/3 is not a binary-exact real number. All 128 rows passed in both measured runs.

## Measurements

Both runs used the same build, shader, runner, 4-MiB decoded-chunk ceiling and
128-gate recipe shape. The runtime additionally reduces chunk rows to fit its
aggregate column/mask allocation budget; 4 MiB is a ceiling, not a claim that
every emitted chunk occupies exactly that size.

| Measurement | 64 MiB DATA | 1 GiB DATA |
|---|---:|---:|
| Events | 4,194,304 | 67,108,864 |
| Gate rows verified | 128 | 128 |
| OS lifetime peak process RSS | 203,640,832 B (194.207 MiB) | 263,962,624 B (251.734 MiB) |
| Independent watchdog-sampled process-tree peak RSS | 197,836,800 B | 262,504,448 B |
| Module setup | 0.259 s | 0.293 s |
| Synthetic generation | 0.588 s | 6.066 s |
| Service setup | 0.005 s | 0.003 s |
| Immutable import/verification | 0.547 s | 7.867 s |
| Admission call | 0.064 s | 0.043 s |
| Job queue wait, receipt | 0.035 s | 0.027 s |
| Computation before publication, receipt | 16.477 s | 136.216 s |
| Admission through terminal observation | 16.637 s | 136.425 s |
| Result verification | 0.004 s | 0.003 s |
| Cleanup | 0.023 s | 0.223 s |
| Runner total including cleanup | 18.074 s | 150.886 s |
| Independently supervised total | 18.308 s | 151.155 s |
| DATA bytes / admission-through-observation | 4.034 MB/s | 7.871 MB/s |

Input size increased **16×**, while observed lifetime peak RSS increased **1.296×**.
This is consistent with the reviewed bounded streaming implementation. It is not
an asymptotic proof of constant memory, a GPU-memory high-water measurement or a
promise about all input panels and gate recipes.

RSS includes generation, module setup, native runtime and service work. Generation
alone reached approximately 137/215 MB in the small/large runs; GC and allocator
retention affect later absolute RSS. GPU allocations are not independently
instrumented and may not be fully reflected in RSS. The 100-ms in-process and
500-ms watchdog sampling can miss peaks; the OS lifetime high-water is reported
separately. No runtime kernel/upload/readback timing breakdown is available.

Receipt computation includes GPU setup/lease, source hash verification, decoding,
gate dispatch/readback and artifact encoding. Admission and execution may overlap;
polling adds observation delay, so the timing rows are not additive. The throughput
difference between these single runs is not attributed to an optimization,
language choice or cache effect. There is no warm-run distribution, real-panel
representativeness, vendor parity or relative Rust-benefit claim.

## Supervision and retained evidence

The independent supervisor sampled the process tree every 0.5 s, enforcing an
observed 2-GiB RSS threshold, 900-s wall deadline, 120-s no-progress deadline and
600/610-s soft/hard CPU limits. Heartbeats did not reset the progress deadline:
only phase/event progress did. Node used 512-MiB old space and 16-MiB semi-spaces;
the reported total V8 heap allowance was 560 MiB. These are observed/process
limits, not a kernel-enforced whole-system/GPU memory reservation.

Both runs exited successfully without watchdog termination. All invocation-owned
source/snapshot/output directories were removed after the processes drained.
Private evidence is under
`~/Documents/flowjo-research/ses_eba830f19ffej2PuqaC4zed9va/benchmarks/gate-counts/`:
`t4-g16.json`, `t64-g16.json`, their `.json.log` runner sidecars, stdout `.log`
files, `*-supervisor.json`, and `supervise.py`. Large event files are not committed.

A preliminary 16-MiB/eight-gate smoke passed. The earlier failed launch is retained
as `smoke-t1-g1.log`: a benchmark-only guard incorrectly equated V8 total heap
allowance with the old-space limit. The guard was corrected before either measured
run; no count/runtime implementation changed or failed.

### Identities

- Runtime source: merged `5f66295b77c702e9413de30cfa9d44df0472901c`.
- Build fingerprint: `307372435e43ae12dc92a26acc0eab498f30f3a026f140a842e0fd7e28ef9186`.
- Built host SHA-256: `f0d7b239d7a561b9d5ace1ce4164f8c8a53c416f5a124fb794b303829ab50303`.
- Shader hash: `773303e43404bfce8301442eb23b91605aa42a7b12a434babc40044e1bacf22d`.
- Runner SHA-256: `4baf9062edce016178a5330c25130533d78b2f9d54f469948134ad4ae016f642`.
- Supervisor SHA-256: `7d566d15e39b93a682f6657979da9dedc8f9d5cb4fd274339cae433c83757dbd`.

| Payload | Input SHA-256 | Count artifact SHA-256 |
|---|---|---|
| 64 MiB | `a62ddd4c22c981e0d0898168323dc8c4677328bf724cd2080716c39201b61ef2` | `b6df94a783ca1bb185c20de405e2741a99b412a97f3c19d0e763c154b61160bb` |
| 1 GiB | `23c30c3cbf78e7de68554e8505afff1d2ca0f519d95f388a30625da454c9f901` | `fc66909c4bb04a7d68eb1c0ac419ec24b030670971c7952bb2b11d5b3ad0ea8d` |

Artifact hashes identify the observed files, which include fresh job IDs; they are
not expected to be identical on another run. Semantic counts are the comparison.

## Reproduction

After building the host, run each case separately with a new result path:

```sh
pnpm typecheck
pnpm --filter @flow-atlas/host build
node --max-old-space-size=512 --max-semi-space-size=16 packages/host/bench/gate-counts.mjs \
  --tiles 4 --groups 16 --workdir /path/with/free/space --result /path/to/new-small.json
node --max-old-space-size=512 --max-semi-space-size=16 packages/host/bench/gate-counts.mjs \
  --tiles 64 --groups 16 --workdir /path/with/free/space --result /path/to/new-large.json
```

The large case requires approximately two payloads of free disk space for source
and snapshot. The runner refuses existing result/sidecar paths and software-adapter
performance labels. It handles cancellation and cleans its owned directory unless
`--keep` is supplied. The standalone commands do not themselves install the
independent watchdog limits used for these measurements.
