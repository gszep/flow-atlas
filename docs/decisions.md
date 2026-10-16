# Decisions log

Append-only. Each entry: what was decided, why, and what evidence it rests on. Mark evidence as
**measured** (we ran it), **verified** (primary source read), or **unverified** (secondary source only).
Earlier decisions in `HANDOFF.md` remain in force unless superseded here.

## 2026-09-07 — Rendering: hand-rolled WebGPU point renderer

Chosen over regl-scatterplot (WebGL2) and deck.gl WebGPU (experimental). Embedding, colour and
visibility buffers already live on the GPU for compute; one render pipeline over the same buffers is
zero-copy and avoids a second GPU API. Closest open precedent to study first: `apple/embedding-atlas`
(WebGPU point rendering of millions of points; verified on GitHub, ★4.9k).

## 2026-09-07 — Repo layout: pnpm workspace

`packages/{fcs,wsp,transforms,compute,model,ui,host}` as in `architecture.md`. Parsers, transforms and
model are pure TS with no browser dependency and run in Node tests.

## 2026-09-07 — Kernel tests and headless compute: Dawn Node bindings (`webgpu` npm)

**Measured** on this machine, Node 24.18, `webgpu@0.6.0` (published 2026-08-28, repo
`dawn-gpu/node-webgpu`, maintained by the Dawn team):

- Prebuilt binaries in the tarball for linux-x64/arm64, darwin-universal, win32-x64/arm64 (95 MB unpacked).
  No toolchain needed. `npm i` → compute shader ran in ~2 s wall time.
- NVIDIA RTX 5000 Ada (Vulkan): 1M-element dispatch + readback 1.9 ms. Limits: `maxStorageBufferBindingSize`
  2 GiB, `maxBufferSize` 1 TiB. Features **did not** include `shader-f16`.
- **Software Vulkan (Mesa llvmpipe, `mesa-vulkan-drivers` apt package)**: same test 7 ms warm / 103 ms cold,
  selected with `create(['adapter=llvmpipe (…)'])` or `VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json`.
  Limits: binding 128 MiB, buffer 4 GiB. Features included `shader-f16`, `subgroups`, `timestamp-query`.

Consequences:
1. WGSL kernel tests run in Vitest under Node with llvmpipe in GitHub Actions. Playwright is for E2E/visual
   only (Chromium flags `--headless=new --enable-unsafe-webgpu --use-angle=swiftshader` remain the
   documented route if ever needed; several public CI workflows use them).
2. The studio host gets headless compute (`webgpu` as an optional dependency), so MCP `stats`/`embed`
   work with no browser tab open. Tab-forwarding remains the fallback when the host has no GPU.
3. Perf benchmarks are meaningless on llvmpipe (~50× slower); they run on real hardware only.
4. Known issue: process does not exit while a reference to the `create()` result is alive — drop it in teardown.

## 2026-09-07 — Compute layout: single buffer per column, dynamic offsets, ≤128 MiB windows

Spec defaults (**verified**, gpuweb spec): `maxBufferSize` 256 MiB, `maxStorageBufferBindingSize` 128 MiB.
Adapters may raise them but llvmpipe (our CI) stays at 128 MiB binding, so every kernel must operate on
windows ≤128 MiB. Design: one `GPUBuffer` per channel column (requesting the adapter max), bound through
dynamic bind-group offsets in fixed windows; kernels are "map over windows + reduce". Out-of-core paging
from OPFS for datasets larger than VRAM is a documented pattern (willusher.io) and is deferred to Phase 2.

Dispatch overhead, not shader throughput, is the dominant WebGPU cost (arxiv 2402.01836 and 2026
follow-ups report 24–71 µs per dispatch in browsers; **unverified** numbers, consistent direction).
Rule: minimise dispatches — one SOM epoch is O(1) dispatches over all windows, never one per code;
fuse compensate→transform→gate where possible; track dispatch count in benchmarks.

WGSL constraints (**verified**, WGSL spec): atomics are `u32`/`i32` only — histograms and SOM accumulation
use integer atomics or workgroup reductions. `shader-f16` is optional and absent on some real adapters.

## 2026-09-07 — Browser support policy

caniuse data pulled 2026-09-07 (**verified**): Chrome/Edge ≥113 (Linux: depends on hardware/drivers);
Firefox ≥141 default-on **only on Windows and Apple-Silicon macOS 26**; Safari default-on **only on
macOS 26 / iOS 26**. ~84% global usage.

Policy: WebGPU-only stands. The unsupported page must detect and explain (browser/OS/flag), and docs
recommend Chrome/Edge. `device.lost` is handled by recreating the device and reloading from the OPFS cache —
no CPU fallback.

## 2026-09-07 — Files: content-hash identity, OPFS cache, no directory handles

`showDirectoryPicker` is Chromium-only with formal negative positions from Mozilla and WebKit
(**verified** caniuse; positions unverified). Workspace documents reference FCS files by
`{sha256, basename, size}`; opening is via drag-drop / `<input webkitdirectory>` everywhere, with the
File System Access API as a progressive enhancement. OPFS is cross-browser; large files are read/written only
through `FileSystemSyncAccessHandle` in a Worker (never `FileReader` on whole files). Ship the PWA install
prompt early: installed PWAs are exempt from Safari's 7-day storage eviction (unverified).

