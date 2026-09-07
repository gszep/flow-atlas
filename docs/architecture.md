# Architecture

## Principles

1. **Browser is the compute platform.** WebGPU compute shaders do every numeric step: compensation, transforms, gating, histograms, SOM training, EmbedSOM. Data never leaves the machine. No CPU fallback.
2. **One document, two clients.** A JSON workspace document (samples, channels, transforms, gate DAG, groups, embeddings, selections, colours) is the single source of truth. The UI and the MCP server apply the same typed operations to it and receive the same change events. Revision IDs make agent edits safe against concurrent human edits.
3. **Agents get summaries, not blobs.** Tools return compact statistics/tables by default; large arrays only on explicit request and with size caps.
4. **FlowJo parity is a test, not a feature.** Phase 1 reads `.wsp`; Phase 2 writes it. Parity harness compares per-gate counts against FlowJo/FlowAtlas.jl exports within tolerance.

## Package layout (pnpm workspace, proposed)

```
flow-atlas/
├─ packages/
│  ├─ fcs/          FCS 2.0/3.0/3.1 binary reader (TEXT/DATA/ANALYSIS segments, $DATATYPE F/I/D,
│  │                $BYTEORD, $PnB/$PnR/$PnE/$PnG, $SPILL/$SPILLOVER). Streams to Float32Array.
│  ├─ wsp/          FlowJo .wsp XML → document model. Gating-ML 2.0 gate types, transforms, groups,
│  │                per-sample keywords, compensation matrices (<Matrices>), sample→group refs.
│  ├─ transforms/   linear, log, biex (FlowJo), logicle, hyperlog, arcsinh. TS reference impls +
│  │                WGSL twins. Biex uses the FlowKit-derived 4097-point table (see internals doc).
│  ├─ compute/      WebGPU device management, buffer layout (column-major channel buffers),
│  │                kernels: compensate, transform, gate (polygon/rect/ellipse), hist1d/hist2d,
│  │                som_train, som_map, embedsom, quantile (for colour LUTs), reduce/count.
│  ├─ model/        Workspace document types, operations (JSON patch-like), revisioning, validation
│  │                (zod), serialisation (.flowatlas.json + OPFS cache for embeddings/SOM).
│  ├─ ui/           Vite PWA: map view (hand-rolled WebGPU point renderer), sidebar tabs (annotations / expression /
│  │                frequency / settings), violins, boxplots, legend (sortable groups), colourbar.
│  └─ host/         Studio host (`npx flow-atlas`): static app + Hocuspocus room + journal + MCP.
│                   Compute headless via Dawn Node bindings (`webgpu`, optional dep) or forwarded to a tab.
├─ fixtures/        Parity fixtures exported from FlowAtlas.jl (see HANDOFF §First tasks)
└─ docs/
```

## Data layout in GPU memory

See `decisions.md` (2026-09-07) for the evidence behind these rules.

- Events stored **column-major**: one `GPUBuffer` per channel across all samples, plus a `sampleId: Uint16Array` column. Missing channels (panel merge) get a NaN column + a per-sample presence bitmask.
- Buffers are bound through **dynamic bind-group offsets in fixed windows ≤128 MiB** (the spec default and llvmpipe's `maxStorageBufferBindingSize`). Every kernel is "map over windows + reduce".
- **Minimise dispatches**: dispatch overhead dominates in browsers. One SOM epoch is O(1) dispatches over all windows; fuse compensate→transform→gate where possible.
- Atomics are integer-only in WGSL; histograms and SOM accumulation use `u32` atomics or workgroup reductions. `shader-f16` is optional and not assumed.
- `device.lost` → recreate device, reload from OPFS cache. No CPU fallback.
- Labels/groups as bitmasks: `u32` per event per 32 populations (FlowAtlas.jl encoded selections as a single Int bitmask; keep the idea, widen it).
- Embedding: `vec2<f32>` per event; kept on GPU for rendering; read back once for OPFS cache.

## Embedding (Phase 1 parity)

FlowAtlas.jl: `initGigaSOM(imputed, 20, 20)` → `trainGigaSOM` (default GigaSOM.jl params: 10 epochs, radius linear decay from `√(xdim²+ydim²)/2` to 0.1-ish, batch SOM with Euclidean distance) → `mapToGigaSOM` (nearest code) → `embedGigaSOM` (EmbedSOM: k=10 nearest codes, adjust=1, smooth=0; see Kratochvíl 2019/2020). Imputation before SOM via `Impute.srs` (simple random sampling from observed values per column).

Port plan: batch-SOM in WGSL (one workgroup per code, reduce over events), EmbedSOM per event (k nearest codes + local projection). Determinism: seed the imputation and initial codebook so parity fixtures are reproducible; the Julia oracle used unseeded RNG, so compare by cluster agreement / neighbourhood preservation rather than coordinates.

## Agent tool surface (MCP v0 → v1)

| Tool | Returns |
|---|---|
| `open_workspace({wsp, fcsDir})` | document summary, revision |
| `list_samples()` / `list_channels()` / `list_groups()` | tables |
| `describe_gate_tree({sample?})` | nested gates with counts and % of parent |
| `stats({population, channels, groupBy, statistic})` | median/MFI/quantiles table |
| `count({selection})` | counts per (population × condition × batch) |
| `draw_gate({dims, geometry, parent, name})` | new gate id, counts |
| `update_gate` / `delete_gate` | revision |
| `embed({channels, xdim, ydim, epochs, seed})` | job id → embedding summary |
| `region_stats({polygonInEmbedding, channels})` | per-channel histograms (violins) |
| `set_selection` / `set_color` | revision |
| `snapshot({view, width, height})` | PNG (base64) of current map for the agent to look at |
| `export_wsp()` (Phase 2) | file |

## Phases

- **Phase 0** scaffold, parsers, fixtures.
- **Phase 1** parity with FlowAtlas.jl + MCP v0. Deliverable: open oracle `workspace.wsp`, get an embedding and the same populations/violins/boxplots as the Julia app, and an agent can drive it.
- **Phase 2** FlowJo-free: native gating on raw channels (2-D plots with biex axes, polygon/rect/ellipse/quadrant/boolean), full Gating-ML read/write, `.wsp` export, compensation editing, layout/report export, parity harness vs FlowJo counts.
