# Agent-first studio: native FCS workflows

The Node 24 studio exposes one shared analysis backend through MCP and JSON-RPC.
It imports FCS artifacts, inspects bounded metadata/event pages, validates and
applies conventional compensation on WebGPU, and writes new FCS files in chunks.
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

## Numerical and artifact contracts

- FCS list-mode 2.0/3.0/3.1 input, strict UTF-8 TEXT, and F/I/D decoding to F32.
  Raw means stored numeric values: acquisition gain, logarithmic amplification,
  and time scaling are not silently applied. F64/I64 conversion is not lossless.
- Conventional square spillover uses `measured = true × spill`. Both inversion
  and event arithmetic run on WebGPU. Singular/nonfinite/unsafe matrices reject
  with diagnostics. This does not claim native FlowJo parity, spectral OLS/WLS,
  correction-matrix equivalence, or automatic acquisition/precompensation inference.
- Compensation participants and exported channels must be linear and unit-gain.
  Unsupported scaling is an explicit capability error. Negative and above-range
  compensated values remain valid; they are not clamped.
- Export is explicitly FCS3.1 F32 little-endian. Compensated exports strip active
  spillover aliases and retain the matrix in their receipt. Raw exports preserve
  a complete explicit matrix, including renamed parameter identities.
- Inputs are content-addressed snapshots under `.flow-atlas/inputs`. Replaced
  source files cannot silently change already imported samples. Export rechecks
  the snapshot hash. Input artifacts, outputs and receipts are retained on disk;
  no automatic disk eviction/quota is implemented in this wave.
- Default decoded chunks are 4 MiB; configurable range is 1 KiB–64 MiB. Encoded
  plus decoded source chunks also respect 128 MiB. No whole-file event array or
  serialized event payload enters the workspace document.
- There is one export job at a time, at most 16 queued jobs/active API calls,
  32 cached full sample metadata records, a 4096-entry session sample catalog,
  128 registered compensation definitions, and 128 retained terminal job objects.
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
eleven operations in exported `operationSchemas`. `AnalysisError(code, message,
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
