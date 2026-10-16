# FlowJo 11: shipped-artifact investigation

Initial static pass, 2026-10-17. Target: `/Applications/FlowJo 11.app`, version
**11.2.0**, build **11.2.0.210157**. Tool: **rea-agents 6.5.0**, Node 24.18.0.
Repository baseline: `38aff03`. This is a partial investigation, not a recovered
implementation or a claim of numerical compatibility with FlowJo 10.

## Evidence and scope

REA analyzed `Contents/Resources/app.asar` and inspected the native engine's
Mach-O structure. Additional observations came from the installed plist, direct
JSON-schema reads, ASAR header/member reads, and `nm -gU | c++filt`. No target
code was executed. Names and declarations establish available research targets,
not that a feature executes successfully or uses a particular algorithm.

Complete local evidence is retained outside the repository at
`~/Documents/flowjo-research/ses_eba830f19ffej2PuqaC4zed9va/`:

| File | Evidence / SHA-256 |
|---|---|
| `rea-asar-observed.json` | REA `ev_1637dc2cc5cbc3acfa30ed455a0bad18c1ade0f1a7207ffcd7fdddfe31514ad4` |
| Same file, 66,686,143 bytes | `ff5fd1caf8a5cdfcdeeb24cc3426e3ca17014a2567293f5b4193834bc8283d04` |
| `rea-native-engine.json` | REA `ev_ff4b26f9397e232a9c117ba42b1dc85ec34b547189cbd953597f34831433ddb9` |
| Same file, 2,140,803 bytes | `72953614ff236b11f3c9a7c1e8ed0103c845b48d7f17395d9ffcba3368dc9584` |
| `native-symbols.txt` | `fd8fab82e8fe015e1840fa40367a3a73cfd8091a0c4e113b2b65ab809e4b7e72` |
| `native-demangled.txt` | `c2a1e84f4c34d5cef815b2337e7706bf73bc1ebfd9b675e0bea514538f34950a` |
| `providers.json` | Provider readiness snapshot; not live connectivity proof |
| `rea-asar.json` | Original strict-integrity failure, retained before continuing |

The ASAR itself hashes to
`bfe669f8a5c92636fdebb290fc1211071ff8695a82e72932f232b70131dfa99d`.
The native engine hashes to
`ba973647a4369f020e80fa23dc078ea116003c6127ef97f08cc16366388f8ab4`.
The plist's Electron ASAR integrity value is a separate declaration; it must not
be substituted for the whole-file hash.

**Integrity qualification:** strict REA analysis failed because unpacked native
bytes contradicted ASAR-declared digests. The explicitly selected
`record-and-continue` policy retained **14 contradictions**, including the native
engine, seven service executables, three dependency dylibs, and three addons.
REA labels these bytes `observed-untrusted`. Signing or stripping after packaging
is a possible explanation, not a verified cause. No vendor signature validation
was performed. All native observations below refer to these observed bytes.

## 1. Application structure — observed

- The ASAR header inventories 40 file entries. Its `package.json` identifies
  `flowjo-11` 11.2.0 and `out/main/index.js` as the entrypoint.
- Main and preload JS entrypoints load a bytecode loader and their respective
  `index.jsc`. Main/preload behavior was **not** recovered from those bytecode files.
- Renderer bundles include `app-DBZZopws.js`, `client-DKV9XZlj.js`,
  `flowjo-components-7yAteHFY.js`, and `splash-usogi9EY.js`.
- Unpacked services: `analysis-service.exe`, `engine-socket.exe`, `export-service.exe`,
  `fonts-service.exe`, `graphics-service.exe`, `migration-service.exe`, `proxy.exe`.
  Despite the suffix, `file` identifies all seven as **x86_64 Mach-O executables**.
- `libNativeEngine.dylib` is x86_64 Mach-O, with 15,268 externally defined symbols
  according to its `LC_DYSYMTAB`. This is a symbol count, not a function count.
  Its load metadata declares macOS 14.5; the app plist declares a 12.0 minimum.
  Runtime compatibility across those versions was not tested.
- Addons: `lmdb-reader.node`, `copy-clipboard.node`, `image-stitcher.node`.
  LMDB use is a candidate inference from the addon name, not a recovered disk format.

