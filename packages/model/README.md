# @flow-atlas/model

Pure, synchronous workspace definitions and atomic agent gate edits. No external runtime
dependencies; the existing WSP polygon/boolean and transform shapes are reused through
**type-only** imports. Importing the built package does not load parsers or numerical code.

## Small shared API

- `createWorkspace(id)` creates an empty schema-v1 document at revision 0.
- `validateWorkspace(value)` validates untrusted JSON-shaped input, including references/DAG.
- `parseWorkspace(json)` / `serializeWorkspace(document)` validate and roundtrip deterministic
  JSON (sorted object keys, preserved array order). Import is a **trusted storage boundary**,
  not an authorized editing endpoint: an agent must never replace the authoritative document
  with an arbitrary import to bypass provenance checks.
- `applyTransaction(document, {expectedRevision, agentId, operations})` returns a detached
  document, `changed`, `invalidatedGateIds`, and `deletedAnnotationIds`. Input objects are
  never mutated. Rejection discards the whole batch. A successful, non-no-op batch increments
  the revision exactly once; stale revisions fail even for empty batches.
- `inspectWorkspace(document, {offset?, limit?})` returns counts, capabilities, and a gate page
  (default 50, max 100), without geometry or result arrays. Strings are capped at 4096 characters.

```ts
import { applyTransaction, inspectWorkspace, parseWorkspace } from "@flow-atlas/model";

const document = parseWorkspace(savedJson); // trusted persisted workspace with sample/channel refs
const result = applyTransaction(document, {
  expectedRevision: document.revision,
  agentId: authenticatedAgentId,
  operations: [{
    type: "addGate",
    gate: {
      id: "cd4-positive", sampleId: "sample-1", name: "CD4+", parentId: null,
      dimensions: ["CD4"],
      geometry: { type: "rectangle", min: [100], max: [null] },
    },
  }],
});
const summary = inspectWorkspace(result.document);
```

The future UI/host can call the same core API. The host must authenticate `agentId`, serialize
compare-and-swap publication against its authoritative revision, persist the returned document
atomically, and journal accepted changes. This package provides no locks, storage, authentication,
CRDT, or human-finalization operation. It never writes `{author, modified}` stamps.

## Schema and supported edits

`WorkspaceDocument` contains samples (`{sha256, basename, size}` file references), per-sample
channels and display transforms, raw-space gates, sample groups, and text annotations attached
to a gate or the workspace. IDs are unique within each collection; channel IDs are sample-local.
SHA-256 is lowercase 64-character hex; the model validates its shape, not file contents.
The initial metadata is supplied by a trusted importer/storage adapter and validated; there are
no sample/group/annotation editing operations yet.

Gates support rectangles (one or more dimensions), 2-D polygons, and boolean `and`/`or`/`not`
references. Both parent and boolean edges participate in the same acyclic, sample-local graph.
These are **definitions only**, not a claim that every shape has a compute implementation.
Other geometries, transforms, schema versions and operations fail with
`ModelError.code === "UNSUPPORTED_CAPABILITY"`; nothing silently approximates them.

- `addGate` accepts a complete `GateDefinition` without provenance.
- `updateGate` accepts `id` and a shallow `changes` object (replace geometry as a whole).
- `deleteGate` requires an explicit `mode: "reject" | "cascade"`. Reject mode blocks dependent
  gates or annotations; cascade deletes the full parent/boolean-dependent closure and attached
  annotations. Group membership references samples, so gate deletion does not alter groups.

References and cycles are checked at the end of the batch, permitting forward references.
Operations execute in order: deletion acts on dependencies present at that point. Any dangling
reference introduced later rejects the entire batch. Effective changes to human-finalized gates,
or ancestors/references on which those gates depend, are rejected. Human-finalized annotations
also protect their target and its dependencies. This is deliberately conservative (even an
ancestor rename needs human intervention). Identical/net-zero edits do not create attribution
or increment revision. Invalidated IDs are a transient result for future cache scheduling, not
persisted numeric results or a durable journal.

Finalized annotations are also protected by their own before/after state, independently of gate
invalidation. Deleting a gate and recreating it identically cannot erase its finalized annotations,
including annotations on resurrected dependents. For **unstamped** annotations, explicit cascade
deletion still applies: recreating a gate does not recreate its annotations. Such a batch changes
the document, increments its revision and reports deleted annotation IDs, but does not invalidate
unchanged gate definitions.

## Persistence limits

All object fields are allowlisted, including nested operation payloads. Event arrays, masks,
embeddings, counts and results have no schema field. Numeric geometry/transform values must be
finite; rectangle `null` bounds explicitly mean unbounded. An importer must intentionally map
WSP rectangle infinities to `null`; passing WSP objects with counts or unsupported fields directly
is rejected. NaN, infinities, negative zero, undefined, sparse/extended arrays, typed arrays,
accessors, symbols, custom prototypes and cyclic objects are rejected before serialization can
silently erase or alter them. Polygon topology and transform numerical validity are left to
future capability-specific validation; this package verifies structure, finiteness and references,
not numerical fidelity. No event data is read and no GPU is needed for document operations.
