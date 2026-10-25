# Flow Atlas delivery and acceptance

The explicitly authorized public browser presentation is documented separately in
[`PUBLIC_DEMO.md`](PUBLIC_DEMO.md). It hosts static UI assets and synthetic example
data, not the local studio's analysis API or private experiments.

## Applicable surface

The documented agent-facing application is the repository-built **Node 24 local
studio** in `packages/host`, started with an explicit experiment root. It serves
MCP and JSON-RPC on loopback; built browser assets are optional. The repository
has a validation workflow in `.github/workflows/ci.yml`. Public static-demo hosting
does not imply a cloud deployment of this local analysis service or a package-registry
release workflow. Package version `0.0.0` is
not sufficient to distinguish delivered builds.

For host changes, delivery closes at a runnable local build with **actual served
process acceptance**. `packages/host/test-built/smoke.mjs` starts the compiled
studio, consumes it over authenticated RPC and MCP, runs synthetic FCS workflows,
submits a workspace count job over MCP and observes it over RPC, then closes clients, drains the process and
removes its owned experiment. Its final JSON identifies `servedBuildId`, API
version, Node version and accepted endpoint paths. A successful process exit is
required in addition to the JSON success record.

Persistent operator instances require an explicit service/experiment-root binding.
When such a binding exists, upgrade that documented instance, retain rollback,
and accept the version served by its endpoint. An isolated acceptance instance
must not be reported as a still-running operator deployment. The local studio's
per-experiment launch workflow does not imply creating a cloud service or choosing
an arbitrary user experiment for a persistent daemon.

## Completion sequence

1. Implement/review within the authorized scope in an isolated checkout. Run the
   repository-required checks and any affected executable-documentation/protocol
   checks with bounded concurrency and owned cleanup.
2. Commit/push the feature branch and verify **final-head** CI. Merge through the
   normal protected-branch flow; record the merge commit and evidence.
3. Select the merged revision in the isolated checkout. Build once and retain the
   resulting artifacts. Unchanged artifacts may be reused only when their exact
   source/dependency fingerprint and bundle hashes match the selected revision.
4. Launch and consume the applicable local application surface. For host work:

   ```sh
   pnpm typecheck
   pnpm --filter @flow-atlas/host build
   pnpm --filter @flow-atlas/host test:built
   ```

   The last command performs real compiled-process acceptance; it is not just a
   source-unit test. For UI changes, also build the affected UI and validate the
   browser workflow/assets served by the intended studio or static local target.
5. Report the merged source commit, actual served build fingerprint, endpoint
   acceptance, cleanup/live-instance status and rollback anchor. State actual
   failures or missing deployment bindings rather than substituting a fabricated
   target or treating pending CI as acceptance.

## Identity and evidence

The studio's `list_capabilities` response exposes a build fingerprint derived from
versioned runtime sources, host build configuration, package metadata and lockfile.
Acceptance compares the fingerprint received over RPC and MCP and with generated
receipts. Keep that identity alongside the source commit, bundle SHA-256 hashes,
lockfile hash, command exit statuses, logs and timing/resource records.

Runtime/dependency changes require rebuilding and accepting the changed artifact.
Documentation-only source commits can have the same runtime fingerprint. This is
expected: the report distinguishes checkout identity from consumed runtime identity.
Scientific tests and numerical limitations remain separate from delivery authority;
deployment does not establish untested vendor parity or change physical/data gates.

## Rollback

Before replacing an accepted artifact or bound running instance, retain its source
commit, dependency-lock hash, build fingerprint and built bundles with content hashes.
Keep any bundle archive outside the versioned source tree; never include experiment
data, access tokens or connection files in it.

For this source-based application, reproduce rollback from the recorded commit in
another isolated checkout, install its pinned dependencies, and build/accept that
revision before switching the bound instance. A preserved bundle can be restored
into a matching checkout/dependency layout; its external SDK/native dependencies
must match the recorded lockfile. Do not overwrite unrelated work or remove user
inputs, output artifacts or workspace documents as part of rollback.

Local acceptance processes use disposable synthetic roots and are shut down after
verification. Their rollback anchor records the prior accepted build even when
the delivery change only improves reporting and leaves runtime inputs unchanged.
