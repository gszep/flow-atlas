# Lessons from `decks` (human UI + agent MCP collaborative editing)

Reference: `~/Documents/repos/decks` (gszep). Files worth reading in order: `AGENTS.md`, `README.md`,
`docs/research-realtime-collaboration.md`, `engine/collaboration.mjs`, `engine/mcp.mjs`,
`engine/editor/collaboration.ts`, `engine/editor/tools/README.md`, `.pi/extensions/decks-mcp.ts`.

## Architecture patterns to import

### 1. Readable source is ground truth; live state is operational; derived output is disposable
decks: HTML/CSS/catalogs are truth (git), Yjs binary under `.history/` is merge state, `dist/` PDFs are rebuilt.
flow-atlas mapping:

| Layer | decks | flow-atlas |
|---|---|---|
| Ground truth (git-diffable) | `slides/*.html`, `i18n/*.js`, `deck.json` | `workspace.flowatlas.json` — samples (by path + content hash), channels, transforms, compensation, gate DAG, groups, colours, annotations. Never event data. |
| Immutable inputs | — | `.fcs` files (referenced by hash; never copied into the document) |
| Operational merge state | `.history/collaboration.bin` (Yjs) | same: Yjs doc holding the workspace document; presence in Awareness only |
| Derived / cache | `dist/*.pdf`, QA PNGs | SOM codebook, embedding coordinates, label bitmasks, histograms → OPFS / `.cache/`, keyed by hash(inputs + params). Rebuilt on demand, gitignored. |

Rules to copy verbatim: every accepted collaborative transaction **materialises atomically** to the JSON file; on restart the binary state is restored *then* the source file is re-imported so edits made while the server was down (agent, git, hand edit) remain authoritative; `fs.watch` on the source file imports external edits live into open UIs.

### 2. Same document API for humans and agents (Penpot pattern)
`engine/mcp.mjs` is 52 lines: the MCP server is a thin adapter over the *same* functions the editor HTTP routes call (`updateCatalogText`). No second code path, no browser scraping. Do the same: `@flow-atlas/model` exposes typed operations; the UI, the MCP tools, and tests all call them.

### 3. Optimistic concurrency + human-finalised protection on every agent write
`update_catalog_text({key, value, expectedCurrent})` rejects if the current value differs ("read again") and rejects outright if the key carries human provenance. Import both:
- every mutating MCP tool takes `expectedRevision` (document-level) or `expectedCurrent` (field-level);
- gates/annotations touched by a human in the UI get `{author, modified}` stamps written **only by the UI**; agents may not move/delete/rename a human-finalised gate without the human doing it in the UI. Agent edits are attributed by identity but never get a human stamp.

### 4. Deliberately tiny MCP surface, server-side authorisation per tool
Three tools in decks. Authorisation (`decks:write` scope, document role) is checked inside the tool handler, never in prompts. Human, agent, and the delegating human are distinct principals in audit logs. Keep our v0 surface small (see `architecture.md`) and grow it from real agent sessions.

### 5. Hot-reloadable, single-file, dependency-free editor tools
`engine/editor/tools/*.js` → dropped in, loaded live in every open editor, `dispose()` on replace, `__`-prefixed scaffolding is stripped on save so ephemeral tools cannot leak into ground truth. This is the "ask an agent to build me a tool" loop and maps beautifully onto cytometry: an agent writes a one-shot tool (custom plot, QC check, gate suggestion overlay) against a stable harness API (`h.selection`, `h.gates`, `h.stats(...)`, `h.overlay(...)`), the human runs/reviews it, then it's deleted. Design the harness API early; it's also what the agent sees through MCP `snapshot`.

### 6. Rolling local journal + revert
`.history/journal.ndjson` records `{via: ui|cli|agent, author, file, before, after}` for every non-null edit; the UI shows a per-slide timeline and can revert one entry. Git stays the durable history. For us: journal per workspace document op (gate moved, colour changed, population renamed) with `via` + author; revert re-applies the inverse op.

