# Handoff

## Batch median-rank tables (2026-10-18)

`start_batch_population_medians` applies one stored-F32 population/channel recipe
to 1–32 distinct immutable samples, returning at most 512 indexed sample/channel
endpoint rows. Support, central ranks and diagnostics remain per sample. Existing
empty/nonfinite rejection and atomic publication policies are retained; no pooling
or midpoint calculation is introduced. Source review and all 432 local tests passed,
including 15 new cases covering both 16×32 and 32×16 boundaries, source failures,
cancellation and restart. Lint/typecheck, host build and compiled RPC smoke pass.
Final-head Linux CI is required before merge.

## Gated median-rank summaries (2026-10-18)

`start_population_medians` selects one stored-F32 gate population (or explicit
root/null selection) and reports central rank endpoints for up to 32 channels.
It replays one pinned source four times, obtains membership from the existing GPU
gate engine and checks gate support against the GPU median result on every pass.
Endpoints are not averaged and are not confidence bounds or vendor parity claims.

Independent compute, host and dependency-pruning reviews passed. Final local checks
passed 417 tests in 34 files, lint/typecheck, host/UI builds and compiled gated-median
RPC smoke. All eleven new E2E cases remain, plus eight host invariants and 22 masked
primitive cases. Final-head Linux CI `39046514475` passed 374 tests with ten
private-oracle skips; PR #8 merged at `af0ef28`.

## Batch population counts (2026-10-17)

`start_batch_gate_counts` applies one explicit stored-F32 recipe to 1–32 distinct
immutable samples, with per-sample windows and an indexed result table capped at
512 sample/gate rows. Parent/root counts and frequencies remain sample-local;
there is no pooled statistical inference or implicit processing. The operation
shares the single-count executor's cancellation and atomic publication path.

Source review passed after preserving admission cancellation, filesystem error
causes and nested device-loss diagnostics. Maximum-row MCP and later-source failure
regressions pass. A Buffer-backed FCS header-offset bug exposed by the fixtures was
fixed and independently reviewed. All 376 local tests pass, including all eight
protocol/E2E cases, plus lint/typecheck, host/UI builds and compiled RPC smoke.
Final-head Linux CI run `39036776005` passed 333 tests with ten private-oracle
skips; PR #7 merged at `01caadc`. See `packages/host/README.md` for the contract.

## Streamed population counts (2026-10-17)

`start_gate_counts` adds explicit stored-F32 rectangle/polygon/Boolean recipes,
streamed through existing GPU membership kernels. Results include counts and both
parent/selected-root frequencies; empty denominators are null. Counts and receipts
publish atomically through the existing job lifecycle. This does not edit workspace
gates or silently apply acquisition, compensation or display transforms.

The runner bounds event/column/mask allocation by chunk sizing, pins source identity,
and records the exact recipe and named numerical policy. See
`packages/host/README.md` for geometry limits and nonfinite/Boolean semantics.
Independent source review passed. Local validation passed 360 tests in 28 files,
lint/typecheck, host/UI builds and compiled RPC smoke. Nineteen new tests cover
multi-chunk geometric/Boolean counts, numerical extremes, parent/root denominators,
admission, cancellation, MCP, restart and terminal-record failure after publication.
Final-head Linux/llvmpipe run `39025192541` passed 317 tests with ten private-oracle
skips. PR #5 merged at `5f66295b`.

A follow-up measured 128-gate synthetic counting at 64 MiB and 1 GiB: all count/
denominator rows matched analytic expectations. The larger run took 136.425 s
from admission to terminal observation at 251.734 MiB process lifetime peak RSS.
Scope, supervision, hashes and reproduction: `docs/reference/gate-count-scalability.md`.

## Explicit control-derived compensation (2026-10-17)

`start_control_estimation` composes bounded four-pass GPU median rank selection,
primary-normalized median differences and matrix conditioning into an agent job.
Positive/negative populations bind independent immutable files, event windows,
inclusive selections and explicit acquisition contexts. Successful jobs publish
matrix JSON and replayable receipts atomically and return a compensation ID usable
by preview/export. See `packages/host/README.md` for the contract and limits.

Primitive and composed-host reviews are complete. Local validation passed 341
tests, lint/typecheck, host/UI builds and the compiled RPC workflow. Final-head
Linux CI run `39004912413` passed 298 tests with ten private-oracle skips; PR #4
merged at `f83fd159`. Native static coverage now includes 71 unique entrypoints; the evidence
boundary is in `docs/reference/control-compensation-research.md`. This does not
establish FlowJo parity, automated gating, AutoSpill or biological QC.