REA read 20 relevant files / 4,483,405 text bytes, parsed eight JS files, visited
212,361 AST nodes, and reported 418 findings and one parse failure. Its summary
recovered zero Electron IPC operations, bridges, windows, or native-addon
bindings. These zeros are **coverage gaps**, not proof those features are absent.
Three inline HTML script bodies were not analyzed. Inspect the retained graph's
coverage/unknowns before using individual edges.

## 2. Request protocol — declarations observed, transport unresolved

Six JSON files under `app.asar.unpacked/out/main/JSONSchemas` describe a request
envelope with `type`, `request`, and `engine`. Request members include `requestId`,
`intent`, `calculation`, and `payload`. Families:

| Family | Intent count | Useful declared operations |
|---|---:|---|
| analysis | 54 | Workspace load/save; sample/group edits; gates; transforms; compensation; graphs; statistics; undo; v10 import/export |
| platform | 10 | Add/update/remove/execute; QC plots; compensation-wizard gates; tables; gate instantiation |
| plugin | 4 | Add, execute, update, remove |
| auth | 1 | `helloEngine` with engine configuration |

Platform/plugin calculation modes are `on_write`, `on_read`, `by_request`, and
`background`. This suggests a useful separation of mutation and scheduling for
agent tooling; scheduling behavior is not yet observed.

Schema gaps matter: the analysis enum contains `engineBuildDetails`,
`getAnalysisList`, `getTransformVector`, and `updateImageWallSettings` without
same-named definitions in that file. A definition for the last exists in
`platformRequests.json`, outside that file's platform intent enum. Do not generate
a supposedly complete client from the intent list alone. Message framing,
socket selection, response schemas, startup handshake, error behavior, cancellation,
and concurrency guarantees remain unresolved.

### Renderer-facing GraphQL layer — static source observations

A further inert read of `out/renderer/assets/app-DBZZopws.js` reveals a distinct
renderer-facing interface above the native request schemas. Its observed SHA-256
is `3b94f081a7f5f244bb890ad41f390d44b65251d71079228a597455ef4fbf44e7`.
The local evidence directory retains this bundle, the other three renderer JS
bundles, schema snapshots, and `renderer-operation-candidates.json`.

Scanning named query/mutation/subscription declarations yields **155 unique
candidate operations: 68 queries, 86 mutations, one subscription**. This is a
literal-source inventory, not GraphQL schema introspection or proof of server
support. The candidate JSON records Python string character offsets (not byte
offsets). Focused source reads established:

| Character offset | Observation |
|---|---|
| `504023` | `window.api.getApiAddress()` supplies an HTTPS address; a client is configured with `/api` |
| `518179` | The same bridge supplies WSS; subscriptions are configured against `/api` |
| `226872` | `ON_CALCULATION_COMPLETE` selects analysis ID and node IDs |
| `255089` | `GET_ENGINE_INFO` selects version, build time and commit hash |
| `263291` | `GET_POPULATION_GATE` selects gate identity, axes and type |
| `263561` | `GET_POPULATION_HISTORY` selects graph/display history; this is not proven edit provenance |
| `299079` | `CREATE_BOOLEAN_GATE` selects affected nodes and population identity/name/count |
| `299278` | `CREATE_GATE` selects gate/population references, affected and evicted entries |
| `676628` | A graphics-cache helper constructs a localhost HTTPS URL from a bridge-provided port |

Other declared operations include WSP import/export, workbench load/save,
FlowSOM/UMAP/t-SNE/XShift creation, gate update/promotion, cluster merging,
compensation, recalculation, undo/redo, tables, reports, and image sets.
`SAVE_POPULATION_HISTORY` is declared as a **query** selecting `graph`, despite
its name: operation labels must not be treated as authoritative side-effect
classifications.

Renderer calls also reference `window.api` menu, dialogs, clipboard, filesystem,
navigation, and image-stitching methods. This explains why REA's zero recovered
bridge count must not be treated as an absent bridge. The preload implementation,
actual host/port values, server resolver behavior, and mapping between GraphQL
operations and native intents remain unresolved. No endpoint was contacted.

## 3. Workspace and computation model — declarations observed

Source anchors are JSON pointers in `primitives.json`:

- `/definitions/workbench`: schema version `3.0.0`; keyed collections for analysis
  roots, groups, data sources, population definitions, populations, compound
  populations, parameter-set definitions, compound parameter sets, platforms,
  plugins, reports, and cytometers. A saved `.flowjo` file's physical encoding is
  not established by this schema.
