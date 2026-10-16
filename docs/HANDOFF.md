# Handoff

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