## Explicit acquisition and spectral OLS (2026-10-17)

The agent API now exposes `register_unmixing` and explicit stored/linearized input
spaces. GPU acquisition conversion and pivoted-QR spectral OLS compose with preview,
selection, FCS export and receipts. Matrices bind their preprocessing context;
exports record original/derived roles and normalize Time/gain metadata correctly.
Stored-space defaults remain unchanged. See `packages/host/README.md`.

Independent NumPy/FlowIO records and a portable optional checker are committed in
`packages/compute/test/data`. Separate kernel and composed-host reviews passed.
Local checks passed 293 tests; Linux CI passed 250 with ten private-oracle skips.
The combined 4 GB → 4.6 GB workload used about 436 MB host RSS. Numerical/performance
scope and source identities: `docs/reference/spectral-acquisition-validation.md`.

Weighted WLS/WOLS, SpectralFX, control-derived spectral reference estimation,
population statistics beyond counts and GPU-resident stage fusion remain follow-ups.

## Native FCS and agent studio (2026-10-17)

The agent-first FCS workflow now lives in `packages/host`: MCP and JSON-RPC share
one backend for immutable import, bounded inspection, explicit GPU compensation,
streamed FCS export, cancellation and receipts. See its README for launch and
tool contracts. It is a FCS-focused studio, not yet a full collaborative gate editor.

`packages/fcs` has bounded random-access read and streaming FCS3.1 F32 write APIs;
`packages/compute` has conventional GPU compensation with exact channel mapping
and explicit numerical diagnostics. Unsupported acquisition scaling and spectral
algorithms remain explicit. Original bytes are retained; exported F64/I64 values
are not claimed lossless.

The corrected build processed a 4 GB synthetic payload at about 354 MB peak host
RSS. Details: `docs/reference/native-fcs-benchmark.md`. Rust remains a measured
alternative, not an assumed speedup; references are in
`docs/reference/programmatic-cytometry.md`. Native FlowJo coverage reached 54
unique decompiled entrypoints; see `docs/reference/compensation-research.md`.

## FlowJo 11 investigation (2026-10-17)

See `docs/reference/flowjo-11-rea.md` for the initial REA analysis of installed FlowJo
11.2.0: artifact fingerprints, native request schemas, renderer GraphQL operations,
native symbol targets, repository parity gaps, and unresolved questions. Numerical
algorithms and runtime compatibility are not yet verified. The note records local
evidence locations and the native-decompiler setup blocker.

Follow-up: Artemis's existing Ghidra installation produced 20 focused function
decompilations after two REA whole-program startup timeouts. The investigation
records this distinction, transfer hashes, cleanup, and remaining numerical gaps.

See `docs/agent-first-roadmap.md` for the 2026-10-17 product direction: transfer
scientific/workflow capabilities into efficient agent operations rather than
reproduce FlowJo's UI. It tracks the first delegated implementation slices and
distinguishes planned capabilities from delivered behavior.

The first implementation wave adds `@flow-atlas/model` (revisioned metadata-only
workspace definitions and gate transactions), windowed GPU Boolean populations,
and explicit unsupported-transform preservation/refusal. Combined local checks:
131 tests, lint, typecheck and UI production build passed. The studio/MCP adapter,
durable journal/collaboration, and production WSP-to-model import remain follow-ups.

Written at the end of the bootstrap session in `FlowAtlas.jl` (Sep 2026). The next agent works in this repo.

## Decisions already made (do not re-litigate)

