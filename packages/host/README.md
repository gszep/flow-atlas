# Agent-first studio: native FCS workflows

The Node 24 studio exposes one shared analysis backend through MCP and JSON-RPC.
It imports FCS artifacts, inspects bounded metadata/event pages, validates and
applies explicit acquisition scaling, conventional compensation or spectral OLS
on WebGPU, and writes new FCS files in chunks.
An agent can run the complete workflow without launching FlowJo or a browser.

## Start a studio

From the repository:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm --filter @flow-atlas/host build
pnpm --filter @flow-atlas/host start --root /absolute/path/to/experiment
```

Startup prints a JSON record with the loopback URL and MCP/RPC endpoints. Supply
`FLOW_ATLAS_TOKEN` to use an operator-managed bearer token. Otherwise the host
generates one and writes a mode-0600 connection file in an invocation-owned
private temporary directory; stdout reports its path without printing the token.
The invocation removes its own connection file on normal shutdown. Point an MCP
HTTP client at the printed `/mcp` endpoint with `Authorization: Bearer <token>`.

`--port` selects a port (default: an OS-assigned port). `--ui` optionally serves
built browser assets; an existing `packages/ui/dist` build is discovered by default.
The existing browser visualization remains a WSP client; native FCS operations
are primarily agent tools, not a new compensation GUI. There is one studio entrypoint,
not a separate suite of command-line analysis commands.

## Agent workflow

1. `list_capabilities` describes supported formats, precision, bounds and unsupported
   operations. It does not pretend a GPU has already been initialized.
2. `import_fcs({path})` snapshots a workspace-relative regular file in bounded
   chunks, computes SHA-256, validates its FCS metadata, and returns a sample ID.
   Original bytes remain untouched. Imports/inspection do not apply compensation.
3. `inspect_fcs` pages channels and keyword summaries; `get_spillover` returns a
   named square matrix. `preview_fcs` returns at most 100 events × 32 selected
   channels; omitted selection shows the first 16. Nonfinite raw preview values
   are explicitly encoded as JSON null, not silently substituted in computation.
4. `register_compensation({sampleId, spillover?})` uses an explicit matrix or
   embedded spillover, matches exact parameter names, validates acquisition-scale
   eligibility, and checks inversion/condition/residual on the GPU. The returned
   ID is bound to that input sample and matrix. It returns compact diagnostics,
   not a second copy of all coefficients. Re-registration of the same definition
   is idempotent within the session.
5. `start_fcs_export` starts a job. Choose compensation explicitly, an event range,
   channel selection/order, channel renames, and optional keyword changes. Structural
   keywords are managed by the writer. Partial raw spillover panels reject rather
   than imply a valid reduced compensation system; compensate before dropping a
   participating channel.
6. `get_job` provides progress and terminal errors; `cancel_job` stops future chunks
   and drains owned work. Cancellation is refused once atomic publication starts.
7. `get_receipt` returns inputs, recipe, matrix/diagnostics, output hash, precision,
   runtime/adapter/shader identity and timing. Outputs live under
   `outputs/<jobId>/`, with the FCS and receipt published together by directory
   rename. A failed/cancelled run never publishes its partial FCS.

For example, using the same backend directly:

```ts
import { createAnalysisService } from "@flow-atlas/host";
import { setTimeout } from "node:timers/promises";