- `/definitions/cacheableProperties`: UUID; distinct definition/results/recalculation
  versions; deferred state; typed arrays of parent/child references. This declares
  a graph rather than a single-parent-only tree. It does not prove acyclicity.
- Objects repeatedly separate `definition` and `results`. Population results include
  count, string-valued statistics, valid/invalid population counts, status, and gate
  adjustment information.
- `/definitions/platform_Definition`: recalculation preferences for platform changes,
  recalculated inputs, changed annotations, and added/removed samples. Values include
  `recalculate`, `ignore`, `inject`, and `n/a`.
- `/definitions/engine`: block-read size, thread/query limits, RAM/disk budgets, cache
  path and lifecycle options, and gate-memory ratio. Actual units/defaults require
  implementation or runtime evidence.

**Implication for Flow Atlas (proposal):** explicit dependencies, per-node validity,
stale-result reporting, and bounded compute requests are promising agent-facing
concepts. Preserve the existing document/cache separation and human-finalization
rules; FlowJo's schema does not supersede them.

## 4. Gating and transforms — highest-priority parity work

`primitives.json#/definitions/gateDefinition` declares rectangle, range, bisector,
polygon, ellipse, quad, spiderQuad, curlyQuad, and eventSet. Fields include
`eventsInside`, `magnetic`, axis specs, separate vertex arrays, rotation,
dependents, and `gateResolution` with a declared default of 256.
`populationDefinition_Definition` additionally declares `and`, `or`, `not`, and
`root`. Ellipses use two x/two y vertices plus rotation; their equivalence to the
repository's covariance-form ellipsoid representation is unresolved.

`parameterAxis` can carry a transform. `transform` declares linear, log, biex,
fasinh, fatanh, hyperlog, logicle, capitalization variants, and ArcTanh/ArcSinh
spellings. It includes T/A/M/W, range, shift/negate, auto-width, vector length,
and transform-vector fields. The schema requires A/M/W for biex; this does not
establish the mapping to v10 `width`/`neg`/`pos` or their units.

Important analysis request payload definitions:

| Pointer in `analysisRequests.json#/definitions/` | Declared surface | Next measurement |
|---|---|---|
| `getTransforms` | `includeVectors`, `vectorLength`, population/parameter selection | Exact LUT values, endpoints, interpolation and out-of-range behavior |
| `transformVertices` | `range_to_raw` / `raw_to_range`, axis transforms, vertices, axis ranges | Round trips, near-zero resolution, edge vertices |
| `setTransforms` | Global/cytometer/comp_matrix/platform/sample targets, optional secondary target | Precedence and scope inheritance |
| `getGraph` | Population selection, plots, vectors, gates, back-gating, histogram scaling | Bin boundaries and graph-versus-event semantics |
| `eventData` | Offset/limit, axes, histogram-bin/event-ID selection | Stable event identity and bounded extraction |

The documented v10 discrepancy in `docs/decisions.md` makes LUT and polygon-edge
semantics a particularly valuable first experiment. **The schemas do not prove
the discrepancy's cause.** FlowJo 11 results must not silently become a v10 oracle.

### Concrete native entrypoints

Observed `nm` addresses in the identified dylib, before any runtime ASLR slide;
these are symbol virtual addresses, not asserted file offsets:

| Address | Symbol | Investigation |
|---|---|---|
| `0x25378c0` | `FastTransform::make_fast` | LUT construction |
| `0x2537ff0` | `FastTransform::fast_find_index` | Lookup/interpolation boundaries |
| `0x2461ad0` | `FJ::Transform::RetransformVertices` | Gate coordinate conversion |
| `0x1d4b810` | `GParameter::DetermineTransformationAutoWidth` | Auto-width semantics |
| `0x0ec0280` | `EllipseGate::ContainsPoint` | Boundary inclusion / ellipse geometry |
| `0x04ef920` | `CompositeGateSpec::CalculateCurlyQuadVertices` | Composite gate construction |
| `0x22be8b0` | `Compensator::GetCoefficientsWithCorrectionApplied` | Matrix correction |
| `0x22e5860` | `FlowSample::ApplyCompensation` | Compensation application |
| `0x07e5200` | `V10Transform::FromXML` | v10-to-v11 parameter conversion |
| `0x07e8cd0` | `V10Workspace::FromXML` | Workspace migration |

