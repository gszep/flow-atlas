# Explicit local pipeline candidate

`packages/host/examples/explicit-pipeline.mjs` chains existing host operations:
import FCS by content hash → explicit compensation and channel mapping → full-event
export → re-import by output hash → explicit stored-F32 gate counts → receipts.
It does not infer a matrix, processing stage, Time scaling, channel mapping or gate
geometry. The operator supplies a JSON recipe, scientific assumptions, exact source
hashes, an explicit unverified raw-stage hypothesis, a matrix, a one-to-one rename
map, a Time override, F32 gate definitions and separately labelled reference counts.

The CLI checks workspace and sample hashes; it does **not** verify that the supplied
matrix, mappings or gates came from the given workspace. Inspect that relationship
independently. Output is always `experimental-not-validated`. An error stops further
steps; original inputs are not modified. Receipts retain processing context and hashes.

Build with `pnpm --filter @flow-atlas/host build`, put the sample and workspace
under an invocation-owned experiment root, then run:

```sh
node packages/host/examples/explicit-pipeline.mjs "$EXPERIMENT_ROOT" "$RECIPE_JSON"
```

Recipe shape (illustrative placeholders, not scientific settings):

```json
{
  "schemaVersion": 1,
  "acknowledgeUnvalidated": true,
  "inputStage": "operator-declared-raw-unverified",
  "assumptions": "Describe source, processing and coordinate hypotheses",
  "samplePath": "sample.fcs",
  "sampleSha256": "<64 lowercase hex digits>",
  "workspacePath": "workspace.wsp",
  "workspaceSha256": "<64 lowercase hex digits>",
  "timeStep": 1,
  "spillover": { "channels": ["D"], "matrix": [1] },
  "renameChannels": { "D": "Comp-D" },
  "gates": [{ "id": "g", "name": "Example", "parentId": null,
    "dimensions": ["Comp-D"],
    "geometry": { "type": "rectangle", "min": [0], "max": [null] } }],
  "gateReferenceCounts": [{ "id": "g", "count": 0 }]
}
```

`timeStep` is an explicit hypothesis in seconds per stored tick, not a recommended
default. Gate coordinates must already satisfy exact-F32 admission. Reference counts
are caller-provided comparisons, not trusted ground truth. This is a single-sample
compensation/gate-count slice, not patient clustering, control-derived estimation,
validated annotation, a gating-strategy generator, or browser integration.
