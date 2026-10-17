# Gated median ranks: measured streaming baseline

Measured 2026-10-18 on Node 24.18.0, Intel UHD Graphics 630 / Metal,
macOS 15.7.9 (24G830). This measures the delivered `start_population_medians`
runner; no computational runtime or API change accompanies the benchmark.
Runs were sequential on the shared GPU/disk, each in a fresh service process.
OS/driver caches and outside host load were not controlled.

## Workload and analytic oracle

Each tile contains every integer `(X,Y)` in `0..1023 × 0..1023`, in row-major
order, with `Index = 1024*Y + X` and `CenteredIndex = Index - 524288`.
All four columns are F32; one tile is 1,048,576 rows and exactly 16 MiB of DATA.
Tiles repeat the same local coordinates and index values. Generation streams
65,536-row chunks (1 MiB), not a whole-file event array.

The gated workload supplies 128 definitions: sixteen copies of the previously
documented eight-gate family. It selects the last family's triangle with vertices
`(-0.5,-0.5), (1024,-0.5), (-0.5,1024)`, parented by an all-events rectangle.
The selected dependency closure contains **two gate definitions**. Pruning is
source-reviewed and regression-tested; this benchmark does not instrument GPU
dispatch counts. Interpret the measurements for this selected workload rather
than the full-128-gate count workload.

The triangle's diagonal is `x+y=1023.5`; membership on this integer lattice is
`X+Y≤1023`. There are `1024*1025/2 = 524800` selected rows per tile. No lattice
point lies on a triangle edge. This avoids boundary ties but does not assert
that arbitrary GPU division/interpolation is exact.

For `T` identical tiles, central zero-based ranks are `262400*T-1` and
`262400*T`. The marginal prefix through X (or Y) value 299 is `262350*T`;
through 300 it is `263074*T`. Both central values are therefore 300. For Index,
the central ranks fall in Y=300, at X=49 and X=50, giving 307249 and 307250.
Subtracting 524288 gives the centered endpoints below. An independent Lunaroute
derivation confirmed these counts, multiplicities and ranks before the runs.

| Population | Target | Lower endpoint | Upper endpoint |
|---|---|---:|---:|
| Triangle | X | 300 | 300 |
| Triangle | Y | 300 | 300 |
| Triangle | Index | 307249 | 307250 |
| Triangle | CenteredIndex | -217039 | -217038 |
| Root smoke | X or Y | 511 | 512 |
| Root smoke | Index | 524287 | 524288 |
| Root smoke | CenteredIndex | -1 | 0 |

These are **independent per-column order statistics**, not the coordinates of one
median event, averaged midpoints, or confidence bounds. Repetition scales block
multiplicities and central ranks together, so endpoint values remain unchanged.
The large gated case's lower rank is 16,793,599, above 2^24; its distinct Index
endpoints exercise integer rank selection beyond consecutive F32 integer precision.
This is a targeted check, not exhaustive correctness proof for arbitrary data.

The runner checks every endpoint, selected support, rank, source-row count,
four-pass progress, numerical diagnostics, source hash, artifact hash, receipt hash
and artifact/receipt agreement. Both 16-MiB root/triangle smokes and both scale
runs passed. No failed source or numerical check was dropped.

## Measurements

Both gated runs used the same build, shader, runner, four targets and 4-MiB
decoded-chunk ceiling. Each source-window row is visited four times; the initial
full-file hash verification is additional work.

| Measurement | 64 MiB DATA | 1 GiB DATA |
|---|---:|---:|
| Source events | 4,194,304 | 67,108,864 |
| Selected population | 2,099,200 | 33,587,200 |
| Event-visits | 16,777,216 | 268,435,456 |
| Central ranks | 1,049,599 / 1,049,600 | 16,793,599 / 16,793,600 |
| OS lifetime peak process RSS | 246,710,272 B (235.281 MiB) | 408,379,392 B (389.461 MiB) |
| Watchdog-sampled process-tree peak RSS | 245,911,552 B | 407,187,456 B |
| Module setup | 0.338 s | 0.209 s |
| Synthetic generation | 0.915 s | 6.995 s |
| Service setup | 0.016 s | 0.004 s |
| Immutable import/verification | 0.640 s | 8.878 s |
| Admission call | 0.061 s | 0.067 s |
| Job queue wait, receipt | 0.027 s | 0.032 s |
| Computation before publication, receipt | 2.680 s | 30.359 s |
| Admission through terminal observation | 2.824 s | 30.581 s |
| Result verification | 0.005 s | 0.005 s |
| Cleanup | 0.015 s | 0.156 s |
| Runner total including cleanup | 4.777 s | 46.839 s |
| Independently supervised total | 5.139 s | 47.088 s |
| Unique DATA bytes / admission-through-observation | 23.761 MB/s | 35.111 MB/s |
| Four logical DATA visits / admission-through-observation | 95.045 MB/s | 140.444 MB/s |

