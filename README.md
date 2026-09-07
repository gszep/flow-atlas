# flow-atlas

_High-dimensional flow cytometry analysis in the browser, with agents._

Successor to [FlowAtlas.jl](https://github.com/gszep/FlowAtlas.jl) ([paper](https://doi.org/10.3389/fimmu.2024.1425488)).
Goal: a zero-install, WebGPU-native, open-source cytometry workspace that (Phase 1) reproduces FlowAtlas.jl
without Julia, exposes the whole workflow to coding agents via MCP, and (Phase 2) replaces FlowJo entirely.

**Status: Phase 1 prototype.** Loads a FlowJo workspace + FCS files entirely in the browser, transforms,
gates (exact parity with FlowAtlas.jl), trains a SOM, embeds with EmbedSOM and renders the map on WebGPU.
Start with [`docs/HANDOFF.md`](docs/HANDOFF.md) and [`docs/decisions.md`](docs/decisions.md); agents read [`AGENTS.md`](AGENTS.md).

```sh
pnpm install
pnpm test          # unit + kernel (Dawn/Node) + parity tests
pnpm dev           # http://localhost:3141 — drop the FlowAtlas.jl data/ folder, or open /?oracle to auto-load it
```

Requires a WebGPU browser (Chrome/Edge 113+). `?oracle=N` loads the first N oracle FCS files.

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
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | Decisions made so far, open questions, first tasks. **Read first.** |
| [`docs/decisions.md`](docs/decisions.md) | Decision log with evidence (measured / verified / unverified) |
| [`docs/architecture.md`](docs/architecture.md) | Target architecture, package layout, agent tool surface, phases |
| [`docs/prior-art.md`](docs/prior-art.md) | Survey of agentic / browser / open-source cytometry tools (Sep 2026) |
| [`docs/lessons-from-decks.md`](docs/lessons-from-decks.md) | Collaboration / provenance / MCP patterns imported from `gszep/decks` |
| [`docs/reference/flowatlas-jl-internals.md`](docs/reference/flowatlas-jl-internals.md) | Line-by-line notes on what FlowAtlas.jl + FlowWorkspace.jl do, for porting |
| [`docs/reference/paper-extract.md`](docs/reference/paper-extract.md) | Extracted text of the 2024 paper (results + discussion) |

## License

MIT.
