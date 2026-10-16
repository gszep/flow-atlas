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

## 2026-10-17 — Agent-first workspace definition foundation

`@flow-atlas/model` owns a strict schema-v1, JSON-safe definition document and pure atomic gate
transactions, not a UI clone, CRDT, host, journal, or numerical engine. **Verified** against the
tracked `HANDOFF.md` / `lessons-from-decks.md` contracts: sample content-hash references, per-sample
channels/display transforms, raw-space gate DAG, groups, and annotations belong in the document;
event data and derived arrays do not. Existing polygon/boolean and transform types are reused
with type-only workspace dependencies; there are zero external runtime dependencies.

Transactions require `expectedRevision` and agent identity, increment once only on effective
change, and return transient dependency invalidation IDs for a future host/cache adapter.
Parent and boolean dependencies share an acyclic sample-local graph. Explicit cascading deletion
also removes attached annotations; the alternative rejects dependencies. Human stamps can be
read from trusted persistence but cannot be supplied/removed through operations. Protection
extends conservatively to human-finalized dependents and annotations, including ancestor edits.
Authentication, atomic disk publication, journal/revert and UI-only finalization stay adapter work.

Persistence uses `null` for unbounded rectangle endpoints rather than serializing infinities.
Unknown fields and non-JSON values are rejected (including event/results payloads); unsupported
geometry/transform/schema/operation kinds produce explicit capability errors, never silent
approximation. Polygon topology and numerical transform fidelity are not claimed by this layer.
**Measured**: behavioral tests exercise roundtrip stability, batch atomicity, stale revisions,
cycles, cascade closure, provenance protection, no-op attribution/revisions, and data-ingress
rejection. FlowJo native numerical behavior remains **unverified** by this implementation.

**Measured** oracle projection: all 33 samples / 1067 gates can be represented with per-file
SHA-256 references and no count/event payloads. The test-only WSP projection deliberately maps
unbounded rectangle endpoints to `null` and deduplicates sample-group membership. An initial
projection test rejected duplicate group refs (for example Blood: 4 refs, 2 unique); the strict
model rejects those duplicates rather than silently normalizing arbitrary input. No production
WSP importer or numerical algorithm was changed.

## 2026-10-17 — Protect annotation net state independently of gate invalidation

**Measured** regression: cascading deletion followed by identical gate recreation removed a
human-finalized annotation without any net gate-definition change. The same bypass affected
annotations on a completely recreated parent/boolean dependency closure. Annotation protection
now compares each finalized annotation's own before/after state, in addition to the existing
dependency protection; gate invalidation is not a proxy for annotation modification. Regression
tests verify atomic rejection with the original document and revision unchanged. Resurrecting a
finalized dependent gate without its stamps remains rejected. Explicit cascade deletion of an
unstamped annotation remains permitted even if its gate is recreated identically: this is a
document change with deleted-annotation reporting, not gate-definition invalidation.

## 2026-10-17 — Integrated agent-first capability wave and evidence qualification

**Verified user direction:** transfer scientific and workflow capabilities into
efficient agent operations, not FlowJo's UI layout. `docs/agent-first-roadmap.md`
tracks the initial capability families and distinguishes implementation from
vendor declarations and runtime compatibility. Core operations remain shared
building blocks for a future studio/MCP adapter; no transport is claimed here.

**Measured integration:** all 131 tests in 12 files, lint, root typecheck, UI
typecheck and production build pass on Calcifer with Node 24.18.0 and pnpm 11.16.0.
The combined check scheduler used two jobs, with one Vitest worker and serial
GPU suites. Declaration build preceded tests because workspace imports consume
those outputs. Lint took 1.117 s, root typecheck 2.726 s, tests 15.658 s, UI
typecheck 2.385 s, and UI build 3.307 s (command wall times, overlapping where
independent); total elapsed time was 18.406 s and maximum scheduling wait 0.018 s.
Initial isolated dependency setup took 2.3 s; adding model workspace links took
1.0 s. These are local checks, not remote CI or native FlowJo numerical validation.

**Evidence correction:** historical test output described as “953 within 1%”
means relative error at most 1% **or** absolute difference at most two events.
“Exact Julia fixture parity” refers to the existing single-sample count fixture,
not event-mask identity or Boolean interoperability. The preceding entries keep
their original wording for history; use this qualification in new reports.

## 2026-10-17 — CI oracle discovery and software-GPU startup bounds

**Measured CI failure:** run `38939791664` exposed an existing WSP oracle read
inside the skipped suite's collection callback, and a new Boolean test whose
five-second budget included cold llvmpipe adapter startup under concurrent GPU
suites. The fixture read now runs in `beforeAll`, so absent private oracle data
skips the six oracle assertions without preventing synthetic XML tests from running.

GPU suites initialize their adapter in a separately bounded 30-second `beforeAll`
hook. Kernel-test assertions and per-test timeouts are retained. CI uses two Vitest
workers, one llvmpipe thread per worker, and a 2 GiB Node heap cap to bound nested
concurrency. **Measured locally:** 131 tests still pass with two workers; explicitly
selecting an empty oracle directory yields two synthetic XML tests passing and
six oracle tests skipped. Lint/typecheck pass. Remote rerun is required before
claiming llvmpipe validation of this correction.

