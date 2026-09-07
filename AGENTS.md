# AGENTS.md — contract for agents working in this repo

Short, imperative, with reasons. Read `docs/HANDOFF.md` and `docs/decisions.md` before changing architecture.

## Ground rules

- **Node 24, pnpm, TypeScript strict.** `pnpm lint && pnpm typecheck && pnpm test` must pass before a commit.
- **WebGPU is the only compute path.** Do not add CPU/WASM fallbacks for kernels. Reference TS implementations
  exist *only* to test kernels.
- **Kernels live in standalone `.wgsl` files** behind a thin `GPUDevice` abstraction. They are the portable asset.
- **Chunk everything.** Buffers are bound in windows ≤128 MiB via dynamic offsets; kernels are
  "map over windows + reduce". Minimise dispatch count.
- **Event data never enters the workspace document.** The document (`workspace.flowatlas.json`) holds samples
  (by content hash), channels, transforms, compensation, gate DAG, groups, colours, annotations. Embeddings,
  labels, histograms are cache keyed by hash(inputs + params).
- **Gates are in raw channel space; transforms are display-only.**
- **Never write human provenance stamps** (`{author, modified}`) — the UI does that. Agent edits carry
  `expectedRevision` and are attributed but never human-finalised.
- **Never edit `.cache/`, `fixtures/`, or files under `FlowAtlas.jl/`** (the parity oracle stays untouched).
- **No new runtime dependencies in `fcs`, `wsp`, `transforms`, `model`** without a note in `docs/decisions.md`.
  Core packages are zero-dependency.
- **Append to `docs/decisions.md`** when a design choice is made; mark evidence measured / verified / unverified.

## Testing expectations

- Every parser gets synthetic-file tests covering the spec variants, plus oracle tests that `skipIf` the
  oracle data (`~/Documents/repos/FlowAtlas.jl/data`, env `FLOW_ATLAS_ORACLE`) is absent.
- Do not put `expect()` inside hot loops over events; aggregate and assert once.
- Kernel tests run in Node via the `webgpu` package (Dawn); in CI on llvmpipe. Perf numbers from llvmpipe
  are not meaningful.

## Data facts learned from the oracle

- 33 FCS 3.0 files, `$DATATYPE F`, big-endian, `|` delimiter, 19 params, FlowJo-exported and pre-compensated
  (`FJComp-*` names, no spill keyword). Compensated values exceed `$PnR` by up to ~5×; do not clamp.
- `workspace.wsp`: FlowJo 10.7.1, 33 samples, 1067 gates (508 polygon, 559 rectangle), 33 population names.
  Biex params are **per channel**: width ∈ {-100, -79.4, -50.1, -31.6}, pos ∈ {3.42, 3.8, 3.92, 4.42}, maxRange also varies — never
  assume one global transform. Every Population carries FlowJo's `count` (parity oracle for gating).
  27 samples have 19 parameters, 6 (donor 403C) have 18 — panels differ; channel union is required.
