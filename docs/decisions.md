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

## 2026-10-17 — Explicit GPU acquisition linearization profile

**Verified source:** FlowIO `flowdata.py` at pinned commit
`83d28a22d42235c10d17afb017250ee208afed95`, locally read lines 250–290 and
635–733. Its preprocessing uses `log0 * 10^(decades * stored / range) / gain`
for positive decades, normalizes zero log0 to one, divides linear channels by
gain, and ignores selected Time gain while multiplying Time by timestep. This
verifies shared mathematics, not native FlowJo parity or Float64 equivalence:
FlowIO materializes NumPy Float64; this implementation uses GPU F32 only.

**Decision:** `prepareAcquisition(k, channels, options, maxBinding)` snapshots a
device-bound immutable plan; `linearizeChunk(k, plan, data, maxBinding)` returns
fresh row-major F32 output. It is opt-in stored→acquisition-linear conversion,
not a display transform, compensation, or automatic import/export step. CPU work
only validates/packs metadata and copies buffers. The standalone acquisition WGSL
does all event arithmetic. Callers own FCS output metadata sanitation.

The profile `stored-to-acquisition-linear-f32-v1` records effective F32 per-channel
operations, normalized log0, ignored Time gain, selected Time name and resolution,
timestep, precision and numerical policy in JSON. Names must be nonempty and
exact-unique. Explicit `timeChannel` must resolve exactly; otherwise only a unique
case-insensitive exact `Time` qualifies (not `Time-A` or prefixes). Ambiguity,
logarithmic Time, linear amplification `(0, nonzero)`, and an explicitly supplied
non-unit timestep without Time reject. Timestep defaults to one; gain, range and
timestep must be positive finite normal F32; decades/log0 allow zero. Gain zero
rejects, deliberately unlike FlowIO's zero-gain quirk. Time gain is validated but
ignored. These strict policies are not claims about all historical FCS producers.

Identity operations use u32 copies preserving NaN payloads, infinities, subnormal
bits and negative zero. Transformed channels reject nonfinite/subnormal input,
nonfinite arithmetic and nonzero subnormal intermediates/results, with guards
before arithmetic to avoid GPU flush-to-zero/saturation hiding failures. Log
evaluation computes decades×value, divides range, multiplies log2(10), applies
exp2, multiplies log0, then divides gain. Its conservative exp2 exponent interval
[-126, 127.99998] is recorded in metadata. Intermediate rejection may reject a
mathematically representable final result; this is an explicit portable F32 safety
policy, not a high-precision solver. Linear negatives and above-range values are
retained; no clipping or Time correction heuristic is applied. Numerical errors
carry JSON `source: gpu-computation`, failing-channel-value count and event bounds
of the first rejected window, not whole-input totals. No partial result is returned.

**Limits/ownership:** 1–4096 channels; 32 metadata bytes/channel, bounded separately
at preparation by the actual caller/device binding limit. Chunk maxBinding is an
event-window budget, not a second cap on persistent metadata. Whole-row windows
obey 128 MiB, device storage/buffer and dispatch limits. Zero-offset window buffers
stream input chunks larger than a single GPU buffer, as compensation does. Input
storage is borrowed and must remain unchanged until completion. Plans permit
concurrent same-device calls; idempotent destroy rejects new calls and defers
persistent buffer release until active calls finish. Temporary/readback resources
are released on success and failure. Output is accumulated only within the caller's
chunk; callers remain responsible for chunk-level host-memory bounds.

**Measured targeted evidence:** Dawn/Metal tests compare an independent test-only
closed-form scalar reference for gain/log/time, normalized log0, negatives and
above-range values. Coverage includes identity bit preservation, nonzero input
byte offsets, multiwindow rows, metadata rejection, Time selection/defaults,
nonfinite/overflow/underflow diagnostics, empty/malformed input, immutable plans,
the 4096-channel ceiling, concurrent/in-flight destroy and allocation cleanup.
Remote llvmpipe, native FlowJo parity and large-file throughput are unverified.

**Measured required validation:** Node 24.18.0/pnpm 11.16.0, isolated dependency
installation 4.6 s. Lint and declaration/typecheck ran concurrently (two jobs,
2 GiB heaps), then the full suite used one worker/one GPU suite at a time because
workspace imports consume declaration outputs. Queue/execution seconds: lint
0.003/2.339, typecheck 0.004/6.707, tests 6.712/44.873; total 51.585 s. All 253 tests
in 19 files passed, including 11 acquisition tests. Vitest reported setup 0 s,
transform 1.33 s, import 4.18 s and assertions 29.30 s. Logs/timings are retained
in the session's approved temporary directory under `acquisition-validation/`.

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
## 2026-10-17 — Explicit input spaces and named OLS in the agent API

**Decision:** `register_unmixing` adds named detector/fluorochrome OLS, and preview,
matrix registration and export accept opt-in `inputSpace: linearized`. Stored
remains the default for unbound calls. Registered matrices bind their input space
and effective acquisition settings; using a conflicting request context rejects.
Stored-space conventional definition IDs retain their previous hash structure.
Conventional compensation and spectral OLS cannot silently stack in one request.

The processing order is stored F32 decode → optional acquisition scaling → one
registered matrix operation → explicit channel selection/rename → FCS serialization.
Original spectral input columns remain in that selected input space; named
fluorochromes and optional Euclidean L2 residual are appended. Row windows use the
larger input/output stride. The current host exchanges bounded arrays between
stages; GPU-resident fusion is a follow-up, not an asserted property.

Linearized exports reset gains/amplification and canonical timestep metadata to
avoid reapplying conversion downstream. Legacy TIMESTEP aliases are reconciled;
conflicts require an explicit override, and output aliases cannot override managed
linearized time metadata. Time edits require positive decimal values. Derived
outputs cannot impersonate Time, and changing an unlinearized Time identity with
non-unit timestep rejects. Nominal output ranges are metadata, not clipping limits
or measured extrema. Receipt channel roles track selected/renamed output columns.

Receipts include bound context, actual acquisition profile/effective metadata hash,
matrix setup diagnostics, and source chunk coordinates on numerical rejection.
Failures clean staged outputs. No event arrays enter the workspace document and
no human provenance stamp is synthesized.

**Measured independent references:** a single-thread isolated Python environment
used NumPy 2.5.4, FlowIO 1.4.0 and FlowUtils 1.2.2. Eleven spectral records compare
F32-quantized inputs with float64 SVD/LAPACK least squares; seven acquisition records
capture actual synthetic FlowIO reads. Private/source pins were verified byte-identical.
Portable numeric records and an optional independent checker are committed under
`packages/compute/test/data`; standard CI does not require Python. The checker
reproduced all records and original synthetic FCS hashes. No vendor parity follows.

Separate reviews found no demonstrated kernel regressions. Accepted spectral
oracle cases had maximum observed abundance/residual errors about 1.40e-6/1.07e-6;
diagnostic matrices rejected. Accepted acquisition cases had maximum normalized
error 1.23e-7 against FlowIO, and nonlinear Time rejected. These are fixture-specific
Metal measurements, not universal f32 error bounds or spectral/WOLS equivalence.
## 2026-10-17 — Acquisition/OLS integration validation and expansion benchmark

**Measured:** composed-host review approved `acd7400`, including independent
257-event/1 KiB checks for reordered detectors, no-residual/full/derived-only/
original-only/mixed export, defensive ownership and cancellation. Local validation
passed 293 tests, lint/typecheck, host/UI builds and the compiled Node workflow.
Linux/llvmpipe run `38996665556` passed 250 tests with ten private-oracle skips.