Names/signatures were recovered; function bodies and call relationships were not.

## 5. Compensation, statistics, and analysis platforms

Declarations in `primitives.json`:

- `spilloverAlgorithm`: traditional/autospill. `compensationAlgorithm`: ols/wls/wols.
  `compSpec`: separate parameter and detector arrays, coefficients, correction
  inverse, CSM coefficients, weights, and a spectral flag. Matrix orientation,
  solver details, conditioning, and rounding remain unknown.
- `statisticDefinition`: count/frequencies, mean/median/mode/percentile, geometric
  mean, SD/CV and robust variants, MAD, correlation. Multiple names explicitly
  distinguish Channel, NoHisto, and Exact forms. An agent API should specify the
  estimator and coordinate space rather than promise a generic “FlowJo median”.
- `flowSOM_Definition`: grid dimensions, iterations, cluster count, distance metric,
  and sampling. `umap_Definition`: neighbor/min-distance/component/epoch settings;
  Manhattan, Euclidean, Chebyshev, and cosine metrics.
- `tSNE_Definition`: early exaggeration, momenta, perplexity, learning rate, optSNE,
  initialization; VPTREE/DESCENT/ANNOY/INPLACE neighbor choices and
  BARNES_HUT/FFT_INTERPOLATION gradients.
- `samplingSpec`: none/initial/shuffle/uniform, size, random-shuffle-seed flag.
  No reproducibility guarantee follows from these field names alone.
- Other declared platforms: xshift, event-quality filtering, population comparison,
  statistical modeling, compensation and spillover matrices.

## 6. Repository gaps verified at the baseline

- `packages/transforms/src/index.ts` supports only linear/log/biex and rejects
  non-256 biex table lengths. The full native parameter mapping is unresolved.
- `packages/wsp/src/index.ts` keeps raw geometry, but unsupported transforms are
  replaced with a linear spec. That substitution needs explicit unsupported-state
  handling before claiming wider format compatibility.
- `packages/compute/src/gating.ts` transforms polygon vertices and evaluates
  transformed columns. Its comment claims this is exactly FlowJo behavior;
  the current static evidence cannot establish that claim. It also creates a
  tension with the repository's display-only-transform policy. Resolve using
  measured edge cases before changing the policy or implementation.
- The compute gate adapter handles polygon/rectangle only; the wider model's
  ellipsoid/quadrant/Boolean variants are not evaluated by that adapter.

## 7. Remaining investigation checklist

| Question | Status | Next evidence needed |
|---|---|---|
| Exact installed artifact and package layout | Answered for this install | Rehash after updates |
| Request vocabulary and declared data model | Partially answered; native schemas and renderer GraphQL inventoried | Missing payloads, server types/resolvers, transport traces |
| Native numerical implementations | Partial: 20 focused functions decompiled; whole-program REA passes timed out | Validate signatures, callers and numerical outputs |
| Main/preload IPC and service orchestration | Unresolved | Bytecode-aware analysis or bounded runtime capture |
| `.flowjo` physical storage and migration fidelity | Unresolved | Synthetic saved workbench + import/export round trip |
| Transforms / gate boundary parity | Unresolved | Native code and synthetic input/output vectors |
| Compensation and statistics equivalence | Unresolved | Numerical probes for each declared mode |
| Platform defaults, RNG and determinism | Unresolved | Implementations and repeated seeded runs |
| UX, report generation, plugin lifecycle | Partially mapped by names only | Focused renderer traces and runtime scenarios |

REA's provider discovery found Ghidra unconfigured, Hopper's executable missing,
and IDA unconfigured. No native decompilation was attempted. The next enabling
step is to configure an available engine or approve a scoped installation plan.
Do not report this initial inventory as exhaustive reverse engineering.

### Artemis continuation

The initial provider limitation above applies to Calcifer. On 2026-10-17, the
user identified the existing REA installation used by the Age of Empires project
on Artemis and authorized transferring the selected binaries and results.
The `artemis` SSH alias connects successfully. REA 6.5.0's scoped Ghidra doctor
passes with the existing Ghidra **12.1.4** installation and **Java 21** selected.
These bindings are process-local; no shared agent configuration was changed.

