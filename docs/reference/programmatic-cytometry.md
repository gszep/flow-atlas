# Programmatic cytometry references and the Rust decision

Research checked 2026-10-17. These are primary-source observations, not a claim
that every project was installed, benchmarked, or independently validated.
The agent is the primary client: interactive analysis with a human or automated
experiment iteration uses the same typed operations and artifact receipts.

## Useful independent references

| Project | Checked source | Best use | Important boundary |
|---|---|---|---|
| FlowIO, source version 1.4.0, BSD-3-Clause | `whitews/FlowIO`, `83d28a22d42235c10d17afb017250ee208afed95` | FCS metadata, offset/encoding/export interoperability | Writer emits F32; `as_array` materializes data and can preprocess acquisition values |
| FlowUtils, source version 1.2.2, BSD-3-Clause | `whitews/FlowUtils`, `b3aa2708eb25953e4e4dd9f9edcba3d503297e50` | Compensation, rectangular OLS, transforms, gating oracle | NumPy/C implementation is an external reference, not our production compute path |
| FlowKit, source version 1.3.2, BSD-3-Clause | `whitews/FlowKit`, `f2159043b6a56e527d4baacf97490caf8354618e` | Programmatic gating strategies, sample-specific context, reports, FCS/Gating-ML/WSP exports | Its “raw” data can already be preprocessed; WSP export/import has explicit unsupported branches |
| Cytoflow, GPL-2.0-or-later | `cytoflow/cytoflow`, `c31a6f5dfcecb471aad6386c97c30ac6dc39c5e8` | Operation-oriented workflows and control-based estimation | External workflow/oracle reference; no GPL implementation imported into this MIT core |
| flowCore, development source 2.25.1, Artistic-2.0 | `RGLab/flowCore`, `4935c7bf318697b3128ee50dae81018a6b246ab8` | Independent R FCS/compensation interoperability | Configure preprocessing/clipping explicitly; this development version is not a stable-release claim |
| flow-fcs, source version 0.5.2, MIT | `jrmoynihan/flow`, `35007ba7841c164cf8e4ffae220a782dcb87d7ce` | Rust mmap/lazy-column ownership and serialization patterns | Uses substantial dependencies and allocating decode paths; CPU numerical pipeline conflicts with current WebGPU-only policy |
| fcs, source version 0.1.0, MIT OR Apache-2.0 | `martindisch/fcs`, `198477cfa66a111cb78aef18ba5f1382963206af` | Small Rust parser comparison | Documented DATA support is float32 list mode, not complete integer/double coverage |
| flow-gate-core/xml, source version 0.1.0, MIT | `matteobroketa/flow-gate.rs`, `48b5b785b096be3501d0d2812922427f24e05e30` | Independent Gating-ML oracle candidate | Its compliance results are author-reported; not independently reproduced here |

The source versions above are deliberately distinguished from npm/PyPI/crates
“latest” claims. Full private research and downloaded source metadata remain in
`~/Documents/flowjo-research/ses_eba830f19ffej2PuqaC4zed9va/oss-scalability/`.

## Contracts to borrow carefully

- **Stored, acquisition-linearized, compensated, and displayed values are different
  spaces.** FlowIO preprocessing includes amplification, gain and time handling;
  FlowKit can call that result “raw.” flowCore has different default conversion
  and clipping behavior. Oracle comparisons must explicitly match spaces.
- **Conventional orientation:** FlowUtils solves `spill.T × true.T = measured.T`,
  equivalent to row-event `measured = true × spill`. Asymmetric matrices and
  reordered channel tests distinguish correct orientation from its transpose.
- **Spectral OLS is separate.** The reference uses a rectangular fluorochrome-by-
  detector matrix and least squares. Named input/output axes, rank diagnostics
  and autofluorescence components need explicit contracts; OLS is not WLS/WOLS.
- **F32 export is a conversion.** Preserve immutable originals and declare precision.
  Do not call a float64/integer-to-F32 rewrite lossless archival conversion.
- **Precompensation requires provenance.** Neither a missing spill keyword nor a
  channel prefix universally proves state. Do not automatically compensate the
  known precompensated oracle files; retain applied matrix context in receipts.
- **Gate coordinate context matters.** Gating-ML/FlowJo definitions may carry
  transform and compensation context; preserve unsupported semantics rather than
  silently evaluating a different geometry.

## Conditional Rust adoption

The user clarified: use Rust **if scalability advantages are clear**. The current
studio uses Node 24 and Dawn; the transport takes an injected `AnalysisService`,
and WGSL remains standalone. A future supervised Rust/wgpu worker can own
read/decode/upload/compute/export without changing the agent-facing protocol.
Passing every event array through Node→Rust→GPU would add an avoidable boundary;
exchange artifact identities, ranges, recipes and compact results instead.

No measured Rust advantage has been established. `rustc`/`cargo` were not on the
research session's PATH; no toolchain was installed. Identical WGSL is not made
intrinsically faster by a different host language. Rust's candidates for advantage
are ownership, bounded staging, native packaging, parsing/copy overhead and recovery.

Measure the complete path on the same hardware: 1M, 10M, then 50M × 20-channel
synthetic events, generated in chunks. The largest F32 payload is 4 GB. Record
queue/setup/decode/upload/compute/readback/write/total time, host peak RSS, live
GPU allocation, dispatch count, cancellation latency and output checksums.
Separate measurements that include driver/compiler startup from warm iterations.

Proposed adoption gates: equivalent correctness plus at least 25% lower median
end-to-end latency without a material tail regression, or 40% lower peak RSS at
equivalent throughput, or a demonstrated packaging/recovery requirement the Node
adapter cannot meet. These are project decision thresholds, not measured results
or universal performance facts. A bounded Node baseline must come first.

The existing full-sample gating path still retains O(events × gates) u32 masks.
At 10M events × 1,000 gates that is 40 GB by arithmetic, not a measured allocation.
Last-consumer reclamation and streaming gate reduction are priorities regardless
of language. Binding windows alone do not bound total live memory.

## Primary-source locations

- FlowIO: `https://github.com/whitews/FlowIO/tree/83d28a22d42235c10d17afb017250ee208afed95`
- FlowUtils: `https://github.com/whitews/FlowUtils/tree/b3aa2708eb25953e4e4dd9f9edcba3d503297e50`
- FlowKit: `https://github.com/whitews/FlowKit/tree/f2159043b6a56e527d4baacf97490caf8354618e`
- Cytoflow: `https://github.com/cytoflow/cytoflow/tree/c31a6f5dfcecb471aad6386c97c30ac6dc39c5e8`
- flowCore: `https://github.com/RGLab/flowCore/tree/4935c7bf318697b3128ee50dae81018a6b246ab8`
- Rust flow-fcs: `https://github.com/jrmoynihan/flow/tree/35007ba7841c164cf8e4ffae220a782dcb87d7ce`
- Rust fcs: `https://github.com/martindisch/fcs/tree/198477cfa66a111cb78aef18ba5f1382963206af`
- flow-gate: `https://github.com/matteobroketa/flow-gate.rs/tree/48b5b785b096be3501d0d2812922427f24e05e30`
- wgpu: `https://github.com/gfx-rs/wgpu/tree/a4b0f2257a4e1d9744dafeb1e6a0a6436f744914`
- Dawn Node: `https://github.com/dawn-gpu/node-webgpu/tree/e996e2fb74d33f9317547131160d21381dfcca6e`
- Node 24 streams/workers: `https://github.com/nodejs/node/tree/v24.18.0/doc/api`