const service = await createAnalysisService({ root: "/data/experiment" });
try {
  const sample = await service.invoke("import_fcs", { path: "sample.fcs" });
  // Calls return unknown at this generic transport boundary; validate/narrow the
  // documented result before using sampleId/id/jobId in an agent integration.
  const matrix = await service.invoke("register_compensation", {
    sampleId: (sample as { sampleId: string }).sampleId,
  });
  const job = await service.invoke("start_fcs_export", {
    sampleId: (sample as { sampleId: string }).sampleId,
    compensationId: (matrix as { id: string }).id,
    outputName: "compensated.fcs",
  });
  const { jobId } = job as { jobId: string };
  const deadline = Date.now() + 60_000;
  for (;;) {
    const status = await service.invoke("get_job", { jobId }) as { state: string };
    if (status.state === "succeeded") break;
    if (status.state === "failed" || status.state === "cancelled") {
      throw new Error(JSON.stringify(status));
    }
    if (Date.now() > deadline) {
      await service.invoke("cancel_job", { jobId });
      throw new Error("Experiment step exceeded its deadline");
    }
    await setTimeout(50);
  }
  console.log(await service.invoke("get_receipt", { jobId }));
} finally {
  await service.close();
}
```

Choose a deadline appropriate to the experiment. In RPC the operation is the
JSON-RPC `method`; MCP exposes identical names and strict input schemas.

## Explicit acquisition and spectral processing

`preview_fcs`, `register_compensation`, `register_unmixing` and `start_fcs_export`
accept `inputSpace: "stored" | "linearized"`. Stored remains the default for
unbound requests and means values in the input file—not proof that the instrument
or another application never processed them. Linearized is an opt-in acquisition
profile; it is not a display transform.

- Ordinary linear channels divide by gain. Log channels apply
  `log0 * 10^(decades * stored / range) / gain`. Positive decades with zero log0
  use one, recorded as a compatibility normalization.
- Time is an explicit exact `acquisition.timeChannel`, otherwise the unique
  case-insensitive exact name `Time`. Its gain is ignored. `acquisition.timeStep`
  overrides declared metadata; absent metadata defaults to one. Non-unit step
  without Time, ambiguous Time and nonlinear Time reject.
- `$TIMESTEP` and legacy `TIMESTEP` are reconciled explicitly; conflicting values
  require an override. Linearized export removes stale aliases, writes canonical
  `$TIMESTEP=1`, and resets exported gains/amplification. Values are not clamped
  to nominal ranges. Stored-space Time renaming with a non-unit timestep requires
  explicit linearization first.
- Matrices bind their input space and effective acquisition settings. When a matrix
  ID is supplied, omitted processing settings inherit its definition; contradictory
  settings reject. Existing stored-space conventional IDs remain compatible.

`register_unmixing` accepts named `detectors`, named `fluorochromes`, a row-major
fluorochrome-by-detector `matrix`, optional `residualChannel`, and nominal
`outputRanges`/`residualRange` (default 262144, not clipping thresholds).
For `measured = abundances × reference`, the GPU computes unweighted full-rank OLS
with column-pivoted Householder QR. There must be at least as many detectors as
fluorochromes, with at most 128 of each. Negative abundances are retained.

All original columns remain in the selected input space; fluorochromes and optional
Euclidean L2 fit residual are appended. Select/reorder/rename these columns on export
as usual. Derived outputs cannot impersonate the Time axis. Receipts record column
roles, matrix/input context, GPU quality metrics and acquisition evidence. Nominal
output ranges are supplied metadata, not measured extrema. Conventional compensation
and spectral OLS are alternatives in one request, not an implicit chain.

Example arguments to `register_unmixing`, after importing a compatible sample:

```json
{
  "sampleId": "<imported sample ID>",
  "inputSpace": "linearized",
  "detectors": ["V450", "V500", "B530"],
  "fluorochromes": ["CD3", "CD19"],
  "matrix": [1, 0.25, 0.5, 0.125, 1, 0.75],
  "residualChannel": "UnmixingResidual"
}
```

Pass its returned ID as `unmixingId` to preview/export. These coefficients are
illustrative, not a reference for an actual panel.

Both profiles are F32 with explicit numerical rejection policies. Identity
acquisition channels preserve bits; transformed values reject nonfinite or unsafe
subnormal intermediates/results. Spectral diagnostics distinguish accepted QR pivots
from an SVD rank estimate and infinity conditioning from 2-norm conditioning.
Nonlinear Time, weighted WLS/WOLS, SpectralFX and native FlowJo parity remain outside
this implementation. Failures identify processing stage and source chunk coordinates;
no partially processed FCS is published.

## Estimating conventional compensation from controls

`start_control_estimation` starts a bounded GPU job with an explicit application
`sampleId`, 1–32 unique detector `channels`, and exactly one control pair per
detector. Each pair has `primaryDetector`, `positive` and `negative`; each population
binds an imported `sampleId`, optional `startEvent`/`eventCount`, and up to 16
inclusive channel ranges (`min`/`max`, null for unbounded). Bounds must be exactly
representable finite F32 values. Ranges are ANDed in the selected input space;
they are analysis selections, not edits to workspace gates. Negative controls may
be separate files or shared populations. Identical population definitions reuse
one summary within the job.

```json
{
  "sampleId": "<application sample ID>",
  "channels": ["D0", "D1"],
  "minEvents": 100,
  "controls": [
    {"primaryDetector": "D0", "positive": {"sampleId": "<D0 control ID>"},
     "negative": {"sampleId": "<unstained ID>"}},
    {"primaryDetector": "D1", "positive": {"sampleId": "<D1 control ID>"},
     "negative": {"sampleId": "<unstained ID>"}}
  ]
}
```

`minEvents` is required for each positive and negative population; the example's
100 is illustrative, not a universal biological cutoff. `minPrimarySeparation`
defaults to zero and is rounded to F32; primary separation must strictly exceed it.
The profile is `conventional-median-difference-primary-f32-v1`: exact lower/upper
F32 median ranks are selected in four replay passes, paired endpoint differences
are averaged on GPU, and each control row is divided by its primary separation.
Negative and above-one coefficients remain intact. Nonfinite selected targets,
empty/undersupported populations, subnormal endpoints, unsafe arithmetic and
singular/poorly conditioned matrices reject before a usable matrix is published.

Top-level `inputSpace` applies to all controls and the application sample.
For `linearized`, top-level `acquisition` configures the target; each population's
optional `acquisition` configures that source independently. Ordinary gains and
log metadata come from each file. Stored detector values must be linear/unit-gain.
Temporal acquisition parameters cannot participate as compensation detectors.
Known instrument model/serial and detector voltage disagreements reject; missing
metadata is reported explicitly and is not proof of biological compatibility.

Poll `get_job`: progress counts **event-visits**, including all four median passes,
not unique events. Success returns `result.compensationId` for preview/export in
the current host instance. `outputs/<jobId>/matrix.json` and `receipt.json` are
published together. Receipts retain source hashes, exact selections/context,
support, endpoints, numerical and conditioning diagnostics, recipe hash and runtime
identity. Export receipts link the estimation receipt. After restarting a host,
the artifacts/receipts remain readable; matrix registrations are session-local,
so explicitly re-register the persisted matrix and its context for further use.

This operation does not infer positive gates, establish biological QC, estimate
spectral references or implement AutoSpill/AutoSpread. Native FlowJo parity remains
unverified. The job recipe is limited to 64 KiB and each source range to 2^32−1 rows.
Receipts must fit the 256 KiB MCP budget before publication. Oversized evidence
fails the job; if the failure receipt also exceeds that budget, it explicitly
records endpoint/candidate evidence omission and retains the recipe and error.

## Streamed population counts

`start_gate_counts` evaluates an explicit gate recipe against an immutable imported
sample. Set `coordinateSpace: "stored-f32"`; optionally restrict `startEvent` and
`eventCount`. Gates have unique `id`, `name`, nullable `parentId`, exact named
`dimensions`, and rectangle, polygon or Boolean geometry. Rectangle bounds use
null for unbounded axes. Boolean geometry names `op: "and" | "or" | "not"` and
referenced gate IDs. Gate order does not define dependency order.

```json
{
  "sampleId": "<imported sample ID>",
  "coordinateSpace": "stored-f32",
  "gates": [
    {"id": "positive", "name": "Positive", "parentId": null,
     "dimensions": ["D0"], "geometry": {"type": "rectangle", "min": [100], "max": [null]}},
    {"id": "negative", "name": "Complement", "parentId": null,
     "dimensions": [], "geometry": {"type": "boolean", "op": "not", "refs": ["positive"]}}
  ]
}
```

The threshold is illustrative; callers supply their own scientifically justified recipe.

The receipt's `summary.counts` reports population counts and explicit
`parentCount`/`rootCount` denominators in request order. Each row has `id`, `name`,
`parentId`, `count`, `frequencyOfParent` and `frequencyOfRoot`.
Frequencies are fractions, not percentages; an empty denominator produces null.
The selected root is the requested event window, not necessarily the whole file.
Jobs publish `counts.json` and `receipt.json` together, and use the existing
`get_job`, `cancel_job` and `get_receipt` operations. Counts are computed on GPU
in bounded chunks; event arrays and membership masks are not returned in receipts.

This contract does not edit workspace gates or apply display transforms. It uses
stored decoded F32 values exactly as declared, including any processing already
present in the imported file. To count a newly compensated/linearized/unmixed
artifact, export it through the existing pipeline and import that artifact explicitly.
The recipe limit is 64 KiB, with up to 128 gates and 256 vertices per polygon.
All coordinates must be exactly representable normal-or-zero F32 values. Rectangle
edges are inclusive; null bounds use exact finite F32 extrema. Polygon vertices
are limited to magnitude ≤2³⁰, with each nonhorizontal edge's |dy| ≥2⁻³⁰. A GPU
bounding box excludes extreme events before the existing even-odd polygon test,
bounding crossing arithmetic. F32 rounding/possible subnormal flushing still apply;
this is not exact-real boundary geometry or a FlowJo parity claim. Geometric gates
exclude NaN and infinities; Boolean NOT can include those events within its parent.
Unsupported geometry, missing channels/references and cyclic dependencies reject
before admission rather than silently skipping populations.

## Batch population-count tables

`start_batch_gate_counts` applies the same gate recipe to 1–32 distinct imported
sample IDs. Each entry may provide a descriptive `label` and its own
`startEvent`/`eventCount`. Set `coordinateSpace: "stored-f32"` and supply the same
`gates` shape as `start_gate_counts`. The product of sample count and gate count
must be at most 512; the whole recipe is limited to 64 KiB.

```json
{
  "coordinateSpace": "stored-f32",
  "samples": [
    {"sampleId": "<first imported sample ID>", "label": "baseline"},
    {"sampleId": "<second imported sample ID>", "label": "follow-up"}
  ],
  "gates": [
    {"id": "positive", "name": "Positive", "parentId": null,
     "dimensions": ["D0"], "geometry": {"type": "rectangle", "min": [100], "max": [null]}}
  ]
}
```

All source channels, dependencies and event windows are validated before admission.
Sources execute sequentially through the same bounded GPU count runner; one batch
occupies one job slot. Progress counts event rows across samples, with the current
sample identified by `progressDetail`. Matching names do not imply normalized units
or biological comparability: stored values are used explicitly, with no pooled
counts, inferred group statistics or implicit processing.

The receipt's `summary.samples` records sample identity, optional label, resolved
event range, selected-root count and per-source recipe hash. `summary.rows` is in
sample-major, request-gate order. Each row has zero-based `sampleIndex` and
`gateIndex` referring to `receipt.recipe.samples` and `receipt.recipe.gates`, plus
`count`, `parentCount`, `rootCount`, `frequencyOfParent` and `frequencyOfRoot`.
Shared gate names/definitions are stored once rather than repeated in every row.
Empty sample windows retain rows with zero counts and null frequencies.

The complete `counts.json` table and receipt publish atomically only after every
source succeeds and the 256 KiB response budget passes. A failure identifies the
source and number of completed samples without publishing a partial table.
Cancellation, restart observation and receipt retrieval use the existing job tools.
No workspace gates or human-finalization stamps are changed.

## Gated population median ranks

`start_population_medians` reports exact central **rank endpoints** for 1–32 named
channels in one explicitly selected population. Use `coordinateSpace: "stored-f32"`,
the same gate recipe as count jobs, and `populationId` equal to a gate ID. For the
selected source root, use `populationId: null` with an empty/omitted `gates` array.
Optional `startEvent`/`eventCount` restrict the source window before gating.

```json
{
  "sampleId": "<imported sample ID>",
  "coordinateSpace": "stored-f32",
  "populationId": "positive",
  "channels": ["D0", "D1"],
  "gates": [
    {"id": "positive", "name": "Positive", "parentId": null,
     "dimensions": ["D0"], "geometry": {"type": "rectangle", "min": [100], "max": [null]}}
  ]
}
```

The threshold is illustrative. `summary.count` is selected support; `lower` and
`upper` follow `summary.channels` order. `summary.ranks` explicitly reports the
zero-based central indices: `floor((count−1)/2)` and `floor(count/2)`. Each
channel is ranked independently; indices refer to sorted channel values,
not original event positions or one representative event. For odd counts
the endpoints coincide. For even counts they are the two central observed values;
**no midpoint average is computed**. These are order statistics, not confidence
bounds or a claim of FlowJo `MedianExact` parity.

The full gate recipe is validated, but only the selected gate's parent/Boolean
dependency closure is evaluated on each pass. GPU gate membership is transferred
as a bounded Uint32 mask and consumed by the
GPU rank primitive. Four replay passes recompute membership against the same pinned,
hash-verified source; each pass's gate support must agree with the rank result.
Progress units are **event-visits**, with `progressDetail.pass` numbered 0–3.
`summary.diagnostics.sourceRows` records source-window support before gating.
The result also records the gate numerical policy, or null for root selection.

Empty populations fail with `EMPTY_POPULATION`; selected nonfinite target values
fail with `NONFINITE_POPULATION_TARGET`. Values outside the population do not
invalidate its target summaries. Target subnormals retain exact F32 rank ordering;
signed zeros canonicalize to positive zero. Gating itself retains the documented
bounded-F32 geometry/nonfinite policy, including parent-restricted Boolean NOT.

Recipes are limited to 64 KiB, source windows to 2^32−1 rows and gate definitions
to the count-job limits. The host bounds reader, gate-mask and median-window
allocations; it does not materialize the full population or sort events on CPU.
`medians.json` and its receipt publish together only after complete validation.
Use the existing job/cancellation/receipt tools; persisted observations survive
restart. This stored-space operation does not implicitly apply acquisition,
compensation, unmixing or display transforms, and does not edit workspace gates.

## Batch median-rank tables

`start_batch_population_medians` reuses the same `coordinateSpace`, `populationId`,
`gates` and `channels` contract across 1–32 distinct immutable samples. Replace
the single `sampleId` with `samples: [{sampleId, label?, startEvent?, eventCount?}]`.
The product of sample and target-channel counts is capped at 512 rows; the shared
recipe remains limited to 64 KiB. All source bindings validate before admission.

```json
{
  "coordinateSpace": "stored-f32",
  "populationId": null,
  "channels": ["D0", "D1"],
  "samples": [
    {"sampleId": "<first imported sample ID>", "label": "baseline"},
    {"sampleId": "<second imported sample ID>", "label": "follow-up"}
  ]
}
```

The omitted gate list defaults to empty for this root-selection example. A gated
batch instead supplies one common recipe and selected gate ID. Sources execute
sequentially through the reviewed four-pass runner, using only the selected gate's
dependency closure. There is no pooling, midpoint interpolation or automatic unit
normalization; each source retains its own support and rank metadata.

`summary.rows` contains `{sampleIndex, channelIndex, lower, upper}` in sample-major,
requested-channel order. Indices are zero-based into `recipe.samples` and
`summary.channels`. `summary.samples` contains identity, optional label, actual
window, selected `count`, central `ranks`, diagnostics, gate policy and per-source
recipe hash. Shared names and gate definitions are stored once rather than repeated
for every endpoint row. As with single-population summaries, these endpoints are
order statistics, not confidence bounds.

Progress counts event-visits across all sources. `progressDetail` identifies the
sample, zero-based pass and that sample's completed visits. A successful job visits
each source-window row four times. A later empty population, selected nonfinite
target, integrity error or cancellation prevents publication of the entire table;
failure diagnostics retain source identity, completed-sample count and original
cause where applicable. No null or imputed endpoints replace failed sources.

The complete `medians.json` and receipt publish atomically after validation and
the 256 KiB response-budget check. Standard job, cancellation and restart-observation
operations apply. Compact persisted bindings avoid repeating large gate plans per
sample. No workspace definitions or human-finalization stamps are changed.

## Read-only workspace-bound analysis

`inspect_workspace` reads the repository's `@flow-atlas/model` v1 JSON format from
a workspace-relative path. Documents are capped at 1 MiB and decoded as strict
UTF-8. The response includes `document: {path, id, revision, sha256, bytes}`; the
SHA-256 identifies **raw file bytes**, so even a same-revision manual edit is visible.

Inspection views are `samples` (default), `gates` and `channels`. Supply `sampleId`
to filter gates or to select a channel page; it is required for channels and is
not accepted for the samples view. Pages use `offset` and `limit` (1–100), and may
return fewer items to stay within 256 KiB. Continue from `nextOffset`; IDs are never
truncated. Optional `expectedRevision` and `expectedSha256` keep subsequent pages
bound to the same document. Gate pages report declared `humanFinalized` metadata;
channel pages preserve display-transform declarations.

`start_workspace_gate_counts` evaluates all gates belonging to one **model sample
ID**. `start_workspace_population_medians` additionally accepts a model gate ID
(or null for root) and a `channels` list of **model channel IDs**. Both require
the inspected revision/hash and explicit `coordinateSpace: "stored-f32"`:

```json
{
  "path": "workspace.flowatlas.json",
  "expectedRevision": 7,
  "expectedSha256": "<document byte SHA-256 from inspection>",
  "sampleId": "<model sample ID>",
  "coordinateSpace": "stored-f32"
}
```

For median ranks, add `populationId` and `channels`; optional event windows use
`startEvent`/`eventCount` as in the underlying tools. The adapter looks up only the
declared `sample.file.sha256` in managed imported FCS artifacts and checks its byte
size. A basename in the document does not import or open an FCS file implicitly.
Import the data explicitly before submitting analysis.

Used model channel IDs map to exact, unambiguous FCS parameter names. Gate IDs,
parent/Boolean references and raw geometry are preserved. Display transforms are
recorded as unapplied; coordinates are not rounded. Existing profile limits still
apply, so a model-valid definition can be unsupported for computation—for example,
a rectangle with more than two dimensions or non-exact-F32 bounds.

These are **admitted-snapshot jobs**. The adapter checks document hash/revision
while capturing the request, then executes the captured numerical recipe without
rereading the document. Subsequent edits do not change or cancel that computation.
Results describe the captured version; inspection provides the current binding
when a client needs to determine whether it is still current.

Receipts/artifacts retain the workspace request as `recipe`, the mapped legacy
arguments as `compiledRecipe`, and a `workspace` binding containing document and
sample identities plus channel-ID/name mappings. `analysisRecipeHash` identifies
the underlying numerical recipe; `recipeHash` also binds its workspace context.
The compiled recipe can be resubmitted to the underlying count/rank tool. Requests
are capped at 64 KiB and bindings at 32 KiB; publication retains the 256 KiB limit.

The source document and its provenance stamps remain byte-for-byte unchanged by
inspection or analysis. Numerical outputs do not acquire human-finalization
stamps. These operations add no workspace editing, transaction or journal endpoint.

## Numerical and artifact contracts

- FCS list-mode 2.0/3.0/3.1 input, strict UTF-8 TEXT, and F/I/D decoding to F32.
  Raw means stored numeric values: acquisition gain, logarithmic amplification,
  and time scaling are not silently applied. F64/I64 conversion is not lossless.
- Conventional square spillover uses `measured = true × spill`. Both inversion
  and event arithmetic run on WebGPU. Singular/nonfinite/unsafe matrices reject
  with diagnostics. This does not claim native FlowJo parity, weighted unmixing,
  correction-matrix equivalence, or automatic acquisition/precompensation inference.
- Stored-space compensation participants and exports require linear unit-gain
  values. Explicit linearization enables supported gain/log/time conversions.
  Negative and above-range values remain valid and are not clamped.
- Export is explicitly FCS3.1 F32 little-endian. Compensated/unmixed exports strip active
  spillover aliases and retain the matrix in their receipt. Raw exports preserve
  a complete explicit matrix, including renamed parameter identities.
- Inputs are content-addressed snapshots under `.flow-atlas/inputs`. Replaced
  source files cannot silently change already imported samples. Export rechecks
  the snapshot hash. Input artifacts, outputs and receipts are retained on disk;
  no automatic disk eviction/quota is implemented in this wave.
- The default 4 MiB event budget bounds both decoded input and expanded output
  rows; configurable range is 1 KiB–64 MiB. Encoded
  plus decoded source chunks also respect 128 MiB. No whole-file event array or
  serialized event payload enters the workspace document.
- Current multi-stage processing exchanges bounded F32 chunks between stages;
  it is not yet a fused GPU-resident pipeline. Measurements include those upload
  and readback costs. Bounded memory is not a claim of optimal throughput.
- There is one export job at a time, at most 16 queued jobs/active API calls,
  32 cached full sample metadata records, a 4096-entry session sample catalog,
  128 registered conventional and 128 spectral definitions, and 128 retained terminal job objects.
  Older terminal observations remain on disk. JSON transport limits below still apply.
- Job progress is ephemeral; terminal receipts and observations survive ordinary
  process restart. Published receipts are authoritative if the secondary run index
  was not saved. Incomplete jobs are not automatically resumed or reclassified as
  live after restart. Receipt timing labels separate queue/setup/processing and
  exclude final publication from `totalBeforePublicationMs`.

## Backend-independent transport

The injected interface permits a future supervised Rust/wgpu worker to own data
and GPU resources without changing the agent protocol. No Rust scalability advantage
has yet been measured; the current backend establishes the comparison baseline.

```ts
import { createStudioServer, type AnalysisService } from "@flow-atlas/host";