The transferred `libNativeEngine.dylib` has the same SHA-256 on both hosts.
Remote work is isolated under
`~/Documents/flowjo-research/ses_eba830f19ffej2PuqaC4zed9va/`.
The `flowjo-rea-eba830f19ffe` user service supervises one REA MCP session, limited
to four CPU equivalents, 12 GiB memory, 256 tasks, and 40 minutes total runtime.
Requests against one Ghidra Program are sequential because the provider serializes
them; the imported image is reused. Each response is retained separately, followed
by an evidence export and explicit close. No FlowJo code is executed on Artemis.

The launched pass targets LUT construction/lookup, vertex conversion, auto-width,
ellipse containment, curly-quadrant construction, compensation correction/application,
v10 transform parsing, and transform-settings application. Successful startup is
not evidence of successful decompilation; outcomes are recorded below.

**First run outcome:** default Ghidra analysis timed out at 1,200 seconds before
returning the first function. The supervised service took 1,203.949 seconds,
consumed 3,824.606 CPU seconds, and peaked at 2.8 GiB. Export and close both
succeeded; the exported bundle contains no successful function evidence. The
failure includes import diagnostics and the switch analyzer's restart message.
These records have been copied back to Calcifer under `artemis-pass1/` in the
local evidence directory. There is no successful default-profile decompilation.

A separate second pass selects `Decompiler Parameter ID` and
`Decompiler Switch Analysis` in `REA_GHIDRA_DISABLED_ANALYZERS`. This explicitly
reduces whole-program parameter and switch recovery; targeted decompilation
remains requested. Results must retain that profile and cannot be represented as
default full-analysis output. This pass also adds the biex generator/inverse,
scale/index helpers, and logicle initialization/solver to the target list.

**Second run outcome:** the reduced REA profile also timed out before returning
a function (1,203.847 seconds service runtime; 2,779.530 CPU seconds). Diagnostics
show broad demangling/type processing, but do not establish which analyzer alone
caused the delay. Export and close succeeded. `artemis-pass2/` contains the
returned records. No algorithm conclusion relies on these failed passes.

**Focused fallback succeeded:** using the existing Ghidra 12.1.4 headless tool
directly with `-noanalysis`, a local research script disassembled and decompiled
the 20 selected entry addresses with a 45-second per-function deadline. All 20
reported successful decompilation. Total supervised runtime was **37.736 seconds**,
CPU time **74.026 seconds**; summed per-function disassembly/decompilation took
**14.707 seconds**. The remaining wall time includes import, JVM/script startup,
and teardown; those stages were not individually instrumented. Service-reported
peak memory accounting was inconsistent across attempts and is not used as a
measurement of this fallback's actual peak RSS.

The returned files are in `artemis-focused/` on Calcifer. Remote/local SHA-256
comparison verified **41 files** (20 pseudocode files, 20 per-function records,
one completion record). `manifest.json` records output hashes, the analysis
profile and timing; `remote-receipt.txt` confirms inactive/dead service state,
no remaining service control group, and source-side hashes. The ephemeral project
directory has no remaining files. Original binaries and the existing AoE analysis
were not changed.

These are **direct Ghidra research outputs**, not canonical REA Evidence records.
The fallback reused Ghidra after REA's whole-program readiness barrier failed; it
did not make either REA run successful. No function prototypes were overridden.
Output contains incomplete types, unnamed callees, unrecognized external function
arguments and other decompiler artifacts. Successful decompilation means a body
was produced, not that the pseudocode compiles or exactly reconstructs the source.
The bounded result does not establish complete callers, switch recovery, external
library behavior, or application reachability.

Focused output corroborates the assembly observations below about zero-index
truncation, LUT sizing and ellipse boundary inclusion. `index-to-scale-double.c`
also shows interpolation between adjacent entries with special handling at the
upper table boundary; its valid input domain and usage remain to be established.
Numerical parity still requires separately identified runtime measurements.

### Local assembly cross-checks while remote analysis runs

Calcifer's Xcode `llvm-objdump` disassembled eight exact mangled symbols from the
same fingerprinted dylib. Outputs and their hashes are in `local-assembly/manifest.json`;
constant bytes were mapped through the Mach-O segment table and recorded in
`local-assembly/constants.json`. These are direct static instruction observations,
independent of whether the remote decompiler completes. No target code was run.

