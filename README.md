# flow-atlas

_Agentic cytometry with a collective human verification and discovery layer._

Successor to [FlowAtlas.jl](https://github.com/gszep/FlowAtlas.jl) ([paper](https://doi.org/10.3389/fimmu.2024.1425488)).
The current direction is archived-data verification and discovery first, then live
scientific workflows; see [`docs/phase-one-plan.md`](docs/phase-one-plan.md).

**Browser prototype:** loads a FlowJo workspace + FCS files locally, transforms and
gates, trains a SOM, embeds with EmbedSOM and renders on WebGPU. The public demo at
[flow.gszep.com](https://flow.gszep.com/) automatically loads the publication
companion and uses a deterministic 100,000-event sample for its quick map.
Browser plots are not views of the separate host's analysis receipts or a claim
of general FlowJo interpretation/biological fidelity.
The source companion contains 3,885,530 events across 33 FCS files. A centered
progress bar shows loading; the map retains colour, marker-size and population
controls. Run metadata remain machine-readable without a prose-heavy sidebar.
Start with [`docs/HANDOFF.md`](docs/HANDOFF.md) and [`docs/decisions.md`](docs/decisions.md); agents read [`AGENTS.md`](AGENTS.md).

```sh
pnpm install
pnpm test          # unit + kernel (Dawn/Node) + parity tests
pnpm --filter @flow-atlas/ui dev  # local browser UI — drop data/ or open /?oracle
```

Requires a WebGPU browser (Chrome/Edge 113+). `?oracle=N` loads the first N oracle FCS files.

For agent-driven native analysis, use the local studio workflow in
`packages/host/README.md`. Build, served-version acceptance and rollback are
documented in `docs/DELIVERY.md`.
Public static-demo hosting is documented in [`docs/PUBLIC_DEMO.md`](docs/PUBLIC_DEMO.md).

## Packages

| Package | What |
|---|---|
| `packages/fcs` | FCS 2.0/3.0/3.1 reader, zero-dep |
| `packages/transforms` | FlowJo biex/linear/log tables (bit-exact with FlowWorkspace.jl) |
| `packages/wsp` | `.wsp` reader: samples, channels, transforms, gate DAG, groups (own XML parser) |
| `packages/compute` | WebGPU kernels: transform, gate, labels, gather/impute, batch SOM, map, EmbedSOM |
| `packages/ui` | Vite app: pipeline + WebGPU point renderer + legend |

## Documents

| File | Purpose |
|---|---|
| `docs/DELIVERY.md` | Local application delivery, actual MCP/RPC acceptance and rollback |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | Decisions made so far, open questions, first tasks. **Read first.** |
| [`docs/decisions.md`](docs/decisions.md) | Decision log with evidence (measured / verified / unverified) |
| [`docs/architecture.md`](docs/architecture.md) | Target architecture, package layout, agent tool surface, phases |
| [`docs/prior-art.md`](docs/prior-art.md) | Survey of agentic / browser / open-source cytometry tools (Sep 2026) |
| [`docs/lessons-from-decks.md`](docs/lessons-from-decks.md) | Collaboration / provenance / MCP patterns imported from `gszep/decks` |
| [`docs/reference/flowatlas-jl-internals.md`](docs/reference/flowatlas-jl-internals.md) | Line-by-line notes on what FlowAtlas.jl + FlowWorkspace.jl do, for porting |
| [`docs/reference/paper-extract.md`](docs/reference/paper-extract.md) | Extracted text of the 2024 paper (results + discussion) |

## License

MIT.
