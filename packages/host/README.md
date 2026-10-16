# Studio analysis transport

Node 24, injectable backend, no analysis implementation in this adapter:

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
random token outside this adapter and distribute it only to authorized clients.
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

This scaffold does not implement shared Yjs state, journaling, human provenance,
spectral unmixing, or a CPU fallback. Optional `webgpu@0.6.0` and workspace
compute/fcs/model dependencies are wiring for the separately supplied backend.
No runnable bin is exported until the studio composition entrypoint exists.