1. **Zero-index rounding differs from the current TS algorithm.** In
   `Biex::invert`, `0x2469789` uses `cvttpd2dq` (truncate toward zero) on the
   calculated zero-channel coordinate; `0x2469799` limits it to half the range;
   `0x246979d` converts with `cvttsd2si`; subsequent instructions enforce a
   nonnegative value. The current `biexTable` uses nearest-even rounding instead.
   Constants and surrounding arithmetic support the same candidate coordinate
   formula, but the input-field mapping still needs corroboration.
2. **A real oracle parameter combination straddles the integer boundary.** Reading
   only the existing workspace's transform metadata, width `-79.4328234724`,
   negative decades `0`, positive decades `3.8`, and range `4096` produce a
   coordinate of approximately `1023.9999999999171` in a Python arithmetic probe.
   Truncation yields `1023`; the current nearest-even rule yields `1024`.
   `local-assembly/zero-index-comparison.json` records all five observed
   width/negative/positive/range combinations. This is **not** a native execution
   result, and does not prove that v10 input translation preserves these exact
   doubles or that the difference explains the recorded gate-count errors.
3. **Biex LUT construction is resolution-dependent.**
   `CreateBiexTransformation` computes a power-of-two size capped at 4096,
   allocates room for that size plus one doubles, and calls `Biex::invert` on
   successive integer coordinates. This interpretation applies to ordinary
   positive resolution inputs greater than one; invalid-input behavior is not
   established. Flow Atlas's `length: 256` metadata is not its output array
   length: its default `channelRange: 4096` produces 4097 points.
4. **Fast lookup is an index operation, not interpolation itself.**
   `fast_find_index` returns a signed short-derived integer, includes strict
   below/above-range branches, uses a precomputed index structure, and performs
   a final table comparison/decrement. Caller analysis is needed to establish
   fractional interpolation and endpoint policy; its name alone cannot justify
   replacing the current binary search.
5. **The ellipse membership comparison includes equality.**
   `EllipseGate::ContainsPoint` rotates translated coordinates, computes a sum
   of squared normalized coordinates, and compares against the literal double
   `1.0` with `setae` at `0xec032f`. For finite, valid geometry, equality is
   included. The unordered comparison path rejects a NaN sum. Construction of
   the stored center, rotation and radii remains a separate question.

These findings motivate differential probes, not an immediate change to the
existing Julia-parity implementation or a claim of v10/v11 algorithm identity.

### Independent biex corroboration and runtime-probe boundary

A separate research worker cross-checked inversion/table-construction assembly,
ABI registers, the 48-byte temporary object layout, and additional constant bytes.
Its local `biex-probes/REPORT.md` and hashed `manifest.json` retain the reasoning,
probe source, inputs, diagnostics, and numerical candidate results.

Additional static differences confirmed:

- The native safeguarded solver **multiplies** its bracket terms and selects
  bisection for product **greater than or equal to zero**; the existing TS code
  subtracts the terms and checks `> 0`.
- The native initial step magnitude is unrounded; TS rounds it first.
- Finite log-width values outside `[0.5, 3]` reset to `0.5` (not an upper clamp
  to 3). The existing TS routine has no equivalent reset.
- The native function retains `log(exp(...))` round trips and a capped below-zero
  reflection. Both implementations share an unusual initial solver residual;
  replacing that expression with the later residual is not justified by this evidence.

**No native Biex numerical outputs were obtained.** A restricted subprocess
terminated with SIGABRT before its first stage message. A self-test that never
loads the vendor library also aborted under the sandbox, while the direct
self-test returned its expected status. This establishes a restricted-launch
blocker, not a proven ABI or library-dependency failure. No unrestricted vendor
load was attempted. The dylib has thousands of initializer entries, so loading it
cannot be described as executing only the requested scalar mathematical function.

Original Python candidate calculations and read-only calls to the actual TS
implementation covered 28 parameter cases. Finite sampled legacy-model values
agreed with TS within `5.82e-11`; this is not native parity. For the width/positive
decades combination discussed above, the workspace's actual max range
`82897.211494718` produces a **candidate-versus-legacy** maximum raw-table
difference of about `39.6864441577`. The ratio is extremely close to an integer,
so even the native zero index remains unmeasured. Channel range 4096 is an
explicit probe assumption for the v10 workspace, not an unstated XML attribute.