The combined gain/time → 3-detector/2-fluor OLS → export workload processed 50M
events, expanding 20 input columns (4 GB) to 23 output columns (4.6 GB). Peak host
RSS was 436,346,880 bytes; import took 30.862 s and export 83.443 s. Source/build,
watchdog, sampled-error and measurement limitations are recorded in
`reference/spectral-acquisition-validation.md`. This confirms bounded host-memory
behavior for that workload, not exhaustive numerical/vendor parity or a relative
Rust advantage. Current stage readback/upload is included in the measurement.

## 2026-10-17 — Bounded replayable GPU exact-rank median summaries

**Decision:** `summarizeMedians` returns immutable JSON-friendly lower/upper median
rank endpoints, not an averaged median. Four replay passes (0..3) select two ranks
per target with radix-256 histograms and GPU prefix/rank updates. GPU integer
IEEE-754 monotone keys preserve every finite F32 value including subnormals;
signed zeros are canonicalized to positive zero. No CPU event filtering, sorting,
histogram selection or numerical fallback is used. CPU endpoint bit decoding is
not arithmetic. This explicit `gpu-radix256-exact-rank-v1` profile does not assert
native MedianExact double-arithmetic or complete vendor parity. The reported
private wave-3 evidence for positive-minus-negative medians motivates composition,
not a parity claim for this implementation.

**Ownership/limits:** callers provide immutable, source-hashed replayable inputs;
chunk boundaries may change. Total row/selected counts and impossible ranks catch
some replay mutations, not equal-count content changes. Borrowed chunks are never
mutated. Inputs have 1..4096 unique exact channel names, targets 1..128, ANDed
inclusive ranges <=16 with unique exact names and exact finite F32 bounds (null
means unbounded). Nonfinite filter values exclude rows; any selected nonfinite
target rejects. Empty selections have a typed error. Source counts are capped at
2^32-1 before GPU submission to prevent per-bin/count overflow.

Event `maxBinding` is separate from fixed scratch state: complete-row windows
respect that budget, 128 MiB, device buffer/binding and dispatch limits. Histograms
use at most 256 KiB, rank state 2 KiB, metadata 704 bytes, uniforms 32 bytes and
counts 12 bytes, independent of population size. Each window is drained before
its input buffer is destroyed or the iterator advances. Abort/source/dispatch
failures close active iteration and drain submitted work before owned cleanup.
Cancellation cannot interrupt an indefinitely pending caller iterator `next()`;
callers must also arrange cancellation of their source I/O.

**Verified locally:** synthetic CPU-sort test oracles cover odd/even ranks, signs,
ties, zeros, subnormals, finite extremes, inclusive multi-axis ranges, nonfinite
policies, offset views, replay chunk changes, multiple windows, immutable metadata,
limits, typed emptiness, source failures, cancellation and buffer cleanup. These
are mathematical/kernel tests, not vendor or large-file performance evidence.

**Measured validation:** own dependency installation 3.5 s; Node 24.18.0 / pnpm
11.16.0. Lint 2.000 s and declaration/typecheck 7.031 s ran in parallel; the full
suite then passed 306 tests in 23 files (including 13 median tests), command wall
42.604 s. Total checks 49.641 s; queue overhead <=0.003 s/job. Vitest reports
setup 0 s, transform 1.21 s, import 3.60 s and test execution 28.71 s. At most two
check jobs with 1536 MiB Node heaps and one test/GPU worker; declarations were
built once before workspace-importing tests. Local Dawn/Metal results only.

## 2026-10-17 — Explicit conventional control median-difference GPU primitive

**Decision:** `estimateControlMatrix(k, channels, controls, maxBinding, options?)`
implements `conventional-median-difference-primary-f32-v1`, not AutoSpill,
spectral estimation, inferred gates, spread QC or native FlowJo parity. The private
wave-3 static report was **verified/read**: it supports positive-minus-negative
MedianExact and a primary normalization branch, but does not establish complete
public field mapping, even-count interpolation or numerical equivalence. This
primitive therefore defines its own explicit mathematical midpoint convention.

Require 1..128 unique nonempty exact detector names, exactly one control per
detector (arbitrary input control order), and independent positive/negative median
endpoint vectors in detector order. Counts are positive u32 integers, odd counts
require repeated endpoints, and lower must be <= upper. CPU work only validates
and snapshots metadata, packs normal-f32-or-zero endpoints, maps names and copies
readback. One standalone WGSL dispatch computes paired endpoint differences:
`delta_j = ((positive.lower_j-negative.lower_j) +
(positive.upper_j-negative.upper_j))/2`, then `S_ij = delta_j/delta_i`.
Subtracting endpoints first avoids prematurely rounding two large-baseline medians.
Result is row-major, rows/columns both in requested detector order. Negative and
above-unity coefficients are retained without max/max-absolute normalization or
clipping. Defaults are `minEvents=1`, `minPrimarySeparation=0`; both populations
must meet support, and primary separation must be strictly above the nonnegative
f32 threshold. This is not a universal biological QC policy. Parent callers must
run `prepareCompensation` for rank/conditioning before publishing a usable matrix.

**Numerical policy:** finite normal f32 or zero inputs; reject unsafe intermediate
differences/sums and coefficients above a conservative magnitude ceiling of 2^126,
nonzero subnormal intermediates/results, and overflow risk. Tiny differences are
checked after exact power-of-two scaling to prevent GPU flush-to-zero hiding them.
This intentionally can reject a mathematically representable final answer; no CPU
fallback or automatic rescaling substitutes a different profile. The GPU returns
per-control status, primary separation, invalid-coefficient count and negative
valid-coefficient count. Unavailable separation is `null` with explicit status;
unattempted coefficient counts are `null`, not fabricated zero/valid metrics.
`ControlEstimationError` (`CONTROL_ESTIMATION_REJECTED`) carries the same recursively
frozen JSON diagnostics as success. No partial matrix is returned on rejection.

**Ownership/limits:** inputs are copied before the first await; result owns its
Float32Array, while result envelope, channel list and diagnostics are frozen.
All temporary and staging buffers are destroyed on success or failure. Each buffer
fits min(caller limit, device storage binding/buffer limits, 128 MiB). The bounded
endpoint matrix is 16*N*N bytes (256 KiB maximum), quality is 24*N bytes and the
remaining buffers are smaller. Metadata must fit one binding; this setup budget
is not an event streaming budget. Dispatch count also obeys the device limit.

**Measured locally:** 22 targeted Dawn/Metal tests pass, covering asymmetric
2/3/17-detector independent mathematical references, shared negatives, reordered
controls, odd/even independent counts, negative and above-unity coefficients,
support/separation thresholds, large common baselines, tiny/huge f32 values,
underflow/overflow rejection, immutable metadata, 128 detectors, lowered device
limits and cleanup on success, numerical, pipeline, upload and readback failures.
No native numerical fixtures or remote llvmpipe results are claimed.

**Measured required validation:** Node 24.18.0 / pnpm 11.16.0, isolated dependency
setup 4.372 s. Final lint and declaration/typecheck ran independently in parallel
(1.569 / 2.820 s), then all 315 tests in 23 files passed with one Vitest worker
(36.098 s command wall time). Tests wait for declarations because workspace imports
consume their output. Final batch elapsed 38.921 s; runnable-job queue delays were
0.002 / 0.002 / <0.001 s. Vitest reports setup 0 s, transform 1.15 s, import 3.36 s
and assertions 24.14 s. At most two check jobs, 1536 MiB heaps, one native thread
and one GPU suite at a time in that final batch. An earlier invocation mistakenly
placed flags after an extra `--` and ran suites concurrently; it also caught a
test fixture wrongly expecting rejection at the exactly permitted coefficient
ceiling. The fixture and invocation were corrected, not the acceptance policy.
Full final logs/timings are in the session's approved temporary directory under
`control-estimator-validation-ses_eb8240337ffeYisU6UJT6khk5w`.

