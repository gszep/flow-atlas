# Prior art (surveyed Sep 2026)

## Agent-native cytometry — nothing mature, nothing peer-reviewed

| Project | What | Relevance |
|---|---|---|
| [Oshawott324/datalox-flow-cyto-mcp](https://github.com/Oshawott324/datalox-flow-cyto-mcp) (TS, alpha, May 2026) | MCP server + compact gate editor. `FCS → flowcyto.workspace.json → MCP tools → plot UI → revision-safe JSON`. "Not a FlowJo replacement yet." | Closest design to ours. Read their tool schemas and `flowcyto.workspace.json` for possible interop. |
| [apacheco26/flow-gating-agent](https://github.com/apacheco26/flow-gating-agent) (Py, Aug 2026) | Human-in-the-loop copilot; FlowKit reproduces `.wsp` gating, validates gate-by-gate against FlowJo-exported counts with tolerances. | Steal the **validation methodology** for the Phase 2 FlowJo-parity harness. |
| [kainineo97/cytopilot-flow-cytometry-analysis-skill](https://github.com/kainineo97/cytopilot-flow-cytometry-analysis-skill) (Aug 2026) | Codex skill + JSON `analysis_report` validator; engine closed. | Example of an agent-facing report contract. |
| Europe PMC | No publications on LLM/agent-driven cytometry gating or analysis tools found. | Field is open; a paper on flow-atlas would be first. |

## Browser-native cytometry

| Project | Notes |
|---|---|
| [floreada.io](https://floreada.io) | Closed-source, free, 100% client-side FCS analysis. Proves the model; no API, no DR, not open. |
| [MorganConrad/fcs](https://github.com/MorganConrad/fcs) (JS, 19★, 2023) | Minimal FCS reader. Not maintained; write our own. |
| No WebGPU/WASM FCS, SOM, or EmbedSOM implementation exists on GitHub. | First-mover. |

## Open `.wsp` / Gating-ML implementations (references for porting)

| Project | Notes |
|---|---|
| [whitews/FlowKit](https://github.com/whitews/FlowKit) (Py, 225★, active) | Most complete open `.wsp` + Gating-ML 2.0 **reader**: all gate types, biex/logicle/hyperlog, boolean gates, compensation. FlowWorkspace.jl's biex is already a port of FlowKit's. **Primary reference.** |
| [RGLab/CytoML](https://github.com/RGLab/CytoML) (R) | Can **write** `.wsp` — reference for Phase 2 FlowJo export. |
| [LCSB-BioCore/GigaSOM.jl](https://github.com/LCSB-BioCore/GigaSOM.jl), [exaexa/EmbedSOM](https://github.com/exaexa/EmbedSOM) | Algorithms to port to WGSL. EmbedSOM paper: Kratochvíl et al., F1000Research 2019/2020. |
| [nsbuitrago/libreflow-api](https://github.com/nsbuitrago/libreflow-api) | Small FCS + Gating-ML API; note the "LibreFlow" name is taken. |

## Rendering / GPU in the browser

| Project | Notes |
|---|---|
| [flekschas/regl-scatterplot](https://github.com/flekschas/regl-scatterplot) (238★, WebGL2) | 10M+ points, lasso, categorical + continuous colour, spatial index. Mature but WebGL2 — would sit beside WebGPU compute. |
| deck.gl WebGPU backend ([demo](https://github.com/do-me/deck.gl-scatterplot-webgpu)) | Experimental. |
| Hand-rolled WebGPU points | Shares buffers with compute kernels; zero-copy. See HANDOFF open question 1. |
| Browser support | WebGPU: Chrome/Edge stable, Firefox 141+, Safari 26+. |