Preserve the current oracle profile. A future explicitly versioned native-v11
profile needs native output fixtures and separate checks for parameter translation,
scalar math, LUT construction, index/interpolation behavior, and application-level
gating. The implementation wave in `docs/agent-first-roadmap.md` does not change
biex numerical behavior.

### Differential probes to run after native recovery

These are planned experiments, not measured results or new implementation rules.

| Boundary | Cases | Comparison |
|---|---|---|
| Transform parameter translation | Existing per-channel widths/positive decades/max ranges; explicit negative decades | v10 XML → native transform spec → generated LUT |
| LUT lookup | Exact knots, immediately adjacent representable inputs, midpoints, duplicate knots, values beyond both endpoints | Native lookup versus TS interpolation versus f32 WGSL |
| Zero region | Signed zero and dense probes around the zero crossing | Separate table-construction error from lookup error |
| Resolution | Requested vector length, channel range, gate resolution | Establish which settings affect each computation; do not equate them by name |
| Polygon membership | Edge/vertex points, nearly collinear edges, reversed winding, negative values | Event masks, not only population counts |
| Precision | Double LUT/vertices versus uploaded f32 LUT/events | Identify whether mismatches first appear during upload or evaluation |
| Transform scope | Same sample/channel with global, cytometer, matrix, platform and sample settings | Effective transform and invalidation behavior |

Existing `packages/transforms/test/biex.test.ts` verifies the Julia fixture and
flat interpolation; it does not establish native FlowJo equivalence. Existing
`packages/compute/test/parity-gating.test.ts` checks exact Julia sample counts and
tolerant FlowJo population counts. Neither establishes event-mask identity with
FlowJo. Preserve the current oracle while adding separately identified native
measurements in a future implementation task.

## Reproduce the REA observations

Choose a new output directory; preserve the original strict failure alongside any
explicit continuation. These commands read installed artifacts without launching
FlowJo. `npx` downloads the pinned tool if it is not cached.

```sh
APP='/Applications/FlowJo 11.app'
OUT="$HOME/Documents/flowjo-research/new-pass"
mkdir -p "$OUT"
npx -y rea-agents@6.5.0 analyze-javascript-application \
  "$APP/Contents/Resources/app.asar" --json > "$OUT/rea-asar-strict.json"
# If reviewing a known integrity failure, explicitly retain observed-untrusted bytes:
npx -y rea-agents@6.5.0 analyze-javascript-application \
  "$APP/Contents/Resources/app.asar" --integrity-policy record-and-continue \
  --json > "$OUT/rea-asar-observed.json"
npx -y rea-agents@6.5.0 inspect-macho \
  "$APP/Contents/Resources/app.asar.unpacked/out/main/libNativeEngine.dylib" \
  --json > "$OUT/rea-native-engine.json"
nm -gU "$APP/Contents/Resources/app.asar.unpacked/out/main/libNativeEngine.dylib" \
  > "$OUT/native-symbols.txt"
c++filt < "$OUT/native-symbols.txt" > "$OUT/native-demangled.txt"
npx -y rea-agents@6.5.0 providers --json > "$OUT/providers.json"
```

### Schema source fingerprints

All paths below are relative to `Contents/Resources/app.asar.unpacked/out/main/JSONSchemas/`.
Pointers and field inventories in this note refer to these exact observed files.

| File | SHA-256 |
|---|---|
| `analysisRequests.json` | `304cfa4f708e32f9ef53e455f5b399f6f8fc349f210ed051b8ee0b5a31328f98` |
| `authRequests.json` | `ad698c5164015b2e7829fa34beacd680ad17417e73a004d931bbc6c1e155d5f7` |
| `platformRequests.json` | `12867f8df4ce704b5f9219d13407c7d4ddf9dca112a9bf94011b23e98be5f40a` |
| `pluginRequests.json` | `0b2e1f17369fc6c2a4dfb0c02867d20a409fb8a756c74fbb3b5cb5c74ec9f706` |
| `primitives.json` | `98ad952b6334caacf6cb37d6777f618e0c4b2aa5a5eb4206f974efc9ba51ccb1` |
| `requestSchemas.json` | `9e63083109cbefce1d83131f2ab1d8f25db7dba80f3ccd2ae783d303069d8ba4` |