## 2026-10-17 — Agent jobs for explicit control-derived compensation

**Decision:** compose the reviewed GPU rank and median-difference primitives in
`start_control_estimation`. Bind separate immutable positive/negative sources,
exact selections, source-specific acquisition settings and application context.
Require caller support policy, retain signed coefficients, and run existing GPU
compensation conditioning before publication. This profile estimates conventional
square matrices, not spectral references, automatic gates or AutoSpill.

The host caps detectors at 32 and recipes at 64 KiB for bounded protocol evidence;
shared population definitions reuse summaries. Four replay passes report event
visits. Sources retain pinned descriptors with verified content hashes; only the
current population reader is retained. Metadata compatibility compares reported
instrument/serial/voltage fields, records missing values and does not claim
biological validity. Linearized selections operate in explicit acquisition space
without changing raw-space workspace gate definitions. Subnormal endpoints remain
valid median ranks but receive an explicit estimator-policy rejection.

Matrix JSON and receipts publish atomically; failed/cancelled runs keep diagnostics
without registering a partial matrix. Session-local registrations include recipe
lineage, and downstream export receipts link the estimation receipt. Persisted
artifacts survive restart, but callers must explicitly register their matrix/context
again. No human provenance stamps or event arrays enter workspace documents.

**Verified:** primitive and host reviews passed. Host review fixes reject temporal
detector roles and unrepresentable thresholds before work, and bound publication
to MCP's 256 KiB evidence budget. Oversized failures explicitly omit endpoint/
candidate details when necessary while retaining recipe/error/progress. Two real
MCP boundary fixtures exercise both retained and compacted failure evidence.

**Measured local validation:** 341 tests in 25 files passed, including 13 composed
control-job tests. Lint/typecheck ran concurrently (1.261/1.261 s); full tests and
the dependent UI build ran concurrently (42.470/3.485 s), followed by compiled
Node/RPC smoke (1.943 s). Total batch 45.677 s; runnable queue delay <0.001 s each.
Vitest reports transform 1.04 s, setup 0 s, import 3.32 s and assertions 30.64 s.
At most two jobs with 1536 MiB heaps and one GPU test worker/native thread were
used. The isolated dependency setup (3.3 s) and host build preceded this batch;
the immutable host build was reused by smoke. Logs/timings are under the session's
approved temporary directory at `control-final-validation`. Remote final-head CI
remains required before merge; no large-file control-estimation benchmark or
native numerical parity is claimed.

## 2026-10-17 — Streamed raw-coordinate population count jobs

**Decision:** the next bounded agent capability is
`start_gate_counts`, taking immutable sample identity, an explicit `stored-f32`
coordinate space, an optional event window and a rectangle/polygon/Boolean gate
recipe. It computes counts through GPU gates in bounded windows and exposes both
parent and selected-root denominators. CPU aggregation is restricted to exact
integer GPU window counts and derived scalar frequency ratios; event membership
remains GPU-only. Zero denominators yield null frequencies.

This job evaluates a recipe without mutating the workspace document. Display
transforms, inferred gates and implicit acquisition/compensation are excluded from
this contract. A previously processed FCS artifact may be imported explicitly and
counted in its stored coordinate space. Gate definitions and input hashes are
snapshotted in the receipt; named kernel semantics do not establish vendor parity.

Reuse the host's bounded queue, cancellation and atomic artifact/receipt publication.
Recipes are capped at 64 KiB, 128 gates and 256 vertices per polygon; protocol
evidence must fit MCP's 256 KiB budget before publication. Implementation and
independent validation must establish effective chunk/mask memory bounds before
delivery. The runner conservatively sizes chunks for decoded/encoded rows, copied
columns, every retained mask and temporary polygon masks within 128 MiB.

Geometry requires exact normal-or-zero F32 coordinates. Null rectangle bounds
become exact finite F32 extrema, rather than the legacy kernel's narrower fallback
sentinels. Polygon vertices are bounded by 2^30 and nonhorizontal |dy| by a minimum
2^-30; GPU bounding-box prefiltering bounds event coordinates before crossing
arithmetic. F32 rounding and permitted subnormal flushing remain explicit. Geometric
gates exclude nonfinite inputs; NOT may include them within its parent domain.
No display-space parity measurement is transferred to this raw-space profile.

**Source review verified:** raw coordinate conversion, bounded polygon arithmetic,
parent/Boolean dependency ordering, denominator semantics, chunk/mask accounting,
cleanup, cancellation and durable publication passed independent review.

**Measured/verified validation:** 360 tests in 28 files passed, including nineteen
new protocol, numerical and durability cases. Fixtures verify multi-chunk totals,
shuffled parent/Boolean DAGs, zero denominators, exact F32 extrema, nonfinite/NOT
behavior, bounded polygon coordinates, malformed recipe admission, cancellation,
MCP/restart recovery and publication surviving terminal-record persistence failure.
Host/UI builds and compiled RPC smoke passed. The latter reuses the unchanged
host artifact; no new computational runtime dependency was added.

Final checks ran at most two jobs with 1536 MiB heaps, one GPU test worker and one
native thread. Lint/typecheck ran concurrently (3.166/3.281 s), then the full suite
(64.327 s command wall); final batch elapsed 67.619 s, runnable queue delay ≤0.006 s.
Vitest reports transform 1.71 s, setup 0 s, import 5.69 s and tests 45.82 s. Isolated
dependency setup took 3.9 s before this batch. Logs/timings are retained under the
approved temporary directory's `gate-count-final-validation`. These are validation
costs, not a large-file throughput benchmark or native/vendor parity measurement.
Final-head Linux/llvmpipe CI remains required before merge.

## 2026-10-17 — Measured gate-count scalability, no runtime change

**Measured:** the delivered `5f66295b` count job processed synthetic 64-MiB and
1-GiB DATA payloads through 128 gate definitions (16 repeated eight-gate families).
Every result count, denominator and frequency matched independently derived
analytic expectations. Admission-to-terminal-observation times were 16.637 and
136.425 s; process lifetime OS peak RSS was 203,640,832 and 263,962,624 bytes.

The 16× input increase and 1.296× observed RSS increase support this bounded
streaming baseline, not constant-memory proof, isolated GPU timing, typical-panel
performance, vendor parity or a relative Rust advantage. Runs used a fresh service
process sequentially on the same Metal adapter; OS/driver caches were not cleared.
An independent watchdog enforced progress/wall/RSS limits and cleaned owned files.
Initial benchmark heap-guard failure was retained and corrected before measurement.

**Verified:** independent review reconstructed all 128 expected rows per run and
cross-checked runner/build hashes and persisted evidence. The committed developer
runner is `packages/host/bench/gate-counts.mjs`; full methodology, measured phases,
source identities and reproduction are in `reference/gate-count-scalability.md`.
No computational runtime or agent API changes accompany this checkpoint.

**Validation:** lint, typecheck, benchmark syntax and all 360 tests passed. Final
batch elapsed 57.428 s: lint/typecheck ran concurrently (1.800/1.546 s), syntax
used the next free slot (0.234 s after 1.550 s queue), and the full suite took
55.625 s. Vitest reported setup 0 s, transform 1.46 s, import 4.98 s and tests
40.43 s. At most two 1536-MiB jobs, one GPU test worker and one native thread;
existing isolated dependencies and the unchanged host build were reused. Timings
are retained under the approved temporary directory's `gate-count-benchmark-validation`.

## 2026-10-17 — One recipe, bounded per-sample count tables

**Decision:** `start_batch_gate_counts` reuses the delivered
raw stored-F32 count engine across 1–32 distinct immutable samples, with a shared
gate recipe and per-sample event windows. The sample/gate Cartesian table is capped
at 512 rows and the recipe at 64 KiB. All metadata/ranges resolve before admission;
sources execute sequentially under one GPU lease and one bounded job slot.

