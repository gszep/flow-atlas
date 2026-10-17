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

## 2026-10-17 — Explicit conventional compensation, GPU-only numerical path

**Verified convention:** FlowUtils `src/flowutils/compensate.py` on its upstream
master branch (read 2026-10-17) compensates with
`np.linalg.solve(spill_matrix.T, comp_data.T).T` and reverses with the row product
`np.dot(inv_comp_data, spill_matrix)`. Source:
https://raw.githubusercontent.com/whitews/FlowUtils/master/src/flowutils/compensate.py.
Therefore recorded row y = true row x * S; our WGSL computes x = y * inverse(S),
without transposing the inverse. This verifies the convention, not FlowJo native parity.

`prepareCompensation(k, channelNames, spill, maxBinding)` returns an immutable,
device-bound plan with exact-name sample indices and JSON GPU diagnostics.
`compensateChunk(k, plan, Float32Array, maxBinding)` borrows row-major data and
returns fresh sample-order data. A standalone setup WGSL kernel uses partial-pivot
Gauss-Jordan inversion and evaluates both inverse-product residuals and the infinity
condition number. A separate WGSL kernel applies the inverse to event rows. No CPU
numerical inversion, solve, compensation, or fallback is shipped. CPU work validates
metadata and f32 representability only. Inputs must explicitly identify participating
channels; no detector-name heuristic or automatic application is provided. Acquisition
scale eligibility is the caller's responsibility.

**Limits/policy:** 1–128 compensated channels, square conventional matrices only;
spectral OLS/WLS are unsupported. Duplicate/empty/missing exact channel names reject.
Nonzero matrix coefficients that become subnormal/zero in f32, nonfinite coefficients,
singular pivots, nonfinite setup arithmetic, condition infinity >10,000 or two-sided
residual infinity >0.001 reject. These thresholds are conservative product safeguards,
not a proof of biological suitability. GPU diagnostics are explicitly tagged
`gpu-computation`, separate from imported FCS metadata. Status 1 = singular pivot,
2 = nonfinite setup arithmetic, 3 = condition/residual rejection, 4 = nonfinite
participating input/event arithmetic. Event numericalErrors counts failing output
channel values in the first rejected window, not imported metadata warnings or a
whole-file total. No partial output is returned on rejection.

All matrix and staging buffers fit the caller/device limit, capped at 128 MiB;
the square matrix must fit one binding (64 KiB at the ceiling). Event windows contain
whole rows, obey dispatch limits, and upload/read back one window at a time. Fresh
window buffers bind at offset zero rather than allocating a whole-chunk GPU buffer
and binding dynamic offsets; thus even chunks larger than maxBufferSize are streamable.
Nonparticipating channels are copied bit-for-bit; negatives and above-range values
are not clamped. Plans retain only inverse/mapping GPU buffers and must be destroyed.
Destroy is idempotent, rejects new work, and defers actual buffer release until all
already-started calls finish. Each call cleans temporary buffers even on rejection.

**Measured tests:** asymmetric 2x2/3x3 mixtures (including a required row swap),
reordered/subset channels, immutable snapshots, negatives/high values, repeated and
concurrent calls, 16-byte windows, nonparticipating NaN payload preservation, complete
row validation, empty chunks, singular/ill-conditioned and invalid metadata rejection,
overflow diagnostics, success/error cleanup, in-flight destroy, and the 128-channel
ceiling. Local Dawn/Metal targeted tests pass; the 128-channel setup plus two chunks
took about 1.4 seconds including cold shader compilation. Remote llvmpipe behavior and
production large-file throughput remain **unverified**; no spectral or native FlowJo
numerical parity claim is made.

**Measured required validation:** Node 24.18.0/pnpm 11.16.0, isolated dependency
setup 2.2 s; lint 0.949 s and declaration/typecheck build 1.753 s in parallel,
then all 141 tests in 13 files passed (17.294 s command wall time). Total check
elapsed 19.051 s, scheduling queue <0.001 s per job. At most two CPU check jobs,
2 GiB heap per process; the full test invocation used one worker, hence one GPU
suite at a time, after declaration outputs were ready. No UI build was required
for this compute-only slice. Full logs and timings were retained in the session's
approved temporary directory under `compensation-validation/`.

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

## 2026-10-17 — Injectable studio analysis transport, not a second analysis backend