### 7. `AGENTS.md` as a contract, with machine-checkable rules
Short, imperative, explains *why*. `guidance.json` holds checkable rules; `distill.mjs` mines human edits to propose rule changes. For flow-atlas: `AGENTS.md` from day one (e.g. "never edit `.cache/`", "never write human provenance stamps", "gates are in raw channel space; transforms are display-only", "verify visually via `snapshot` after gating").

### 8. Pi has no MCP client → project-local pi extension
`.pi/extensions/decks-mcp.ts` wraps each MCP tool as a pi tool (`pi.registerTool`) with a `documentId` param and handles auth. Ship `.pi/extensions/flow-atlas-mcp.ts` in this repo so a pi agent can drive the app immediately; Claude Desktop/Cursor/Codex use the MCP endpoint directly.

### 9. Test principles (copy the list)
Two isolated clients converge; presence never persists; acknowledged edits survive reload/restart; reconnect neither duplicates nor loses; materialised source == live doc; no-op edits create no history; auth fails closed. Playwright with separate browser contexts; poll for convergence, no fixed sleeps. Plus, for us: numeric parity tests against the Julia fixtures.

### 10. Dependency discipline
Core zero-dependency where possible; optional tooling pinned, audited, MIT, lockfile, served locally (no CDN). Stack that is proven in decks and directly reusable: **yjs 13.6, @hocuspocus/server + provider 4.5, @modelcontextprotocol/server 2.0 + zod 4, esbuild, Playwright**. Stable opaque `documentId` in the manifest; mutable title is metadata, so renaming never breaks URLs.

## The tension to resolve: server vs zero-install

decks *requires* a Node process (Hocuspocus WebSocket + HTTP + MCP). flow-atlas decided "zero-install, all client-side, no CLI, only an MCP server outside the browser". Reconcile as two modes of one codebase:

| Mode | Process | Collaboration | Agents |
|---|---|---|---|
| **Solo** (open the static URL) | none | local only; document in OPFS + download/upload of `workspace.flowatlas.json` | none (or agent edits the JSON file offline and the user re-imports) |
| **Studio** (`npx flow-atlas` in a project dir) | one Node 24 process: serves the same static app, Hocuspocus room per document, journal, `fs.watch`, MCP at `/mcp/d/<documentId>` | multi-human via Yjs | MCP tools mutate the same Yjs doc |

So the "MCP server" *is* the studio host — a single process, not a CLI with subcommands. That is consistent with the earlier decision.

**Compute placement.** WebGPU lives in the browser tab. Agent tools that need numbers (`stats`, `count`, `region_stats`, `embed`) must therefore be fulfilled by a connected tab: the host forwards a compute request over the same WebSocket, a tab executes it on the GPU and replies. If no tab is connected the tool returns a clear error ("open the workspace in a browser"). Alternative — Node-side WebGPU (Dawn bindings) in the host — keeps agents working headless; evaluate but don't block Phase 1 on it. Either way the *document* ops (draw gate, rename, recolour) never need the GPU and always work.

**What goes in the CRDT.** Only the workspace document (KB–MB). Never event data, embeddings, or bitmasks — those are cache keyed by content hash, and each client recomputes or loads from its own OPFS.

## Concrete additions to the plan
- `packages/model`: Yjs-backed document with typed ops + materialiser to `workspace.flowatlas.json` + journal.
- `packages/host` (rename of `mcp`): Hocuspocus + static + MCP + compute-forwarding to tabs; the single non-browser entry point.
- `packages/ui/tools/`: hot-reloadable tool contract, `__` scaffolding rule.
- `AGENTS.md`, `.pi/extensions/flow-atlas-mcp.ts`.
- Provenance: `{author, modified}` on gates/annotations/colours, UI-only writes; MCP writes carry `expectedRevision`.