Results preserve each sample's counts and parent/root denominators. Rows reference
sample/gate indices in the shared recipe; labels are descriptive only. There are
no pooled biological statistics or implied unit normalization/comparability.
Recipes and source bindings are snapshotted before execution. Durable admission
records store compact source bindings rather than duplicating the complete gate
recipe per sample. This keeps valid large shared recipes within the record budget.

Single and batch counts share atomic artifact/receipt publication and lifecycle
code. Any source failure or cancellation discards partial table results; diagnostics
retain failing source and completed-sample count. Receipt/artifact size is checked
against the MCP budget before publication. No compute-kernel change or workspace
mutation accompanies this operation.

**Review corrections:** admission now preserves cancellation rather than converting
AbortError to a transport-generic internal error. Annotated sample failures retain
backend error codes/messages/details, including later-source ENOENT; GPU loss
reclassification nests the original cause. Focused error and maximum-table tests
pass, including a large shared recipe whose expanded per-sample copies would exceed
the durable record budget.

**Parser correction:** those fixtures demonstrated that a valid Buffer-backed
`FcsByteSource` could read the wrong header prefix: Buffer.slice returns a view,
unlike Uint8Array.slice. `openFcs` now copies the validated 58-byte header view
before reading its backing buffer. A deterministic prefixed-Buffer regression
verifies header and multi-chunk data decoding. Independent review approved the
narrow correction; all 56 FCS stream tests pass.

**Separate E2E fixture diagnosis:** a preliminary combined run passed 368 tests but
the eight new E2E cases could not enter their suite: two fixture imports passed raw
row arrays to the file writer, omitting the FCS encoder. A standalone Node check
wrote `[[3,3,400],[4,4,400]]` as hex `030390040490`, not an FCS header. Both missing
encoder calls were restored; all eight cases and the real importer contract were
retained. This malformed-fixture failure is distinct from the valid Buffer-view
parser defect above. No second product fix was needed for the E2E fixture.

**Final local validation:** all 376 tests in 31 files pass, including 15 batch cases
and the new parser regression. Lint/typecheck ran concurrently (1.999/1.767 s),
then the combined suite (69.359 s command wall); final batch elapsed 71.360 s with
runnable queue delay <0.001 s. Vitest reports transform 1.34 s, setup 0 s, import
5.48 s and tests 52.96 s. At most two 1536-MiB check jobs, one GPU test worker and
one native thread were used. Existing isolated dependencies and final host/UI
builds plus compiled RPC smoke were reused. Full logs/timings are retained under
the approved temporary directory's `batch-count-final-validation`. Final-head
Linux/llvmpipe CI remains required before delivery.

## 2026-10-18 — Exact rank summaries for one explicit population

**Decision:** add `start_population_medians` for one
stored-F32 gate population, or an explicit root/null selection, with up to 32 named
targets. Reuse the exact four-pass GPU radix primitive; report its two central
rank endpoints and indices rather than silently choosing midpoint arithmetic.
Empty support and selected nonfinite targets reject explicitly. Subnormal target
ordering and positive-zero canonicalization retain the primitive's existing policy.

The compute iterator now accepts either plain F32 rows or `{data, mask}` with one
borrowed Uint32 membership value per row. Nonzero membership is ANDed with existing
range filters on GPU. A seventh shader binding uses bounded per-window mask upload;
unmasked callers use a four-byte dummy. Existing control-estimation calls remain
plain-chunk compatible. Each mask window adds four bytes per row; this is a
per-binding limit, not an aggregate-memory claim for arbitrary callers.

The host factors existing chunk gate evaluation without changing geometric or
Boolean semantics. Optional mask readback is copied before all owned gate buffers
are destroyed. The median runner budgets reader-transition overlap, the larger
gate/median phase, mask copies and 1 MiB fixed-state headroom within its explicit
128-MiB working-buffer budget. This is not a process-RSS or driver-memory promise.
One source descriptor stays pinned through all passes; hashes bind the recipe,
metadata, range and gate definition. Support from every gate replay is checked
against the median result before atomic publication.

The entire supplied recipe is validated before pruning the execution plan to the
selected population's parent/Boolean dependency closure. Reverse topological
traversal retains all transitive prerequisites while avoiding unrelated dispatches
on each of four passes. The original recipe remains in provenance. The 128-gate
resource fixture uses a complete ancestor chain so this optimization does not
reduce its exercised allocation/dispatch scope.

**Verified:** independent compute and host source reviews passed. The
compute reviewer independently passed 35 focused tests (22 masked and 13 existing
median cases), including offset views, mixed chunk types, replay, nonfinite policy
and cleanup. Dependency-pruning review also passed. Compiled RPC smoke verifies
gated even-count endpoints and four-pass progress.

An initial targeted E2E run exposed oracle/receipt-contract errors, adjudicated
independently from fixture rows. S1 NOT support has 24 APC values of −1 and 12 of
4, so both central ranks are −1; S2's NaN-PE row is excluded by the finite parent,
leaving support three and median −1. The root receipt correctly reports 384
event-visits, not an eventCount field. That failed assertion caused the later
restart test to lack its job ID. Expectations were corrected in one evidence-backed
cycle, retaining all eleven cases; no product numerical change was needed.

**Final measured validation:** 417 tests in 34 files passed. Lint/typecheck ran
concurrently (4.528/4.666 s), followed by independent host build/full tests
(1.675/83.227 s), then compiled RPC smoke (2.831 s). Final batch elapsed 90.729 s;
runnable queue delay <0.001 s. Vitest reports transform 1.48 s, setup 0 s, import
6.79 s and tests 64.79 s. Existing isolated dependencies and the unchanged UI build
were reused. There were at most two check jobs, one GPU test worker, 1536-MiB V8
old spaces and 16-MiB semi-spaces. GPU tests/smoke were serialized on the shared
adapter. A process-group supervisor enforced 180-s command and 90-s output-stall
deadlines and a combined observed process-tree RSS ceiling of 4 GiB; no limit
terminated a command. Sampled peak combined RSS was 855,519,232 bytes. These are
validation-worker measurements, not a population-median throughput benchmark.
Logs/timings are under the approved temporary directory's
`population-medians-final-validation`. Final-head Linux/llvmpipe CI precedes merge.

## 2026-10-18 — Bounded batch median-rank tables

**Decision:** reuse the reviewed one-population median
runner sequentially across 1–32 distinct immutable sample identities. A common
stored-F32 population, gate recipe and target-channel list bind per-source windows;
the sample/channel table is limited to 512 rows and the request to 64 KiB.
Counts, central ranks, diagnostics and source recipe hashes stay per sample;
endpoint rows carry only sample/channel indices and lower/upper values.

All metadata binds before admission. The batch hash includes source metadata,
range and execution-plan hashes. Compact durable bindings avoid serializing the
full gate recipe repeatedly. Publication reuses the shared population executor,
with median artifacts and event-visit progress for both single and batch ranks.
No new compute kernel, pooled statistic, midpoint convention or workspace edit
is introduced. Any empty/nonfinite source, source integrity failure or cancellation
rejects the whole table; completed source rows are not published as partial success.

**Verified:** independent source review passed. All 15 focused host tests
pass, including reordered physical channels, explicit windows, both 512-row shapes,
a 47,898-byte shared recipe whose expanded bindings exceed 1 MiB, bounded MCP
retrieval/restart, immutable admission, later-source empty/nonfinite/removal/
corruption, second-source replay cancellation and recovery after terminal-record
write failure following successful publication.