The input increase is **16×**; observed lifetime peak RSS increased **1.655×**.
This supports the reviewed streaming implementation for these runs. It does not
prove constant memory for all workloads. RSS includes generation, module setup,
polling and native allocations in the same process. Generation alone reached about
142/205 MB in the small/large runs; GC and allocator retention affect later RSS.
The driver/GPU allocation high-water was not instrumented and may not be fully
reflected in process RSS. Sampling can miss peaks; OS high-water is listed separately.

The derived rates are logical payload/work rates, not measured storage bandwidth
or isolated GPU execution. Receipt computation includes initialization/lease,
hashing, decoding, gating, rank selection, transfers and encoding before publication.
Admission/execution can overlap and polling adds observation delay; timing rows
are not additive. Single-run throughput differences are not assigned a causal
speedup. Multi-sample batch throughput, real-panel distributions, warm-run
distributions, native FlowJo equivalence and relative Rust benefits remain unmeasured.

## Supervision and identities

An independent process-group supervisor sampled process-tree RSS every 0.5 s,
with a 2-GiB observed threshold, 900-s wall deadline, 120-s no-progress deadline,
and 600/610-s CPU soft/hard limits. Heartbeats did not count as event progress.
Node used 512-MiB old space and 16-MiB semi-spaces; the reported total heap allowance
was 560 MiB. These are observed/process limits, not a whole-system/GPU reservation.
All four runs exited 0 without watchdog termination; owned data directories were
removed after process cleanup. Large event files are not committed.

- Runtime source: merged `440fa09089167e06bab684eb0e192f2732aee54e`.
- Build fingerprint: `747de2b39ef853dea6e396b134ca8d41a970fc3c0213f454b79625dbf5579499`.
- Built host SHA-256: `abbbfcabfd7e183ebe2b650758c1fc0662d80283c02656353e17ad72fdec9c47`.
- Shader hash: `cb7cd0b0b51c6aed9d8d6025a941c330f9064e59091873e6a23261ca2b21878f`.
- Runner SHA-256: `bc10950e67f067b85adfff7f3e2cc1953299890df358e331a0028d2e852df078`.
- Supervisor SHA-256: `f74e55dd60244b2a6804c1323f5db9ae68af23292473f3247534488a736baba8`.

| Payload | Input SHA-256 | Median artifact SHA-256 |
|---|---|---|
| 64 MiB | `934b6249ce96d8c07ab4e5e4b5e371a4233aed21f0bae277f8d6fce7ee62579c` | `91a628680f6f448cd2bf5bfaddf78c404c1b5a7459c73f5f10e1fb633eaa5052` |
| 1 GiB | `b6fbf41ef4d99013ca1d03f4e85cf09ee9c73ca6569378bd5a1d00b19afaab19` | `c59e3fc86f2e4f33f7c0d78ed7a18a62fcd6b1de39188f34cbc21a08209df5d2` |

Artifact hashes identify these observed files, which contain fresh job IDs;
semantic endpoints/support are the comparison across reruns. Private full records,
runner sidecars, stdout logs and `*-supervisor.json` are retained under
`~/Documents/flowjo-research/ses_eba830f19ffej2PuqaC4zed9va/benchmarks/population-medians/`.
The principal records are `triangle-t4.json` and `triangle-t64.json`; smoke records
are `smoke-root-t1.json` and `smoke-triangle-t1.json`.

## Reproduction

Build the host, then run each case separately with fresh result paths:

```sh
pnpm typecheck
pnpm --filter @flow-atlas/host build
node --max-old-space-size=512 --max-semi-space-size=16 packages/host/bench/population-medians.mjs \
  --tiles 4 --groups 16 --population triangle --workdir /path/with/free/space --result /path/to/new-small.json
node --max-old-space-size=512 --max-semi-space-size=16 packages/host/bench/population-medians.mjs \
  --tiles 64 --groups 16 --population triangle --workdir /path/with/free/space --result /path/to/new-large.json
```

Use `--tiles 1 --population root` or `triangle` for functional smoke runs. The
large case needs roughly two DATA payloads of free disk for source and snapshot.
The runner refuses existing result/sidecar paths and software performance labels,
supports cancellation, and removes its owned directory unless `--keep` is used.
The commands alone do not install the independent watchdog used for this report.
