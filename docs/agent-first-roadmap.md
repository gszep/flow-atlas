# Agent-first cytometry capability roadmap

## Product objective

The user clarified on 2026-10-17: Flow Atlas should make every useful FlowJo
operation available more efficiently to agents. Reproducing FlowJo's screen layout
or interaction sequence is not the goal. Capability coverage includes computation,
data/model operations, analysis workflows, import/export, and interpretable results.

The shipped-artifact investigation is in `docs/reference/flowjo-11-rea.md`. Its
69 native request intents and 155 renderer GraphQL operation candidates
are a starting inventory, **not proof of complete FlowJo capability coverage**.
Keep declaration evidence, recovered implementation, runtime measurement, and
Flow Atlas implementation status distinct.

## Delivery loop

1. Identify a useful scientific or workflow operation in the evidence.
2. Specify its agent-facing input, output, dependencies, side effects and errors.
3. Distinguish standard mathematical semantics from vendor-specific behavior.
   When compatibility depends on a native algorithm, obtain a numerical oracle
   before claiming parity or changing established behavior.
4. Assign an isolated implementation slice to a builder; independent slices can
   run concurrently within a shared resource budget.
5. Validate behavior and integration, review the changes, and deliver through a
   feature branch/PR. A running subagent or passing isolated test is not delivery.
6. Update capability status from demonstrated evidence. Missing operations remain
   explicit rather than being approximated silently.

## First implementation wave

| Slice | Motivation | Acceptance boundary | Status |
|---|---|---|---|
| Revisioned workspace core | FlowJo declares dependency/version state; Flow Atlas already specifies a shared document API | Serializable metadata-only document; bounded inspection; atomic gate edits with expectedRevision; cycle/reference checks; attribution and human-finalization rules | Integrated at `4e0678a` + `57b5a9a`; reviewed annotation-protection fix included |
| GPU Boolean populations | FlowJo declares AND/OR/NOT; our normalized gate type represents them but the compute adapter skips them | Truth-table behavior, parent restriction, dependency ordering, useful errors, counts/labels and windowed WebGPU execution | Independently reviewed without blocking findings; integrated at `1062793` |
| Unsupported transform preservation | Shipped families exceed our supported linear/log/biex set; WSP import silently substitutes linear | Inspectable original type/parameters and explicit computation refusal, preserving supported behavior | Reviewed and integrated at `5be2815`; combined validation passed |

These slices are useful independently of unresolved native numerical details.
Neither establishes that the studio/MCP host is already implemented.

The Boolean builder reports 86 passing tests (18 new). Independent review reran
23 focused tests plus additional ownership/alignment/empty-sample cases without
blocking findings. The unchanged 1,067-gate regression has exact count parity for
the existing single-sample Julia fixture, 332 exact FlowJo counts, and 953 counts
within **1% relative error or two events absolute error**. That is local Dawn/Metal
evidence; remote CI and exact FlowJo Boolean compatibility are not established.

Combined local validation passed **131 tests in 12 files**, lint, root typecheck,
UI typecheck and UI production build. The annotation protection defect discovered
during model review was fixed before integration; the reviewer independently
reran the original bypass and dependency-resurrection variants successfully.
These checks establish this implementation wave, not completion of the capability
families below or availability of a studio/MCP transport.

## Capability families and agent-oriented delivery

Status below describes the inspected `38aff03` baseline unless explicitly updated.
Proposed tool concepts are contracts to develop, not currently callable MCP tools.