**Decision:** `@flow-atlas/host` exposes one strict Zod operation registry and an
injected `AnalysisService.invoke(name, args, signal?)` / `close()` contract. Both
JSON-RPC `/rpc` and MCP `/mcp` call that contract. File authorization, conventional
compensation, GPU resources, export jobs and receipts remain backend responsibilities;
this adapter does not implement them, spectral unmixing, a CPU fallback, or shared
Yjs/document/journal state. TypeScript remains the host language: no measured Rust
advantage has been established for this transport-only slice.

**Verified:** official TypeScript SDK `packages/middleware/node/src/streamableHttp.ts`
and installed pinned v2 declarations support `NodeStreamableHTTPServerTransport`
from `@modelcontextprotocol/node@2.1.1`, `sessionIdGenerator: undefined`,
`enableJsonResponse: true`, and `handleRequest(req, res, parsedBody)`. A fresh
`McpServer` (`@modelcontextprotocol/server@2.3.1`) and transport per HTTP request
share only the injected backend. Zod 4.6.7 schemas implement Standard Schema;
the handler cancellation signal is `ctx.mcpReq.signal`, not a v1 callback field.
The SDK client's Streamable HTTP initialization/list/call flow is the tested
surface, not the newer `createMcpHandler` discovery protocol or server-push SSE.

**Security:** explicit trusted startup bearer token; literal loopback bind only;
exact bound Host and optional exact Origin checks; analysis endpoints authenticate
before parsing; 1 MiB request/JSON-response limits and bounded recursive JSON
serialization. MCP tool payloads have a conservative 256 KiB limit for envelope
and escaping headroom. Static built assets are explicitly configured, realpath
confined and streamed separately. Health contains no token or paths. Backend
`AnalysisError` fields are public and shared between RPC error.data and MCP
isError/structuredContent.error; unexpected errors hide details. SDK pre-handler
input-validation failures retain SDK isError text. Server close aborts HTTP calls,
closes connections, invokes backend close once and drains outstanding work; backend
cancellation cooperation is required. Cross-request MCP cancellation notifications
are not supported by these request-local sessions; job cancellation is explicit.

**Measured:** fake-backend HTTP integration tests exercise SDK client initialization,
discovery, calls, shared RPC invocation, validation, typed and sanitized errors,
authentication, Host/Origin rejection, chunked body limits, response limits,
disconnect cancellation in both protocols, idempotent draining shutdown and static
symlink confinement. Contract tests cover every operation, strictness, bounds and
finite coefficients. No actual GPU device, analysis implementation, collaboration,
or vendor numerical parity is claimed by these transport tests.
## 2026-10-17 — Agent-first FCS jobs and a benchmark-gated native backend

**Verified user direction:** the primary client is an agent, either collaborating
with a human or gathering evidence in an automated experiment loop. Rust is an
option **if** its scalability benefit is demonstrated. Node 24/Dawn is the current
baseline; an injected analysis-service boundary and portable WGSL keep a future
Rust/wgpu worker possible without changing tool names. No Rust performance claim
or production Python dependency is introduced. The checked OSS references and
conditional adoption thresholds are in `reference/programmatic-cytometry.md`.

**Implemented choice:** the studio composes the reviewed MCP/JSON-RPC transport
with native FCS import/inspection, GPU conventional compensation and queued FCS
exports. The same backend serves both transports. Metadata/event pages are bounded;
full event streams stay local. Inputs are hashed, bounded-copy snapshots, and each
export rechecks its input hash. One export runs at a time; GPU calls are serialized
at chunk boundaries. Caches and queues have explicit limits; sample metadata uses
LRU eviction while the compact catalog retains identities. Completed observations
can be reloaded from disk after in-memory eviction.

**Evidence contract:** jobs record source/output hashes, exact operation parameters,
matrix and GPU diagnostics, shader/build identity, precision, adapter/runtime and
queue/setup/processing times. A successful FCS and its receipt are published together
by directory rename. Failed/cancelled work discards its staged FCS; cancellation
does not preempt submitted GPU work. Committed receipts are authoritative after a
restart if the secondary status index is missing. Incomplete jobs do not silently
resume. These are computation receipts, not UI-written human provenance stamps or
a replacement for the future shared workspace journal.

**Scope:** stored values are decoded to F32. Compensation/export require linear,
unit-gain participating/exported channels; no implicit acquisition scaling, spectral
OLS/WLS, or lossless F64/I64 export is claimed. Compensated output removes active
spillover aliases and records matrix context separately. Raw channel selection must
retain a complete active spill panel or omit it entirely. Source files are not modified.