**Final measured validation:** all 432 tests in 37 files passed. Lint/typecheck ran
concurrently (2.384/1.450 s), followed by independent host build/full tests
(1.175/68.448 s), then compiled RPC smoke (2.331 s). Final batch elapsed 73.169 s;
runnable queue delay <0.001 s. Vitest reports transform 0.957 s, setup 0 s, import
4.89 s and tests 54.96 s. Existing isolated dependencies were reused, and the final
host artifact was built once and reused for smoke. This host-only change did not
repeat the unchanged UI build. At most two check jobs used 1536-MiB old spaces,
16-MiB semi-spaces and one GPU test worker. GPU suites/smoke were serialized on the
shared adapter. The process-group supervisor enforced 180-s command and 90-s
output-stall deadlines and a 4-GiB observed combined process-tree RSS ceiling;
sampled peak was 825,651,200 bytes and no limit terminated a command. Its owned
temporary fixture tree was removed after process cleanup. These are validation
measurements, not a cohort throughput benchmark. Logs/timings are retained under
the approved temporary directory's `batch-medians-final-validation`. Final-head
Linux/llvmpipe CI remains required before merge.

## 2026-10-18 — Median-path scalability evidence, no runtime change

**Measured:** the delivered `440fa09` median runner processed 64-MiB and 1-GiB
synthetic DATA inputs, selecting a triangle whose dependency closure contains two
gates from 128 validated definitions. Four target columns have independently
derived central rank endpoints; both scale runs and both 16-MiB root/triangle
smokes matched all endpoints, support, rank indices and four-pass event-visits.

The 1-GiB case visited 67,108,864 source rows four times and selected 33,587,200
rows. Its central ranks 16,793,599/600 produced distinct Index endpoints
307249/307250. Admission-through-observation took 30.581 s and lifetime process
peak RSS was 408,379,392 bytes, versus 2.824 s and 246,710,272 bytes at 64 MiB.
The 16× input increase accompanied a 1.655× observed RSS increase. These are
single-device observations with uncontrolled caches, not constant-memory proof,
GPU-only timings, physical I/O bandwidth, native parity or cohort throughput.

**Verified:** independent source/record/prose review reconstructed expected
per-column ranks, artifact/receipt hashes, build/shader fingerprints and progress
records. All supervised runs exited 0 without watchdog termination, and their
owned data directories were removed. The committed runner is
`packages/host/bench/population-medians.mjs`; methodology, limits, identities and
reproduction are in `reference/population-median-scalability.md`. Rank indices
refer to each channel's sorted values, not original event positions.

**Final validation:** lint, typecheck and all 432 tests in 37 files passed. The
runner's syntax and both smoke/scale profiles were verified separately; unchanged
runtime build artifacts and isolated dependencies were reused. Lint/typecheck ran
concurrently (2.336/1.335 s), then the full suite (75.710 s command wall); final
batch elapsed 78.052 s with queue delay <0.001 s. Vitest reports transform 1.06 s,
setup 0 s, import 6.12 s and tests 59.18 s. Two bounded check slots, one GPU worker,
1536-MiB old spaces and 16-MiB semi-spaces were used under 180-s command/90-s stall
deadlines and a 4-GiB observed process-tree RSS ceiling. No limit terminated work;
sampled combined peak was 858,075,136 bytes. The owned fixture tree was removed
after process cleanup. Logs/timings are in the approved temporary directory's
`population-median-benchmark-validation`. These are validation costs, separate
from the benchmark measurements. Final-head Linux CI remains required for merge.

## 2026-10-18 — Read-only workspace snapshot binding

**Decision:** bridge model-v1 workspace JSON to existing
one-sample count and median-rank jobs. Inspection returns bounded sample/gate/channel
pages. Jobs require both the expected revision and raw document-byte SHA-256;
revision alone cannot detect same-revision manual edits. The 1-MiB document is
read from a confined regular descriptor, decoded as strict UTF-8, validated by
the model package, and checked for stability before closing.

Choose admitted-snapshot semantics: capture the verified recipe at admission;
later workspace edits neither change nor cancel the numerical work. The document
is not reread during execution. Existing imported FCS artifacts are addressed only
by the declared sample hash and checked byte size, never by opening the basename.
Used channel IDs map to exact FCS names; gate identity, dependency structure and
geometry are preserved. No display transform, rounding, provenance-stamp write,
model transaction, implicit FCS import or numerical-policy change is introduced.

Workspace request and compiled numerical arguments remain separate in receipts,
with document/sample binding, inner analysis hash and composite workspace recipe
hash. Inspection's declared finalization flags describe source gates, not approval
of numerical results. Existing backend limits may reject broader model-valid
definitions. Cap requests at 64 KiB, bindings at 32 KiB and pages/receipts at 256 KiB;
inspection reduces page length rather than truncating identifiers.

**Verified:** independent source review and typecheck passed. Compiled RPC
smoke resolves model IDs, counts a stamped gate, computes raw-space endpoints on
a display-transformed channel, checks lineage, and confirms unchanged document
bytes. All 17 workspace boundary/E2E/lifecycle cases pass.

**Boundary evidence:** five focused tests passed, including an 811,547-byte model
whose complete long identifiers require byte-budget pagination, pre-read size and
encoding/schema rejection, path confinement, and a 33,071-byte request whose used
channel binding alone exceeds 32 KiB. A deterministic abort-plus-mutation test
initially returned INPUT_CHANGED because cleanup replaced the abort. Cleanup now
attempts descriptor closure before prioritizing cancellation; non-cancelled
unstable reads still reject. The original regression assertion remains and passes.

The first final-check batch stopped on `noUnsafeFinally` rather than running the
full suite. Cleanup was restructured to capture its outcome and decide error
precedence after stability/closure attempts; no lint rule was disabled. Independent
review approved the explicit flow and all boundary cases passed again. One E2E
size-mismatch assertion had also requested counts for a gateless sample; using a
valid root-median request isolated the intended size check without changing the
fixture's invalid size or dropping coverage.

**Final measured validation:** all 449 tests in 40 files passed. Lint/typecheck ran
concurrently (2.311/1.329 s), then independent host build/full tests (1.129/76.713 s),
followed by compiled RPC smoke (2.573 s). Total batch elapsed 81.601 s; runnable
queue delay <0.001 s. Vitest reports transform 1.01 s, setup 0 s, import 5.55 s and
tests 62.06 s. Existing isolated dependencies were reused; the final host build was
reused for smoke and the unchanged UI was excluded. Two check slots, one GPU worker,
1536-MiB old spaces and 16-MiB semi-spaces ran under 180-s command/90-s stall
deadlines and a 4-GiB observed process-tree RSS ceiling. No limit terminated work;
sampled combined peak was 1,068,470,272 bytes, and owned temporary fixtures were
removed after cleanup. Logs are under the approved temporary directory's
`workspace-analysis-final-validation-v2`; the failed lint batch remains separately
under `workspace-analysis-final-validation`. Final-head Linux CI precedes merge.

## 2026-10-18 — Close local-studio delivery with served-version acceptance

**Decision:** the applicable documented delivery surface is the repository-built
Node 24 local studio, with MCP/RPC and optional UI assets. The repository has CI
but no configured cloud or registry release target. `docs/DELIVERY.md` records
post-merge artifact/endpoint acceptance, scoped operator-instance upgrades and
rollback. An owned synthetic acceptance process is not reported as a persistent
operator deployment.

The compiled acceptance script now consumes capabilities over both RPC and MCP,
checks their build fingerprints agree, and exercises workspace inspection and a
real workspace count job over MCP alongside the numerical RPC workflow. Successful output records
the actual served fingerprint, API version, Node version and endpoint paths;
successful exit/cleanup is also required. No scientific runtime behavior changes.

