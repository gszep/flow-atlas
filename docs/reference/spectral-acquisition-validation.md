# Spectral OLS and acquisition-space evidence

Checked 2026-10-17. This wave implements explicit scientific contracts through the
agent API; it does not reproduce FlowJo's UI or claim native vendor equivalence.

## Implemented contracts

- **Acquisition:** opt-in stored → linearized F32 processing. Ordinary linear
  channels divide by gain; logarithmic channels apply anti-log using PnE/PnR,
  then gain division. Zero log-offset with positive decades normalizes to one.
  Selected linear Time multiplies by the effective timestep and ignores gain.
  Nonlinear Time and invalid/unsafe metadata reject. Identity channels preserve bits.
- **Spectral OLS:** explicit reference with fluorochrome rows and named detector
  columns, `measured = abundances × reference`. GPU column-pivoted Householder QR
  and triangular solves compute a full-rank least-squares operator. Original input
  columns remain in the selected input space; named fluorochromes and optional
  Euclidean L2 residual append. Negative values are retained.
- **Context:** registered matrix IDs bind the sample, input space and effective
  acquisition settings. Contradictory preview/export settings reject. Stored values
  mean current file values, not necessarily unprocessed instrument measurements.
- **Export:** expanded input/output row strides are bounded. Metadata follows the
  selected values: gains/amplification reset after linearization, time aliases are
  reconciled and normalized, active spillover is removed after matrix application,
  and selected/renamed column roles are recorded. Derived channels cannot impersonate
  Time. Partial output is withheld on cancellation/numerical failure.

The implementation is not weighted WLS/WOLS, SpectralFX, nonnegative least squares,
or full FlowJo parity. Its f32 rejection thresholds are explicit product policies,
not biological suitability guarantees. QR accepted-pivot count is not an SVD rank
estimate; the reported infinity-norm conditioning is not a 2-norm condition number.

## Independent reference data

An isolated Python 3.12.13 environment ran NumPy 2.5.4, FlowIO 1.4.0 and
FlowUtils 1.2.2 with single-thread numerical settings. Official distribution metadata
was checked before installation. Installed FlowIO/FlowUtils source files were
byte-identical to the pinned upstream commits used in the earlier reference review.

Eleven spectral cases include asymmetric rectangular references, negative abundance,
exact mixtures, orthogonal detector-space noise, independent detector/fluor permutations,
rank deficiency and near-dependence. Coefficients/events are quantized to F32 before
promotion to float64 NumPy `lstsq(S.T, Y.T, rcond=-1)`. This separates input
quantization from GPU solver error. FlowUtils calls the same NumPy solver; agreement
checks its wrapper behavior, not a second independent algorithm.

Seven acquisition records were read by actual FlowIO from generated integer FCS.
They cover gain, log, zero-offset normalization, timestep, ignored Time gain and
explicitly classified compatibility cases. The selected nonlinear-Time case records
FlowIO's result but remains a rejection case for our profile.

Portable records, source pins, versions and an optional rechecker are in
`packages/compute/test/data`. Normal tests require no Python. The optional checker
reproduced all reference results and the exact original synthetic FCS hashes.
No real donor events or proprietary implementation bodies are present.

## Independent reviews

- **Spectral kernels:** 13 committed tests plus 11 independent oracle cases passed
  on Dawn/Metal. Accepted cases used `|error| <= 1e-5 + 1e-5*|expected|`; maximum
  observed abundance/L2 residual errors were 1.39317e-6 and 1.06624e-6. Three
  diagnostic references rejected; their minimum-norm answers were not acceptance
  requirements. Input/output identity/order, bounds and lifecycle were checked.
- **Acquisition kernels:** six accepted FlowIO cases passed, with maximum normalized
  error 1.23e-7; selected nonlinear Time rejected. Independent boundary probes
  rejected 119 unsafe combinations without observed silent zero/saturation. This
  is fixture-specific evidence, not a universal f32 error bound.
- **Host integration:** independent review approved the context/metadata integration.
  Focused tests and an extra 257-event / 1 KiB-window case checked detector reorder,
  no-residual/full/derived-only/original-only/mixed output, receipts, defensive
  ownership and cancellation. No demonstrated integration finding remained.

At source head `acd740012d40f4c88d8fc47c8be12a59679fff43`, local checks passed
293 tests, lint/typecheck, host and UI builds, and the compiled Node workflow.
Linux/llvmpipe CI run `38996665556` passed 250 tests with ten private-oracle tests
skipped, plus the compiled conventional/acquisition/spectral HTTP workflow.

## Performance scope

`packages/host/bench/streaming.mjs --mode linearized-ols` generates a streamed
20-channel fixture with known gains and Time scaling, then performs acquisition
conversion and a 3-detector/2-fluor OLS fit with residual. The result has 23 columns.
It verifies metadata and sampled original/derived values, including chunk boundaries.
The default compensation benchmark remains separately selectable.

The host currently exchanges bounded arrays between stages, including intermediate
readback/upload. GPU-resident fusion remains a performance opportunity independent
of host language. Memory and timing results must identify mode, source/build,
hardware, input/output sizes and cache state; neither this implementation nor its
unit tests establishes a Rust scalability advantage.

### Measured 4 GB combined-path run

On source `acd740012d40f4c88d8fc47c8be12a59679fff43`, bundled fingerprint
`54ce3831348174997d7b2ffe81d54409bfe73888c82123c8f24d944e49085555`, the benchmark
completed 50 million events × 20 input columns. Gain/time scaling preceded a
3-detector/2-fluor fit; retaining originals plus two fluorochromes and a residual
produced 23 output columns. This was Node 24.18.0, Intel UHD 630 / Metal, macOS
15.7.9 (24G830), with OS/driver caches not cleared.

| Measurement | Result |
|---|---:|
| Input DATA payload | 4,000,000,000 bytes |
| Output DATA payload | 4,600,000,000 bytes |
| Event chunk budget | 4 MiB |
| OS-reported peak host-process RSS | 436,346,880 bytes (416.1 MiB) |
| Watchdog-sampled peak RSS | 436,473,856 bytes |
| Synthetic input generation | 13.111 s |
| Snapshot/import and verification | 30.862 s |
| GPU initialization/reference validation | 0.111 s |
| Export-job wall time | 83.443 s |
| Job queue / setup / processing | 0.027 / 14.080 / 69.238 s |
| Supervised total, including cleanup | 128.367 s |
| Input-equivalent throughput over export-job wall time | 47.94 MB/s |
| Maximum sampled absolute error | 0.00002288818359375 |

The 2 GiB RSS watchdog (0.5-second samples), 512 MiB Node heap limit, 900-second
wall deadline and 120-second progress deadline all passed without termination.
Owned synthetic input/cache/output directories were removed. The benchmark also
checked the OS process high-water RSS and sampled original/derived/time/residual
values at chunk boundaries, midpoint and the final event. This is not an exhaustive
independent numerical check of every value. GPU allocation high-water and separate
upload/kernel/readback timings were not instrumented.

Input hash: `8b5d79422f6f2defaa62114fe837913909f87bab57f2b4eb8efcc3144c5707f3`.
Output hash: `d2a233ea6505ab537b5255d45cfab4cc4ebbbfe379d0ba8d28bb6aad699b1e93`.
Original result/supervisor JSON and logs are retained under the private research
directory `spectral-wave3`. This is a single workload/device baseline, not a warm-run
distribution, a fully populated 128-axis throughput result, or a Rust comparison.