**Build choice:** the host build bundles workspace code and the standalone WGSL
assets for Node, leaving the pinned MCP SDK and optional Dawn addon external.
Declarations are emitted separately, so incremental typechecking cannot replace a
working runtime bundle with unresolved `?raw` imports. The studio executable starts
one process with optional static browser assets; it is not a general-purpose analysis
CLI. The browser's existing WSP visualization is not claimed to be a full new FCS UI.

**Measured locally before final integration review:** all 236 tests passed, including
the real MCP→backend compensation/export workflow. A compiled Node-process smoke
also imported, compensated, exported, re-read and shut down successfully. Kernel,
streaming I/O and transport changes received separate independent reviews; the
composed backend still requires its own review and final-head CI.
## 2026-10-17 — Composed-backend review corrections

Independent review reproduced four defects on `74f4c7c`: a pre-existing receipt
directory symlink exposed an outside-root record; cold-cache hash and metadata
opens could be separated by replacement; FIFO import blocked before regular-file
validation; and a 1 KiB event budget rejected an otherwise valid 17×17 matrix.

Reads now check the complete canonical path and descriptor identity, use
nonblocking read-only admission with authoritative `fstat`, and bind input hashing
and metadata parsing to the same descriptor. Event arrays remain chunk-bounded,
while persistent matrix bindings use the actual GPU binding limit. Regression
tests exercise each case, including cancellation-safe FIFO cleanup and both
preview/export with the larger matrix. The filesystem checks reject ordinary
symlink escapes; they do not claim OS isolation from hostile same-user writers.

The added descriptor verification entails another input read at import. The
earlier 4 GB baseline is retained with its build identity; repeat the benchmark
before attributing its timings to this corrected build.
## 2026-10-17 — Corrected-build scalability measurement and independent recheck

**Measured:** all four composed-backend review repros pass on `bc82737`; independent
review approved the fixes. Local validation passes 242 tests and the compiled Node
workflow. Linux CI run `38986915693` passed lint, typecheck, host build, the compiled
GPU workflow and 199 tests; ten private-oracle tests skipped as intended.

The corrected build processed 50M × 20-channel events (4 GB F32 DATA) with
353,558,528-byte OS-reported peak host RSS and a 2 GiB watchdog. Import took
34.817 s, GPU setup/validation 0.121 s, and the export job 58.633 s; the latter
includes verification, decode, GPU work, readback and file writing. Input/output
hashes match the earlier run on the same Metal backend. This is one measured
Node/Dawn baseline, not a Rust comparison or proof of bounded memory for the
older full-sample gating/rendering paths. Source/build identity and complete
measurement qualifications are in `reference/native-fcs-benchmark.md`.

## 2026-10-17 — Named GPU spectral OLS with appended derived channels

**Decision:** spectral unmixing is a separate explicit API, not a rectangular
interpretation of conventional compensation. `SpectralMatrix` names detectors
and fluorochromes independently and stores row-major F-by-D reference coefficients:
`measured[D] = abundances[F] * reference[F,D]`. `prepareSpectralUnmixing` returns
an immutable same-device `SpectralPlan`; `unmixChunk` returns every original input
column followed by named fluorochrome columns and an optional named L2 residual.
All names are nonempty/unique; detector names must match inputs exactly and derived
names cannot collide. No first-M positional replacement, channel heuristic,
nonnegativity clipping, WLS/WOLS, SpectralFX or FlowJo numerical parity is claimed.

**Verified primary reference:** FlowUtils `compensate_spectral_ols` at pinned
commit `b3aa2708eb25953e4e4dd9f9edcba3d503297e50`, source
`https://raw.githubusercontent.com/whitews/FlowUtils/b3aa2708eb25953e4e4dd9f9edcba3d503297e50/src/flowutils/compensate.py`,
uses `np.linalg.lstsq(spill_matrix.T, comp_data.T, rcond=-1)[0].T`.
That verifies the unweighted objective/orientation only. Its positional overwrite
of the first M channels and NumPy rank policy are deliberately not inherited.
No Python runtime dependency or external numerical implementation was imported.