**Rollback retained:** accepted source `977141c937f644d87938f83784305ed717b1ecea`,
build `8263d1456e234aa660f421174981638ba1b4db6c5b6b81a1cff70ea0b68a8b6f`,
with a private bundle archive and manifest under this session's research delivery
directory. The manifest includes archive/bundle/lockfile hashes; no experiment
data or tokens were included. Final validation and merged-revision acceptance
will be recorded with delivery evidence.

**Validation evidence:** an initial full run passed 448 tests but timed out on an
existing generic deep comparison of a 1-MiB Buffer. Replacing that assertion with
native `Buffer.equals` retains exact byte/length coverage without raising its
timeout; the targeted case completed in 62 ms. The failure log is retained.
Independent review approved the assertion change and the final cross-transport
checks. The combined rerun passed all 449 tests, lint/typecheck and real compiled
RPC/MCP acceptance. The served fingerprint was
`8263d1456e234aa660f421174981638ba1b4db6c5b6b81a1cff70ea0b68a8b6f`.

Final pre-merge validation elapsed 117.767 s: concurrent lint/typecheck
4.188/2.078 s, full tests 109.933 s, then served acceptance 3.640 s. Queue delay
was <0.001 s. Vitest reported transform 1.55 s, setup 0 s, import 9.03 s and tests
86.60 s. Two check slots, one GPU test worker, 1536-MiB old spaces and 16-MiB
semi-spaces were supervised with 180-s command/90-s stall deadlines and a 4-GiB
observed RSS ceiling; no limit terminated work. Sampled combined RSS peaked at
812,756,992 bytes. Owned temporary fixtures were removed. Logs are retained under
`local-delivery-final-validation-v2` in the approved temporary directory; the
earlier timeout remains under `local-delivery-final-validation`. Runtime bundles
were unchanged and reused for this acceptance. Final-head CI and post-merge
served-source verification close delivery.

## 2026-10-18 — Read-only workspace group discovery

**Decision (implemented; delivery validation pending):** extend the existing workspace inspector
with group summaries and ordered member pages. This closes the metadata discovery
gap between saved model groups and explicit sample selection for existing analysis
jobs. Preserve declared membership order and distinct logical IDs, including shared
file hashes; no pooling, import, numerical work or document mutation is implied.

Reuse the document-byte/revision guards, model validation, 1-MiB input bound and
256-KiB dynamic response pagination. Existing view shapes remain unchanged; group
selectors are explicit and incompatible filters reject. During the higher-priority
AI Tokens/Chi co-drive, this slice uses one bounded CPU worker and metadata-only
checks. Required broader validation and served-version acceptance remain delivery
gates; completed PR #12 checks are not being rerun merely for reconciliation.

**Verified CPU scope:** seven tests pass for ordered/overlapping/empty groups,
distinct logical IDs sharing a file hash, strict filters, stale guards, model
reference validation, long-ID byte pagination, unchanged sources/catalog and real
MCP inspection. A mandatory device-acquisition spy asserts zero calls. Independent
source review passed. Lint passed; typecheck caught an optional `groupId` assignment,
corrected by using the already-validated group's ID. Typecheck and the focused file
then passed (1.33 s Vitest, including 373 ms tests, 433 ms transform, 769 ms import,
0 ms setup). Checks used one worker, 768-MiB old space, 16-MiB semi-spaces and
`nice +10`; no GPU/full-suite/build or external-orchestrator work was launched.
The full required checks, commit/PR and post-merge acceptance remain outstanding.

**2026-10-19 final local validation:** resumed the unfinished delivery handoff under
the chief's continuation direction. All 456 tests in 41 files passed, with no
coverage removed. Lint 2.280 s, typecheck 1.073 s, host build 1.259 s, full suite
77.999 s and served RPC/MCP acceptance 2.775 s ran sequentially in one `nice +10`
slot to preserve priority resources. Total elapsed 85.390 s; intentional runner
queue wait was zero. Vitest reports transform 1.11 s, setup 0 s, import 6.37 s and
tests 61.62 s. Node old space was 1024 MiB with 16-MiB semi-spaces; native/runner
concurrency was bounded. A process-group supervisor enforced 180-s command,
90-s stall and 2-GiB observed RSS limits; peak was 843,685,888 bytes and no limit
terminated work. Owned temporary fixtures were removed. Logs/timings are retained
under the approved temporary directory's `workspace-groups-final-validation`.
The served candidate fingerprint was
`ed1171bde21b5029e93888f3a34c35a010080d128896cc1062083c785bbaa660`.
Final-head CI and merged-revision acceptance still gate delivery; no benchmark or
external-orchestrator work was started.

## 2026-10-19 — Explicit nearest-F32 compiled workspace recipes

**Decision (authorized, implemented; delivery checks pending):** only workspace
count and median operations accept `nearest-f32-compiled-v1` as an explicit opt-in.
Omission and `strict-f32-v1` retain strict admission. Compilation creates a new,
potentially lossy recipe; it never retries rejected input automatically. Source
workspace bytes/provenance remain unchanged. Geometry, signed deltas, profile,
original/compiled canonical recipe hashes and maximum displacement are recorded
in a capped report bound into the workspace receipt. Events, inclusive rectangle
definitions, strict-ray polygon rules, parents and Boolean references are retained.

Reject nonfinite/overflow, nonzero-to-zero underflow, unsupported compiled
subnormals, existing geometry-limit violations and detected conversion-induced
collapse. Structural checks cover zero spans, lost distinct polygon vertices and
new collinearity using exact dyadic metadata arithmetic. Signed area alone cannot
prove collapse (a bowtie can have zero signed area and nonempty membership).
General topology preservation, GPU-vs-JS equivalence and vendor parity remain
**unverified**, explicitly not promised. Existing kernels are reused.

**Measured decision-support evidence:** the retained CPU study took approximately
13 minutes with 132 MiB peak RSS. Nine of 14 evaluated synthetic cases changed
membership (15 candidates, overflow not evaluated); inclusive ties, thin-polygon
collapse and parent/Boolean denominator changes are intentional regression cases
for the new semantics. In one existing sample, 768/134426 events in three fixed
windows showed no change across 33 gates, despite maximum coordinate displacement
0.003764 raw units. This 0.5713% nonrandom subset is not an equivalence or no-effect
proof. Private study receipt: `flow-atlas-f32-decision-study/assessment.json`.
No new dataset, expanded coordinate-comparison study, benchmark or external host
is required. Existing oracle tests remain part of the repository-required suite;
their results do not establish equivalence for this new profile.

**Measured implementation validation:** 18 compiler regressions passed within the
474-test required suite (42 files, 80.66 s wall; Vitest setup 0 s, transform 1.23 s,
import 6.68 s, execution 64.15 s; maximum process RSS 555,003,904 bytes). Seven
additional focused GPU/runtime cases passed, retaining changed parent/child/NOT
counts, polygon ties, exact median endpoints, rejection, source immutability and
MCP/restart receipt lineage (481 local tests total). Lint/typecheck and host build
passed. Compiled MCP submission/RPC observation accepted the explicit lossy count
and median profile. Checks used bounded low-priority local workers; no benchmark
or external host. Independent numerical/source review found no outstanding issues.
Final-head CI and merged-source served acceptance are recorded with delivery.

## 2026-10-20 — Explicit single-sample WSP structural materialization

**Decision:** expose `materialize_wsp_sample` as a bounded synchronous metadata
operation, not a numerical import/conversion or an assertion of FlowJo semantics.
The caller supplies source raw-byte SHA-256 (content revision), root format version,
selected WSP sample, already-imported FCS hash/size/metadata hash and explicit
`preserve-xml-as-raw-v1`. Existing import/inspection summaries expose metadataHash.
No basename lookup, implicit FCS import, event read for computation, automatic F32
compilation, source edit, or human-finalization stamp is added. Source population
counts are reported metadata only. Attribution is in receipt/provenance, preserving
the model's existing nonzero edit-revision rule; the new model is revision zero.