## 2026-09-07 — Rust/wgpu: not now

wgpu is mature (30.0.1, Aug 2026, **verified** crates.io). But the `.wgsl` kernels are the portable asset,
not the host language; Rust would add a toolchain, wasm↔JS copy overhead, and larger bundles for no
decided target (no CLI, no native app). Keep kernels as standalone `.wgsl` files behind a thin `GPUDevice`
abstraction so a wgpu host could consume them later. `flow-gate-core` (Rust Gating-ML 2.0 engine with
compliance runner, 0.1.0 Apr 2026, **verified** crates.io) is a candidate second parity oracle for Phase 2.

## 2026-09-07 — Agent interface: text-first, images second

`CytoGate-Bench` (GitHub `leebyounghan/cytof-qa-pipeline`, created 2026-08-30, **verified**) benchmarks
LLM hierarchical gating step by step. A secondary source reports that plain LLM-from-text-histograms beat
both agentic self-verification and VLM-on-screenshot variants ("gate-tightening bias"); the cited bioRxiv
DOI did not resolve — **unverified**. Design accordingly: `describe_view` (axes, gates, density peaks,
histograms as compact text) is the primary tool; `snapshot` PNG is secondary and returned as a resource URI,
not base64. Tools return dense tables with size caps. Evaluate our tools on CytoGate-Bench once native gating
exists (Phase 2).

## 2026-09-07 — Testing pyramid

| Layer | Tool | Where |
|---|---|---|
| Unit: fcs, wsp, transforms, model ops, journal | Vitest + fast-check | Node |
| Kernel: each WGSL kernel vs its TS reference | Vitest + `webgpu` (llvmpipe) | Node, CI |
| Parity vs FlowAtlas.jl fixtures | Vitest | Node, CI |
| Integration: host convergence/restart/reconnect/auth | Vitest + Hocuspocus | Node, CI |
| E2E + visual regression | Playwright (Chromium, WebGPU flags) | CI |
| Perf: 1M/10M/50M synthetic, timestamp queries, dispatch counts | Vitest bench | real GPU only |

## 2026-09-07 — Prototype findings (measured)

- **Gating parity is exact vs FlowWorkspace.jl** (all 32 populations of `390C_tLN_023.fcs`, fixture in
  `fixtures/labels-390C_tLN_023.json`). Against FlowJo's own recorded counts: 332/1067 exact, 953 within 1%,
  all within 10%; the residual is polygon gates near the biex zero region — inherited from the FlowKit biex
  approximation and shared with the Julia oracle. All 1067 gates evaluate in ~2.2 s on the RTX (Node/Dawn).
- Oracle data facts: biex params vary per channel (4 widths, 4 `pos`, 3 `maxRange`); 6 samples have 18
  parameters instead of 19; compensated values exceed `$PnR` by up to ~5×.
- **GigaSOM.jl's EmbedSOM port has a bug** (`codes[i]*codes[j]` where EmbedSOM uses `codes[j]-codes[i]`).
  We implement the original; parity with the Julia embedding is therefore by cluster agreement only.
- SOM training uses a strided subsample (≤500k events) per epoch with CAS float atomics; the 400×400
  neighbourhood update is CPU-side. Embedding channels default to those with a biex transform (FlowAtlas.jl
  embedded *all* columns including FSC/SSC/Time — a deliberate deviation).
- **WGSL NaN**: implementations may fold `v != v` to false; use the bit-pattern test
  `(bitcast<u32>(v) & 0x7fffffff) > 0x7f800000`.
- Storage bindings must be 256-byte aligned; sample offsets are not. `bindAligned()` aligns down and passes
  the remainder as a `base` uniform.
- **Headless Chrome (SwiftShader) runs the whole compute pipeline but cannot present a WebGPU canvas**
  (`GPU process exited unexpectedly: exit_code=133`, missing `WebgpuSwapChainTexture` backing). Playwright's
  own launch flags also prevented adapter creation; `connectOverCDP` to a manually started Chrome works for
  compute. E2E rendering tests need a real display/GPU (xvfb + Vulkan untested).
- pnpm 11 uses `allowBuilds:` in `pnpm-workspace.yaml` (not `onlyBuiltDependencies`) for `webgpu`/`esbuild`.

## 2026-10-17 — Boolean population evaluation in the WebGPU gate pipeline

- **Decision:** normalized Boolean gates use sample-local population IDs, not names/paths. AND and OR
  accept any operand count: empty AND is the entire parent domain (all sample events at the root), empty
  OR is empty. NOT requires exactly one operand and complements it within the parent domain. Repeated
  operands are allowed and idempotent. These are explicit mathematical semantics, **not verified FlowJo
  Boolean parity**; the observed AND/OR/NOT schema does not establish its edge-case behavior.
