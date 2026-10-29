# Interactive population demo

## Walkthrough

1. Open the publication map. Existing full-data caching and live point navigation remain.
2. Choose **Lasso**, draw a region, and inspect the twenty channel distributions.
3. Name the selection and save it. Original channel identifiers appear alongside marker names.
4. The in-page agent connects automatically with a bounded guest session. No access
   code, private launch link or model-provider login is required.
5. Type or dictate a request. Dictation is editable and is never automatically submitted.
   Ask the agent to compare populations, create candidates or propose a refinement.
6. Inspect the real tool activity and the new population cards. Hover/click to highlight
   cells and inspect distributions; rename, accept or remove suggestions.
7. **Reset demo** clears population/conversation state, stops work/recording and revokes
   the shared session. Reload creates fresh local demo state. **Clear cached data and
   reload** also clears only FlowAtlas's owned IndexedDB entries after pending writes drain.

Human and accepted populations cannot be renamed or removed by agent tools. Refinements
are new selections with an explicit parent reference. These exploratory embedding/display
selections are not raw-channel gates, and suggested biological names are not validated identities.
Reference selections use existing imported WSP annotations; their reuse is not de novo discovery.

## Distribution and state contract

All membership, finite-value extrema/counts and 128-bin histogram accumulation execute
on WebGPU over all events, in bounded windows. Missing channels/nonfinite values are
reported, not filled with zeros. Violin shapes are visualized histograms; the reported
medians are approximate bin estimates. Values are the existing per-sample display-transformed
channels, not raw fluorescence units or an additional compensation/unmixing claim.
Each violin's axis shows its own min/max. Exact raw-value statistics remain a separate workflow.

Selections are definition-only in-memory objects bound to the current dataset/embedding
identity. GPU masks are temporary and serialized rather than retained per population.
Named-population mutations require `expectedRevision`; old asynchronous analyses cannot
overwrite later edits. There is no persistent community workspace or cross-browser document
database in this demo. Camera motion remains live point rendering, not raster preview tiles.

## Agent and MCP

The backend calls the existing Claude Cloudflare Worker's Messages subset. It uses the
configured fast model, a fixed tool allowlist, bounded history/output, automatic tool
choice and explicitly disabled thinking. It normalizes direct tool-caller metadata and
rejects truncated/refused/invalid tool responses. Only aggregate summaries go to the model.
Browser code executes the validated tools and displays their actual results; there is no
generated-code execution or arbitrary network/filesystem tool.

An unfinished lasso is preserved automatically when asking the agent to act. Routine
reversible proposal/view actions proceed without a second permission question. The
`combine_populations` tool forms a deduplicated GPU union; creation and combination
show/frame their result and return display state. `inspect_view` reports the current
renderer frame, camera and displayed layers. Coloured proposals remain visible together,
with selected overlays in front of grey context points.

`Copy MCP connection` gives a session-scoped Streamable HTTP connection to
`/api/demo/mcp`. The same ten tools execute through the connected browser. External
MCP requires that browser to remain open. Stop/reset/reconnect invalidates old polling,
commands have deadlines and cancellation checks, and mutations check their command lease
again after analysis. Results are not reported as complete when acknowledgment fails.
Transport failure after a mutation can leave an uncertain outcome: inspect state before
retrying, rather than automatically repeating a write.

Every imported reference now has an inspectable `ref:<index>` identifier. Reference
indices and exact unambiguous names also resolve. `inspect_population` can inspect
`all` or compute overlap via `within=<population id>`; `create_population` uses that
same `within` argument for actual GPU intersection membership. `refines` alone is
provenance and permits an expanded correction. Selecting a population can frame
its measured embedding bounds. Marker interpretation should compare measured
profiles/overlaps, not infer purity or positivity from arbitrary transformed medians.

Runtime configuration (secret values must come from the backend secret store):

| Variable | Purpose |
|---|---|
| `FLOW_CLAUDE_WORKER_URL` | Verified HTTPS origin, no path or query |
| `FLOW_CLAUDE_WORKER_TOKEN` | Backend-only application credential |
| `FLOW_CLAUDE_MODEL` | Full supported model ID; tested here with `claude-haiku-5-5` |
| `FLOW_DEMO_ORIGIN` | Exact browser origin for Origin validation |
| `FLOW_DEEPGRAM_WORKER_URL` | Verified Kotoleaf HTTPS origin |
| `FLOW_DEEPGRAM_WORKER_TOKEN` | Current shared dictation credential, backend only |
| `FLOW_DICTATION_ENABLED` | Set to `false` to disable dictation ticket issuance |
| `FLOW_TRUST_PROXY_HOPS` | `1` only behind the configured trusted platform proxy; otherwise use peer IP |

One instance is required for the process-local session/command state. Sessions expire after
one hour; there are at most 64, with at most eight outstanding per visitor IP. Model calls
are capped at two concurrently and one per session, with a sixty-call session budget and
per-IP caps of twenty/minute and 120/hour. Upstream credentials are not
logged. Origin checks, body limits, fixed upstream origins and typed tools remain required.

## EN/JA dictation

FlowAtlas uses the Kotoleaf Cloudflare Worker, not browser SpeechRecognition. A one-use,
thirty-second ticket authorizes a same-origin browser WebSocket via its subprotocol header.
The backend attaches the private Worker Authorization header. No long-lived upstream token
is present in the page, URL or frontend bundle.

AudioWorklet converts mono microphone input to 16 kHz PCM16 in 100 ms frames. Input at other
sample rates is resampled with bounded state. Audio starts only after the relay is ready;
stopping flushes the tail, sends Finalize/CloseStream and waits briefly for final text.
Cancellation/reset stops tracks, nodes, context, socket and timers. The transcript is editable
before the user submits it to the model.

Every upstream stream includes `store=false` and `mip_opt_out=true`. The former disables
Kotoleaf meeting/transcript storage for FlowAtlas only; it does not assert that no processing
occurs at Deepgram. The latter opts out of Deepgram model-improvement use. Other applications
using the shared Worker/token retain their own policies.

FlowAtlas limits admission independently of the shared Worker:
- Per visitor IP: 360 demo-API requests/minute, 10 session creations/minute,
  6 dictation starts/minute and 30/hour, across sessions.
- Per session: 12 dictation starts and one active speech stream.
- Per instance: two active speech streams; maximum 90 seconds each; audio/frame,
  byte-rate and queued-byte caps. The browser stops recording at 60 seconds.

These are in-memory admission controls, not a durable financial spending cap; restarts
reset counters and rolling revisions can overlap. A missing/expired ticket, wrong Origin/IP,
replay, overload or disabled relay fails closed. Do not trust arbitrary client-supplied
forwarding headers; configure and verify the platform proxy boundary before enabling it.

To shut off new dictation admissions, update the service's `FLOW_DICTATION_ENABLED=false`
configuration. Existing streams remain bounded by their deadline and close on instance
shutdown. This does not alter the shared Kotoleaf Worker or throttle other applications.

## Acceptance evidence

Tests cover membership/histograms, source/target ownership, revision guards, actor protections,
client tool roundtrips, cancellation/reconnection, API isolation/limits and WebSocket transport.
Native-browser testing exercises actual lasso distributions, the live Claude Worker, MCP
state sharing and reset. Browser audio acceptance uses synthetic EN/JA speech through a real
MediaStream, AudioWorklet and the live relay/Worker; it does not prove physical microphone
quality, actual-phone performance, or long-session recognition accuracy.