| Capability family | Evidence in FlowJo | Flow Atlas baseline | Agent-oriented next delivery |
|---|---|---|---|
| Workspaces and immutable inputs | Analysis/workbench load/save/create, data sources, metadata | FCS and WSP readers; browser workspace pipeline | Open/import with content-hash identity and a compact compatibility report; save a diffable document |
| Sample/group/channel discovery | Sample tables, group trees, parameter sets, keywords, stain panels | Parsed samples/groups and channel union | Paginated text tables and composable selectors; batch metadata operations |
| Dependency and calculation state | Definition/results/recalc versions, calculation modes, completion notification | No shared revisioned document package yet | Explicit stale/valid/unsupported states and jobs bound to input revisions |
| Gate algebra | Geometric/event gates, Boolean populations, instantiate/copy/graft/promote | Rectangle/polygon compute; broader normalized shape vocabulary | Typed raw-space gate definitions, batch edits, DAG inspection and count deltas |
| Display transforms | Multiple transform families, vectors, target scopes, vertex conversion | Linear/log/biex LUTs; unsupported WSP transforms become linear | Preserve unsupported declarations; expose effective transform and scope; establish native numerical parity separately |
| Compensation and spectral unmixing | Matrices, correction, OLS/WLS/WOLS, controls and wizard operations | FCS spill metadata; no demonstrated complete compensation workflow | Inspect/apply named matrices with orientation, conditioning and detector compatibility reports |
| Counts and statistics | Frequency denominators, exact/channel/histogram variants, grouped tables | GPU gate counts and parity tests | Explicit estimator/coordinate-space selection, grouping, bounded outputs and reproducible summaries |
| Graph/event inspection | Graph/histogram requests, event lists, back-gating, selected-bin events | WebGPU embedding renderer | Text-first density/axis/gate summaries; bounded event lookup; optional image resource |
| Embedding and clustering | FlowSOM, UMAP, t-SNE/optSNE, XShift, cluster merge | SOM and EmbedSOM kernels | Seeded jobs, parameter provenance, comparison summaries and explicit compute status |
| Quality control | Event-quality filtering and QC plots | No demonstrated QC platform | Machine-readable diagnostics and suggested filters with before/after counts |
| Population comparison/modeling | Comparison statistics, regression, tests, charts | No demonstrated modeling platform | Typed analysis requests with assumptions, sample units, estimator definitions and tabular results |
| Reports and exports | Reports, layouts, tables/CSV, images, WSP import/export | WSP read only; browser visualization | Declarative report recipes and artifact resources; batch exports rather than UI automation |
| Imaging cytometry | Image walls/sets, channels, masks, selected events | No demonstrated image-event workflow | Event-linked image resources and metadata; batch inspection/filtering |
| Extensibility | Plugin lifecycle and execution | Planned tool harness | Versioned typed extensions with declared inputs/outputs, cancellation and reproducibility |
| History and recovery | Undo/redo, graph history, affected/evicted entries | Planned journal and collaboration | Inspectable operation history, atomic batch edits and revision-aware undo; distinguish display history from provenance |

## What “more efficient for agents” means

Evaluate real tasks rather than counting tool names or reproducing vendor menus:

- Open a multi-panel experiment and identify unavailable channels/operations without
  inspecting screenshots or accepting silent substitutions.
- Define and apply a reusable gating strategy across samples with one revision-bound
  operation, then inspect affected populations and count differences.
- Request a grouped statistic table with an explicit denominator, estimator and
  transform/compensation context; receive bounded results rather than event arrays.
- Launch an embedding or compensation job, continue independent work, and consume
  completion/failure state tied to the exact input revision.
- Export an analysis/report recipe and reproduce it on the same immutable inputs.

For each task record successful completion, correctness/compatibility evidence,
number of agent calls, response bytes, queue/setup/compute/total latency, and human
interventions. An API that merely hides missing work behind a success status fails
this objective.

## Integration constraints

Follow existing repository policy: WebGPU is the numerical compute path; standalone
WGSL kernels; windowed buffers; metadata-only workspace documents; no agent-written
human provenance stamps; shared UI/agent operations; bounded text-first results.
No raw proprietary bundles or decompiled function bodies are publication inputs.
Native static findings must not silently replace the Julia fixture oracle or
establish v10/v11 equivalence.

The next host slice should expose the actual shared operations through studio
JSON-RPC/MCP, retaining revision errors and unsupported statuses. A full protocol
surface should grow from demonstrated workflows; the 155 vendor operation names
are not a mandate for 155 separate tools.