- **Implementation:** standalone `boolean.wgsl` behind `Kernels`, exported `evaluateBooleanGate`, and
  integration in `gateSample` before dimension lookup. One in-place GPU fold per operand/window avoids
  limits on the number of storage bindings. The last fold intersects the parent and reduces counts;
  no event membership is computed on the CPU. Windows respect the smaller of 128 MiB, device binding
  limits, the requested test/window limit, and dispatch limits. Input masks start at event zero; geometric
  column and output label slices continue to support unaligned sample offsets.
- **Validation:** iterative topological sorting includes both ancestry and Boolean-reference edges;
  duplicate/empty IDs, dangling references/parents, unknown Boolean operations, invalid NOT arity, and
  cycles reject before dispatch. Later-ordered and non-leaf references work. Unsupported geometric gates
  retain the existing skipped reporting; a Boolean gate depending on an unevaluated gate/parent rejects
  explicitly instead of producing a misleading zero or unrestricted result.
- **Ownership:** input buffers are borrowed. All per-gate masks remain alive for the sample evaluation,
  including later references and label submissions. Success transfers masks only with `keepMasks`; otherwise
  they are destroyed. Rejection destroys all produced masks even with `keepMasks`. Temporary counters,
  uniforms, dummy masks and readback staging buffers are explicitly released. Peak mask memory remains
  O(events × evaluated gates), as before; last-consumer reclamation/out-of-core evaluation is deferred.
- **Compatibility:** label selection remains based on ancestry leaves, not reference dependents. Geometric
  membership WGSL and transforms are unchanged. The gate wrapper reserves aligned-down buffer prefixes
  to enforce binding ceilings; label bases are in u32 units so strides such as three words remain aligned.
- **Evidence (verified locally):** synthetic Dawn GPU tests cover Boolean truth tables, parent restriction,
  empty identities, unary NOT, multiple windows, later/non-leaf references, nested Boolean/geometric gates,
  labels and unaligned slices, borrowed/owned buffer cleanup, malformed DAGs and a 20,000-gate chain.
  The local regression suite passed all 86 tests, including exact Julia fixture parity and all 1067
  geometric gates (332 exact FlowJo counts, 953 within 1%, none skipped). These geometric results are not
  evidence of Boolean parity. GPU: Dawn/Metal, Intel UHD Graphics 630; llvmpipe was not run locally.

## 2026-10-17 — Preserve unsupported WSP transforms; reject numerical substitution

- **Decision:** `TransformSpec` gains `UnsupportedTransformSpec` (`type: "unsupported"`,
  `originalType`, qualified XML `element`, and `attributes: Record<string, string>`). Preserve
  case, attribute prefixes, and decoded string values without numeric coercion. These are the
  transform element's attributes, not a lossless XML tree or a native transform implementation.
  `readWsp` still succeeds so agents can inspect metadata before requesting computation.
- **Failure contract:** `table` throws exported `UnsupportedTransformError`, with stable code
  `UNSUPPORTED_TRANSFORM`, the preserved `spec`, and optional structured `context` (sample ID,
  sample name, channel). The browser importer preflights every transform of matched samples
  before reading FCS data or allocating GPU resources; even an unused unsupported channel in
  a matched sample rejects rather than silently producing a partially transformed workspace.
  Unmatched samples remain irrelevant to browser computation. Existing UI error logging displays
  the contextual message. Lower-level GPU APIs consume tables, not transform specs.
- **Evidence (verified):** the old WSP parser replaced every non-linear/log/biex family with
  linear defaults. Locally read FlowJo 11.2.0 `JSONSchemas/primitives.json#/definitions/transform`
  (SHA-256 `98ad952b6334caacf6cb37d6777f618e0c4b2aa5a5eb4206f974efc9ba51ccb1`)
  declares fasinh, fatanh, hyperlog, logicle, and capitalization/ArcSinh/ArcTanh variants.
  This verifies declarations only, not WSP encodings or numerical equivalence. The existing
  local research note records the artifact integrity qualification; no target code was run.
- **Compatibility:** supported lowercase linear/log/biex parsing and numerical implementations
  are unchanged, as are missing-transform raw channels. Case variants and unknown future XML
  families remain unsupported rather than being guessed equivalent. Consumers must handle the
  added discriminant; the inspected production consumer is the browser importer, and compute
  parity tests call the same rejecting `table` entrypoint. No dependencies or kernels changed.
- **Regression coverage:** synthetic mixed-family imports, preservation of nonnumeric/empty/
  namespaced attributes, JSON round trips, typed table errors and contextual messages, and
  unchanged supported dispatch. Existing Julia fixtures and WSP/GPU oracle tests remain the
  numerical regression authority, not evidence of native unsupported-family parity.
- **Measured validation:** Node 24.18.0/pnpm 11.16.0; lint, typecheck, UI production build,
  and 97 tests passed (one Vitest worker). GPU oracle results remained 1067 evaluated,
  332 exact FlowJo counts, 953 within 1%, none skipped, on Dawn/Metal Intel UHD 630.
  A direct Vite-loaded UI importer smoke check verified contextual rejection before any
  file/GPU access. The initial full test run passed assertions but exited with a Vitest
  worker-process error; an identical full rerun exited cleanly. Cause not established.