## 2026-10-17 — Bounded native FCS binary streams for agent workflows

**Decision:** `@flow-atlas/fcs` adds `FcsByteSource`, `blobSource`, `openFcs` and
`writeFcs`, with no runtime dependencies. Agents can inspect `reader.metadata`
(`Omit<FcsFile, "data">`) before pulling event-major chunks. Absolute event slices
and bounded random-access reads avoid whole-file/prefix buffering, including
DATA beyond 100 MB. CPU work is binary I/O only, not compensation or transforms.
The eager `readFcs` API retains its tested historical truncation behavior; the new
reader exposes `countPolicy: "exact-declared"` and rejects mismatched/truncated
DATA rather than silently reducing `$TOT`. Metadata count is declared and
extent-validated, not a claim that every external read has already succeeded.

**Limits and ownership:** combined primary/supplemental encoded TEXT ≤16 MiB;
channels ≤65,536; spill coefficients ≤2,097,152; one chunk's source bytes plus F32
decoded bytes ≤128 MiB. JS metadata objects/strings add bounded representation
overhead. Writer input chunks and each emitted byte array are ≤128 MiB; defaults
target 1 MiB. No prefetch or output accumulation. Sources and input chunks are
borrowed; stable backing storage, transport cancellation/timeouts, and retained
output are caller responsibilities. Signals are checked at await/chunk boundaries
but cannot interrupt an uncooperative custom `read`/iterator promise. Failed or
abandoned exports are partial output and must not be published. See
`packages/fcs/README.md` for the exact API/ownership and compatibility contract.

**Format policy:** single-dataset list-mode FCS2.0/3.0/3.1; F/D and byte-aligned
8/16/24/32/64-bit unsigned integers, ascending/descending byte order. Existing
integer range masks remain binary decoding, with uint64 masking now performed
before float conversion to preserve low bits. Shared decoder returns F32 (D/I64
precision can be rounded). Writer emits FCS3.1 F32 little-endian, regenerates
structural/channel fields in array order, uses zero HEADER DATA fields and TEXT
offsets above 99,999,999, and strips stale spill aliases. Only explicit
`metadata.spill` writes canonical `$SPILLOVER`; omitted spill prevents accidental
double-compensation of compensated exports. Spill dimensions, names and finite
coefficients are validated. No numerical compensation is implemented here.

Nonzero amplification and non-unit gain reject export pending explicit upstream
numerical conversion; silently changing `$PnE` would mislabel raw logarithmic
acquisition values. This conservative gain restriction is not a limitation of the
FCS standard. Negative/above-range float values are not clamped. Zero-event output
has at least one channel, zero DATA offsets and no DATA bytes. UTF-8 is the explicit
default for both readers/writer; legacy single-byte reads require `textEncoding:
"latin1"` (WHATWG Windows-1252). Writer escapes delimiters and rejects empty/NUL
keyword values or invalid Unicode. Historical-tool Unicode interoperability and
other zero-event conventions are **unverified**.

**Verified primary sources read:** FlowIO `src/flowio/create_fcs.py` at
`https://raw.githubusercontent.com/whitews/FlowIO/master/src/flowio/create_fcs.py`
documents UTF-8, inclusive offsets, zero header offsets above 99,999,999, F32 and
zero `$PnE`. FlowUtils `src/flowutils/compensate.py` at
`https://raw.githubusercontent.com/whitews/FlowUtils/master/src/flowutils/compensate.py`
uses `solve(S.T, data.T).T` and inverse `data @ S`: row-major spill convention is
recorded row `y = true row x * S`. Implementation here is independently written
bounded I/O, not copied numerical code.

**Measured locally:** Node 24.18.0, pnpm 11.16.0, isolated dependencies installed
in 2.3 s. Lint, typecheck and all 186 tests passed; all 33 oracle FCS files match
eager/streamed values event-by-event with 4,093-event chunks. The new 55 synthetic
stream tests include sparse >100 MB reads, both endian orders, F/D/mixed-width I,
uint64 masks, cancellation/cleanup, UTF-8/delimiter roundtrips, output sanitation,
malformed spill/metadata, exact byte counts, zero events and bounded chunks.
Absent-oracle execution passes 67 synthetic tests with two oracle tests skipped
(3.191 s). UI production build passes (3.634 s), guarding the shared browser import.

Validation used a two-job ceiling, 1 GiB Node heaps and one Vitest worker so GPU
suites do not overlap. Queue/execution/total seconds respectively: lint
0.004/2.025/2.029; typecheck 0.004/4.429/4.434; tests 2.030/22.530/24.560. Combined
elapsed 24.561 s; Vitest reports 0 s setup, 0.568 s transform, 0.988 s import and
14.25 s assertions. Dependency setup is reported separately above. UI build and
absent-oracle tests ran as independent two-job checks. GPU regression was local
Dawn/Metal Intel UHD 630, not llvmpipe or remote CI; no remote CI success claimed.