**Verified source:** the existing WSP reader can silently omit missing Gate nodes,
default malformed present rectangle bounds, and infer NOT for unknown Boolean
children. The new boundary therefore performs selected-sample structural preflight
before the actual reader and compares the resulting complete gate projection.
Nested ancestry must agree with explicit parents; refs are exact selected-sample
gate IDs. Unknown/ambiguous constructs and explicit transformation/compensation
references reject. Unsupported transforms can be preserved as bounded declarations
using the already-existing TransformSpec type; model validation now permits that
representation without making it evaluable. No package dependency was added; host
uses the existing workspace WSP source/project reference, bundled by the host build.

**Decision:** add opt-in strict bounded parsing to the existing XML parser, keeping
legacy defaults unchanged. Public materialization requires fatal UTF-8, an 8-MiB
pre-read cap, XML character/entity/structure checks, no DTD/external resolution,
duplicate/prototype attribute rejection, depth 128, 100,000 elements, and bounded
attributes. This local-name structural vocabulary is not full namespace or vendor
semantic validation. Both raw source bytes and unknown root metadata remain in the
source artifact. Selected unsupported constructs reject instead of being repaired.

**Ownership/bounds:** one materialization per service; a new UUID output contains
the <=1-MiB model, exact <=8-MiB source, <=256-KiB provenance and receipt. Groups
and other samples are explicitly omitted from the model, not silently flattened.
Channel mapping is complete, exact-name unique and order-independent; source counts
must agree at sample level. Full source IDs/counts/relationships and index maps are
retained in provenance. Owned staging is removed on error/cancellation, followed
by atomic-directory publication on success, using the existing host filesystem
threat boundary. No general protection against hostile same-user filesystem races
or equivalence to FlowJo interpretation is claimed.

**Validation boundary:** CPU-only synthetic FCS import and MCP materialization/
inspection tests, explicit zero acquireDevice calls, strict XML regressions and
scoped typechecks are the implementation evidence. Compiled acceptance, independent
review and the repository's full validation/delivery remain parent-owned holds.

**Measured implementation checkpoint:** scoped WSP/model/host typechecks and
Biome passed. The selected CPU suites passed 47 cases (9 public materialization,
5 strict XML, 33 existing model cases); every host case asserts acquireDevice was
never called. An initial channel-conflict fixture was internally inconsistent and
was corrected to reach the intended mapping check. The output-budget test's initial
5-second timeout was raised explicitly for its large synthetic metadata fixture;
no case or rejection assertion was dropped. Independent review and compiled/full
validation have not been performed by this implementation session.

**Independent review checkpoint:** found a strict XML attribute whitespace issue:
literal tabs/newlines must normalize before entity decoding, whereas character
references retain their explicit character values. The correction and channel-name
binding regression leave legacy parsing and saved source bytes unchanged. No
other numerical, mapping, publication or provenance defect was demonstrated.
The parent's initial required suite exceeded its 120-second command deadline
after host tests passed; that partial run is retained and is not claimed as full
validation. A single bounded final-source rerun supplies the completion evidence.

**Final local evidence:** the first supervised final-source suite completed but
failed on an unexpected worker exit in the unchanged numerical-oracle file.
An independent diagnostic review found a time-correlated Node SIGSEGV in Dawn
InstanceBase::ProcessEvents; absent worker-PID linkage, the precise attribution
and root cause remain unproved. The unchanged 18-case file passed in isolation.
On that new evidence, one complete PID-traced run passed **497 tests in 45 files**
without changing assertions, selection, fixtures or worker count. Earlier failure
logs remain retained; this is not a claim to have fixed a native lifecycle bug.

The successful suite took 111.871 s total (0.008 s launcher setup; Vitest transform
1.89 s, setup 0 s, import 10.17 s, tests 85.67 s); sampled process-group peak RSS
was 825,827,328 bytes. Lint/typecheck passed in parallel bounded CPU slots. Final
build and compiled materialization acceptance passed, served fingerprint
`bf7c1a8a02d243e0ef1349038b162627bb7a9216f8a276f8f7434928f1308f4f`.
Checks used nice+10, one test worker, bounded native threads, 180-second command /
90-second no-output deadlines and a 2-GiB sampled process-group ceiling. No limit
terminated the successful run. Source review is closed; final-head CI and
merged-source acceptance remain separately recorded delivery gates.

## 2026-10-25 — Phase-one archive and review-context execution

**Decision (user-authorized direction):** retain Verification and Discovery as
complementary participation modes, with archived-data phase one preparing for
live scientific workflows in phase two. Open participation and evaluated
task-specific capability do not depend on institutional credentials. The initial
implementation sequence is recorded in `phase-one-plan.md`; it does not launch
public reputation, financial infrastructure or instrument control.

**Verified source audit at b16aa5a:** the host has content-bound inputs, revisioned
model snapshots, explicit numerical profiles and receipts. Its browser prototype
instead imports and computes independently, including display-space gating; it is
not a viewer of host results. Public gate summaries omit full geometry and
dependencies. Connect one real archived case to bounded read-only context before
building scientific review plots; do not treat the existing embedding display as
verification of a host receipt or assume nonlinear polygon transforms preserve
membership. No particular real-data numerical disagreement was measured by this audit.

**Literature evidence and limits:** primary studies motivate explicit verification
costs, retained disagreement and evaluation against both solo baselines; they do
not validate a universal mobile review interface or reputation algorithm. Adaptive
reuse, correlated agent errors and circular confirmation remain evaluation design
concerns. Stop general literature iteration now and reopen only for a named
implementation blocker or observed pilot failure. CytoWeave, the Burns/Samusik
experiment and Robin/Finch are existing agentic-cytometry evaluation comparators;
the project makes no first-benchmark claim. Source links are in the phase-one plan.

**Measured acquisition checkpoint:** a bounded public batch acquired 13 read-only
files totaling 48,974,768 bytes, with zero failures and matching published size/MD5
checks plus recorded local SHA-256. The corpus remains outside Git and is not an
ingested benchmark. Raw workspace, gate-archive and FCS availability does not
establish semantic compatibility, reference-label independence or numerical fidelity.
Cloud storage is an eligible user-selected destination, not a provisioned service.
Per-run storage budgets and private account/project bindings remain outside shared
runtime policy. No data or compute is silently moved to an unrelated cloud project.

**Measured first intake, not materializer acceptance:** one public ICS screen-1
FCS imported and inspected through the accepted compiled MCP host, with matching
content hash, 768,163 bytes, 12,731 events and 15 channels. A corrected metadata
probe completed in 0.85 s at approximately 133 MiB peak RSS; its earlier invalid
keyword-limit/response-parsing failure is retained as a harness failure.
No materialization or numerical job ran. Independent review identified ALS WSP
sample 84 as a candidate, not a verified binding: archive filename, `$FIL` and
WSP basename differ; another workspace shares the basename; one channel differs
by underscore/slash; selected WSP counts are not yet retained. Source inspection
predicts unsupported selected constructs, but no API rejection was observed.
The exact-name rule was a conservative probe hypothesis, not user policy. Next
work is an explicit candidate-binding/alias and structural-compatibility check,
without silently normalizing names or broadening coordinate interpretation.

**Validation scope for this plan:** documentation only; runtime sources, lockfile,
tests and accepted bundles are unchanged from b16aa5a. Reuse the recorded runtime
validation for that exact code, and run documentation lint/diff checks. The prior
497-test local and 454-pass/10-private-oracle-skip CI evidence does not establish
compatibility of the newly acquired case or validate the proposed human workflow.

## 2026-10-25 — Priority public demo for expert feedback