| Topic | Decision |
|---|---|
| Language / runtime | TypeScript. **Node 24** for anything that runs outside the browser (MCP server, tests). |
| Compute | **WebGPU is the single acceptable path.** No CPU/WASM fallback for SOM, EmbedSOM, transforms, gating, histograms. If the browser lacks WebGPU, show an error page. For Node-side tests use a WebGPU implementation for Node (e.g. `webgpu` / Dawn bindings) — evaluate options early. |
| Install model | Zero-install static web app; all data stays client-side (files never uploaded). |
| CLI | **No general CLI.** The only non-browser entry point is the **studio host** (`npx flow-atlas`): one Node 24 process = static app + Yjs/Hocuspocus room + journal + MCP endpoint. See `lessons-from-decks.md`. |
| State model | One **workspace document** (`workspace.flowatlas.json`, git-diffable ground truth) mirrored in a Yjs doc while a host runs; UI and agents mutate it through the same typed operations with `expectedRevision` checks; human-finalised items carry `{author, modified}` stamps written only by the UI. Event data / embeddings are cache, never in the document. Pattern lifted from `~/Documents/repos/decks`. |
| Agent interface | MCP server exposing the document + compute as tools. Also plain JSON-RPC over HTTP for non-MCP clients. |
| Reference oracle | `FlowAtlas.jl` stays untouched as the parity oracle; its `data/` (5 donors × up to 8 tissues, 3 panels, `workspace.wsp`) is the test dataset. Path on this machine: `~/Documents/repos/FlowAtlas.jl/data`. |
| Phases | Phase 1 = parity with FlowAtlas.jl (FlowJo still authors gates). Phase 2 = drop FlowJo (full Gating-ML, `.wsp` write, native gating). |
| License | MIT. |

Read `docs/lessons-from-decks.md` before designing `model`/`host` — it lists the collaboration, provenance, journal, hot-reloadable-tool and MCP patterns to reuse and the proven dependency set (yjs, hocuspocus, @modelcontextprotocol/server 2, zod 4).

## Resolved 2026-09-07 (see `decisions.md`)

Renderer = hand-rolled WebGPU; layout = pnpm workspace; kernel tests + headless host compute = Dawn Node
bindings (`webgpu` npm) with llvmpipe in CI (measured, works). The three questions below are kept for context.

## Open (historical) — resolved above

1. **Rendering layer.** Options: (a) `regl-scatterplot` (WebGL2, mature, 10M+ points, lasso, spatial index); (b) deck.gl WebGPU backend (experimental); (c) hand-rolled WebGPU point renderer sharing buffers with the compute kernels (zero-copy, most control, most work). Given "WebGPU is the single path", (c) or (b) is more coherent than (a); (a) would mean a WebGL2 dependency alongside WebGPU. Present trade-offs and let the user choose.
2. **Repo layout**: single Vite app vs pnpm workspace with packages (`fcs`, `wsp`, `transforms`, `compute`, `model`, `ui`, `mcp`). Recommendation in `architecture.md` is workspace; confirm.
3. Node-side WebGPU (Dawn bindings) in the host so agents can compute headless, vs forwarding compute to a connected browser tab (default for Phase 1). Also decides how numeric tests run in CI.

## First tasks (Phase 0)

1. Scaffold: pnpm workspace, TypeScript strict, Vite, Vitest, Biome/ESLint, GitHub Actions on Node 24.
2. `@flow-atlas/fcs`: FCS 2.0/3.0/3.1 reader → `{ keywords, channels: {$PnN,$PnS,$PnR,$PnE,$PnG}, data: Float32Array (row-major), spill? }`. Test on all 32 FCS files in the oracle `data/`.
3. `@flow-atlas/wsp`: port of FlowWorkspace.jl (see `reference/flowatlas-jl-internals.md` §2) → channel map, transforms (linear/log/biex), gate DAG (polygon/rectangle), groups. Test on oracle `data/workspace.wsp`.
4. Parity fixtures: run FlowAtlas.jl once on the oracle data and dump `labels` (bool matrix), `groups`, transformed `data`, `embedding` (N×2), and the `.som` to a `fixtures/` dir (Arrow or raw binary). Julia script lives in FlowAtlas.jl; fixtures are committed here (or LFS if >50MB).
5. `@flow-atlas/compute`: WGSL kernels — compensation (matrix mult), transforms (biex LUT / closed form), point-in-polygon gating, 2-D histogram, SOM train (batch), map-to-SOM, EmbedSOM. Validate against fixtures (embedding won't be bit-identical — compare cluster assignment agreement and k-NN preservation).
6. MCP server v0 with `open_workspace`, `list_samples`, `list_channels`, `describe_gate_tree`, `count`.

## Things the previous session learned the hard way

- The web-search tool in that session was rate-limited; GitHub search via `gh search repos` (authenticated) and Europe PMC REST both work from bash.
- FlowAtlas.jl has no CI-runnable tests beyond launching the server; parity fixtures must be generated manually with Julia (installed on this machine; env in `FlowAtlas.jl/Manifest.toml`).
- FlowWorkspace.jl requires unique FCS basenames per workspace and only supports polygon/rectangle gates, ≤2 dims, one parent. Do not inherit these limits — design the gate model for the full Gating-ML 2.0 set from the start even if Phase 1 only implements two.