**Math policy:** standalone WGSL performs all numerical preparation and event
application. Setup normalizes by the GPU-computed largest absolute coefficient,
then computes column-pivoted Householder QR of `A = reference.T / scale`, with
recomputed trailing column norms and normalized Householder vectors. GPU triangular
solves build the pseudoinverse in the declared fluorochrome order; no normal
equations, CPU solve, or numerical fallback exists. Require `1 <= F <= D <= 128`.
A pivot norm <=1e-6 times the initial largest column norm rejects; reported rank
is accepted QR pivots, **not** an SVD numerical-rank estimate on failed inputs.
Accept only `||A||inf * ||A+||inf <= 10000`, `||A+ A-I||inf <= 0.001`, and
`||A A+ - (A A+)T||inf <= 0.001`. The latter tests orthogonality of the fitted
projector, not zero event residual. These conservative f32 product safeguards
are not error bounds, a 2-norm condition number, or biological suitability claims.
Diagnostics explicitly say `source: gpu-computation` and name the algorithm,
limits, dimensions, accepted rank, condition, setup residuals and matrix scale.
Status 1 = rank rejection; 2 = unsafe setup arithmetic/range; 3 = condition/quality
rejection; 4 = event error. Setup errors count once; event errors count failing
rows in the first rejected window. Failed-setup quality metrics may be incomplete;
unavailable/nonfinite metrics are represented by zero to keep diagnostics JSON-safe.

**Precision/range policy:** coefficients must be finite normal f32 or zero (CPU
metadata validation only). Nonzero pseudoinverse entries that become subnormal,
zero or nonfinite on rescaling reject on the GPU. Participating nonfinite event
values, nonfinite accumulated abundance/prediction/residual values and overflow
reject the entire call without returning partial output. Residual L2 uses scaled
sum-of-squares to avoid unnecessary squaring overflow. A large but finite event
residual is QC, not an implicit rejection criterion. Derived arithmetic follows
WebGPU f32 semantics, including possible subnormal flushing; neither negative nor
above-range finite values are clamped. Original columns use u32 copies on GPU and
CPU readback placement, preserving even nonparticipant NaN payloads, signed zero
and subnormal bit patterns.

**Ownership/limits:** setup's `maxBinding` is a persistent-matrix budget, distinct
from `unmixChunk`'s event budget. Every buffer is capped by 128 MiB and actual
device binding/buffer limits; both budgets must be integers >=32 bytes. Largest
setup binding is D-by-D f32 (64 KiB at D=128). Event windows contain whole rows,
bounded by both input and larger appended-output strides and dispatch limits.
Each fresh GPU window binds at offset zero; there is no whole-chunk GPU allocation.
The caller owns the CPU chunk input/output budget, and borrowed event data must
remain unchanged until completion. Metadata is snapshotted before setup awaits.
Plans retain only reference/pseudoinverse/mapping buffers; temporary resources are
released on success and rejection. Destroy is idempotent, rejects new calls, and
defers persistent cleanup until all already-started concurrent calls finish.

**Measured locally:** Dawn/Metal tests cover asymmetric 3-by-2/4-by-2 forward
models with independently constructed orthogonal noise, exact mixtures and pivot
reordering, bit-preserved original columns, unequal strides/multiple windows,
immutable snapshots, byte-offset subarrays, repeated/concurrent calls, empty data,
names/shapes/rank/condition/range errors, large residual norms, cleanup after
success/failure, in-flight destroy, and the full 128-by-128 ceiling with a 1 KiB
event budget. This is synthetic mathematical validation, not NumPy execution,
vendor parity, llvmpipe validation or large-file throughput evidence.

**Required validation measured:** isolated dependency installation 5.250 s;
Node 24.18.0 / pnpm 11.16.0. Lint (2.939 s) and declaration/typecheck build
(6.296 s) ran in parallel, then the full suite passed 254 tests in 19 files
(42.688 s command wall time; Vitest setup 0 s, transform 1.23 s, import 3.25 s,
assertions 29.40 s). Total checks 48.988 s, per-job scheduling queue <0.001 s.
At most two check jobs, 1536 MiB Node heaps, one Vitest worker/one GPU suite at
a time; declarations precede workspace-importing tests. Logs are retained in the
session's approved temporary directory under `spectral-validation`. These timings
are local validation costs, not spectral-throughput measurements or remote CI.

The final rerun also exercises a lowered dispatch ceiling and deletion of the
optional residual name during asynchronous setup: **255 tests / 19 files pass**,
including 13 spectral tests. Lint 1.005 s, incremental declaration/typecheck
1.002 s, full test command 24.661 s; total 25.667 s, queue <0.001 s. Vitest reports
0 s setup, 0.686 s transform, 1.74 s import and 17.44 s assertions. It reuses the
same built workspace declarations and the same bounded scheduler policy.