**Decision (explicit user deployment authority):** publish the current browser
prototype at `flow.gszep.com` using the existing Sites Cloud Run / Cloud DNS path.
This supersedes the earlier absence of a public deployment target for the browser
only. It does not publish the local MCP/RPC studio or private experiment storage.
Phase-one feature work is deferred behind this presentation task.

The demo generates 3,072 synthetic events in the browser and runs the existing
WebGPU pipeline with a small 8-by-8 SOM and five epochs. Working browser controls,
separate delivered host capabilities and planned collective Verification/Discovery
are visibly distinguished. User-selected files stay local; no acquired datasets,
private oracle files, upload endpoint or bearer tokens enter the static package.
No FlowJo/biological fidelity or human-verification effectiveness is inferred.

**Verified source and measured checks:** independent review closed two static
delivery defects (dotfile 404 handling and a test-fixture directory setup error).
Thirteen scoped Node server/staging tests and one CPU synthetic-fixture test pass;
lint, typecheck and UI build pass. Existing Chrome CDP visual QA exercised real
WebGPU loading, repeated loading, colour/legend/size controls, an invalid-file
error and recovery, and a 390-pixel responsive layout. No page errors, upload
requests or production oracle fetches were observed. Original backend/kernels
are unchanged, so unrelated local GPU suites are not rerun for this UI/static slice;
the repository CI retains its normal broader validation.

`PUBLIC_DEMO.md` specifies the public packaging boundary, dedicated build/runtime
identities, scale-to-zero/max-one-instance bounds, clean-source artifact staging,
release/asset hash checks and rollback. Served custom-domain HTTPS acceptance is
separate from source review, CI, Cloud Run readiness and DNS record creation.

## 2026-10-25 — Publication data becomes the primary public demo

**Authority:** the user explicitly requested the full dataset from the FlowAtlas
publication instead of the synthetic example. This supersedes the prior static
demo's exclusion of these exact companion WSP/FCS files only; it does not authorize
publishing unrelated acquired corpora, experiments or credentials. The original
`FlowAtlas.jl` files remain unchanged and outside Git.

**Measured metadata:** the local companion copy contains 33 FCS files with a total
of 3,885,530 declared events; FCS bytes total 290,739,412 and the workspace is
5,102,255 bytes. The largest FCS is 28,883,628 bytes. The paper describes 32 files;
the UI and manifest must disclose the actual companion version/count rather than
silently omit a file or assert exact reproduction of the published figures.

**Bounded implementation:** pin exact dataset file hashes/sizes in a metadata-only
manifest. Stage only those files through an explicit publication-source option;
ordinary static staging continues to reject arbitrary WSP/FCS/private directories.
Stream large responses within the existing 256-MiB Cloud Run service. Browser
loading verifies files with bounded download concurrency and progress. No event
subsample is substituted for the full requested dataset. Codebook training limits
are disclosed separately from projecting/rendering all loaded events. Scientific
host kernels/defaults and the existing explicit coordinate contracts are unchanged.

The user also authorized showing this demo on Artemis, superseding the earlier
no-contact hold for that specific task only. The first SSH attempt timed out and
Tailscale reported that peer offline; no remote process or workload was changed.
Public-site work proceeds independently while the host is unreachable.

**Measured full-dataset preview:** once Artemis became reachable, an isolated,
user-supervised FlowAtlas static service served the exact publication package on
localhost. Existing Chrome/WebGPU loaded all 3,885,530 events and 33 samples in
19.6 s before phase instrumentation. No unrelated remote workload was changed.

The instrumented serial comparison on an NVIDIA RTX 5000 Ada Generation Laptop
GPU (16,376 MiB reported capacity, driver 595.99.02) used the same 20-by-20 SOM,
ten epochs, seed 42 and 20 features. Limited training reported 0.600 s training /
15.188 s total; all-event training reported 18.236 s training / 28.849 s total.
These are one run per mode, shared-GPU, cache-influenced browser wall-clock phases,
not isolated GPU timings, a quality comparison or a general hardware benchmark.
All-event mode has training stride one; initialization mean/SD still use stride
19 over 204,501 rows. Both pass all events to projection and the renderer; filters
and viewport affect visibility. Peak memory and utilization were not instrumented.

**Independent publication review:** fixed client-disconnect handling that could
raise a second-header error, per-server allowlist isolation, and a staging race
that could copy bytes different from the pinned manifest. Tiny regressions were
independently reproduced and then verified closed. All 34 current source payload
hashes/sizes were independently checked with zero mismatches. Initial placeholder
hash entries created during drafting were discarded before staging; only hashes
computed from actual source bytes are retained. Original source data are untouched.

**Scientific direction clarified by the user:** prioritize spectral flow, including
instrument-aware panel design from biological intent and experimental verification.
The current conventional-flow demo is a baseline, not spectral validation. The
34-parameter panel paper's MS example and its raw-data acquisition are separate
work; neither this dataset nor this embedding substitutes for those samples.

## 2026-10-26 — Minimal automatic quick-view demo

**User-authorized change:** remove the explanatory sidebar, automatic companion
loading with a centered byte-progress indicator, and a 100,000-event sample for
quick EmbedSOM. This supersedes the prior all-event public-view default, not the
underlying full source or the host's numerical contracts. The full companion is
still downloaded and hash-verified; deterministic global midpoint row selection
occurs before GPU allocation, transformations, gating, training and projection.
Selection spans concatenated WSP sample order, preserves full row/channel alignment,
and retains original counts/offsets separately. Displayed counts are sampled counts.

**Measured:** 29 scoped CPU UI tests, UI build, lint/typecheck and independent
source review passed. A Calcifer browser check covered automatic loading, an
injected initial HTTP503 and successful retry, centered determinate progress,
100,000 projected/renderer-input rows from 3,885,530 source rows, controls and
mobile layout. The successful local run took 10.637 s wall time. No Artemis GPU
work was used. Unchanged dataset/server/kernel components are reused; normal CI
and served-version checks remain required for delivery.

## 2026-10-26 — Train on a subset, project all, persist the browser result

**User clarification supersedes the prior quick-view sample:** the 100,000-event
limit applies only to SOM training. All 3,885,530 companion events must remain in
gating, projection and rendering. Keep the minimal automatic UI and add native
IndexedDB caching for verified raw files and the computed map. A result key binds
source/profile/engine identity; incomplete, mismatched or corrupt entries are cache
misses. Browser storage is best-effort, scoped to the origin and independent of
the host's immutable artifacts or human verification authority.

**Measured failure and correction:** on Calcifer's Intel GPU, the original large
projection produced zero sampled output coordinates despite finite varied inputs
and codebook values. A 256-row run with the same inputs/codebook produced valid
coordinates. Smaller dispatches in one large command buffer did not resolve the
failure. GPU-only chunk copies, bounded 65,536-row projection batches, explicit
queue draining and invocation-owned allocation cleanup did. No events are removed;
the pointwise WGSL arithmetic is unchanged. This establishes an operational
correction, not a uniquely identified driver fault. A first-chunk comparison with
a tiny projection and the aggregate copy guards that path; invalid bounds reject
before a ready map or cache is published.

An interrupted acceptance run had no retained completion receipt after a harness
restart. Source changes survived; temporary staging and earlier detailed diagnostic
files did not. Historical failed checks remain described here, not misreported as
preserved raw logs. Recovery resumed the remaining browser acceptance on Chrome
155.0.8059.86, with no Artemis GPU work. The source cache survived: zero FCS/WSP
requests were made. Full computation took 61.252 s wall time (excluding subsequent
cache persistence), and a new-tab computed-map restore took 2.048 s with zero
SOM/projection work and zero FCS/WSP requests. Both supplied all 3,885,530 events
to the renderer. These are local feasibility observations, not a universal latency
guarantee or numerical/biological parity claim.
