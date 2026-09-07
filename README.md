# flow-atlas

_High-dimensional flow cytometry analysis in the browser, with agents._

Successor to [FlowAtlas.jl](https://github.com/gszep/FlowAtlas.jl) ([paper](https://doi.org/10.3389/fimmu.2024.1425488)).
Goal: a zero-install, WebGPU-native, open-source cytometry workspace that (Phase 1) reproduces FlowAtlas.jl
without Julia, exposes the whole workflow to coding agents via MCP, and (Phase 2) replaces FlowJo entirely.

**Status: pre-scaffold.** Start with [`docs/HANDOFF.md`](docs/HANDOFF.md).

## Documents

| File | Purpose |
|---|---|
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | Decisions made so far, open questions, first tasks. **Read first.** |
| [`docs/architecture.md`](docs/architecture.md) | Target architecture, package layout, agent tool surface, phases |
| [`docs/prior-art.md`](docs/prior-art.md) | Survey of agentic / browser / open-source cytometry tools (Sep 2026) |
| [`docs/reference/flowatlas-jl-internals.md`](docs/reference/flowatlas-jl-internals.md) | Line-by-line notes on what FlowAtlas.jl + FlowWorkspace.jl do, for porting |
| [`docs/reference/paper-extract.md`](docs/reference/paper-extract.md) | Extracted text of the 2024 paper (results + discussion) |

## License

MIT.