declare const service: AnalysisService; // trusted backend implementing invoke and close
declare const trustedToken: string;
const studio = await createStudioServer({ service, token: trustedToken, port: 0 });
// studio.url is the bound loopback origin. Shutdown is idempotent:
await studio.close();
```

`AnalysisService.invoke(name, args, signal?)` receives validated arguments for the
operations in exported `operationSchemas`. `AnalysisError(code, message,
details?)` supplies public, JSON-safe errors; never put secrets in these fields.
Unexpected exceptions become `INTERNAL_ERROR` without exposing their messages.
The backend owns file roots, data, GPU resources, export jobs and receipts. It
must honor abort signals and settle outstanding work when `close()` is called.
Host close aborts requests, closes connections, calls backend close once and
drains outstanding handlers/invocations; it does not forcibly abandon work that
ignores cancellation. Request cancellation is not export-job cancellation: use
`cancel_job` for backend-owned jobs that outlive an HTTP request.

## Endpoints and wire behavior

- `POST /rpc`: single JSON-RPC 2.0 requests with operation names as `method` and
  object `params`; omitted params mean `{}`, explicit null does not. Notifications
  execute but return HTTP 204. Both transports reject batches, methods over 128
  characters and string IDs over 256 characters (bounded response envelopes).
- `POST /mcp`: MCP Streamable HTTP, using **SDK v2** `McpServer` from
  `@modelcontextprotocol/server@2.3.1` and `NodeStreamableHTTPServerTransport` from
  `@modelcontextprotocol/node@2.1.1`. A fresh server/transport per request uses
  `{ sessionIdGenerator: undefined, enableJsonResponse: true }` and
  `handleRequest(req, res, parsedBody)`. The injected backend is shared, not the
  protocol session. No server-push GET stream, DELETE session, or cross-request
  cancellation notification support is claimed. HTTP disconnects abort the
  backend call, combined with the SDK's `ctx.mcpReq.signal`.
- MCP discovery advertises the same strict Zod 4 object schemas as RPC validation.
  SDK input validation errors return SDK `isError` text before our callback runs.
  Backend errors return `isError`, JSON text `{error: {code, message, details?}}`
  and matching `structuredContent.error`. Success is bounded JSON text.
- RPC errors have conventional numeric JSON-RPC codes (-32700 parse, -32600
  request, -32601 method, -32602 params, -32603 internal); backend errors use
  -32000. `error.data` carries the same `{code, message, details?}` backend fields.
- `GET /health` is unauthenticated, minimal and nonsecret. If `uiDirectory` is
  supplied, GET/HEAD static files are served beneath its canonical real path;
  symlink escapes are rejected. It serves built assets, not a dev server or SPA
  fallback. Only this trusted configured asset directory is public, never data.

SDK-client initialization/list/call interoperability is tested with the pinned
`@modelcontextprotocol/client@2.3.1`. This uses the SDK's Streamable HTTP session
adapter; it does **not** claim the newer stateless `createMcpHandler` discovery
surface. Official source references: TypeScript SDK `README.md` and
`packages/middleware/node/src/streamableHttp.ts` on its GitHub `main` branch;
installed pinned declarations/source are the executable API authority.

## Local security and limits

Only literal loopback bindings `127.0.0.1` (default) or `::1` are accepted. The
exact bound Host (including port) and, when supplied, exact Origin must match;
arbitrary DNS aliases, foreign origins and `Origin: null` fail closed. All analysis
requests require `Authorization: Bearer <token>` from trusted startup options.
The token is not placed in URLs, static files, logs or health. Generate a strong
random token outside this adapter (or use the studio entrypoint's private connection
file) and distribute it only to authorized clients.
There is no OAuth, approval flow, remote model integration or CORS wildcard.

Artifact reads check canonical paths and descriptor identity; cold-cache hash
verification and metadata parsing use the same descriptor. Special files are
rejected through nonblocking admission before any data read. These application
checks are not an OS sandbox against hostile same-user processes concurrently
rewriting directory trees or managed artifacts.

JSON bodies are capped at 1 MiB even without Content-Length; compressed bodies
are unsupported. HTTP JSON responses are capped at 1 MiB. MCP tool payloads have
a conservative 256 KiB cap to leave room for escaped text and error metadata.
Bounded serialization checks size during traversal, rejects cycles, non-finite
numbers and typed arrays, and caps depth (64) and visited nodes/keys (50,000).
Optional undefined object fields are omitted as in JSON.stringify. Oversized
results become explicit `RESPONSE_TOO_LARGE` errors. Static assets stream and
are not subject to the JSON response limit. Backend pagination/data limits are
still required; transport caps are not authorization or numerical validation.

This FCS workflow does not implement shared Yjs gate editing, UI human-finalization,
or the full workspace journal. Its run receipts are computation evidence, not human
provenance stamps. Optional `webgpu@0.6.0` supplies the native GPU host; ordinary
metadata and uncompensated FCS I/O do not need it. The build bundles the existing
standalone WGSL assets so the actual Node entrypoint needs no Vite loader.

`pnpm --filter @flow-atlas/host test:built` exercises the compiled Node process,
real HTTP calls, GPU compensation, streamed export, re-import and shutdown.
