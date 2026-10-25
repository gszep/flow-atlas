# Public browser demo

The user-authorized public presentation surface is `https://flow.gszep.com`.
It serves the browser prototype and the user-authorized publication companion dataset, with current
capabilities separated from the proposed collective Verification/Discovery workflow.
This is separate from the local agent studio described in `DELIVERY.md`.

## Publication boundary

- Publish only the built `packages/ui/dist` assets and release metadata through
  the dedicated static server. Build the UI once and stage an explicit file list.
- Publish only the exact companion WSP/FCS files pinned by the publication
  manifest, through the explicit publication staging option. Original files remain
  unchanged and outside Git. Do not copy other local oracle files, acquired corpora,
  experiments, tokens or the host's RPC/MCP service. User-selected files remain in
  their browser. The optional synthetic example is only a technical diagnostic.
- The existing browser pipeline is a visualization prototype, not a view of a
  host analysis receipt. Neither its plots nor the companion/synthetic examples establish
  FlowJo fidelity, biological accuracy or collective-review effectiveness.
- Keep the planned review/community workflow visibly distinct from working UI.
  WebGPU is required for the interactive computation; no CPU fallback is added.

## Hosting

Use the existing Sites Cloud Run / Cloud DNS route, as requested by the user:

| Resource | Binding |
|---|---|
| Project | `ninth-iris-405514` |
| Region | `europe-west1` |
| Service | `flow-atlas-demo` |
| Runtime service account | `flow-atlas-demo-runtime@ninth-iris-405514.iam.gserviceaccount.com` |
| Build service account | `flow-atlas-demo-build@ninth-iris-405514.iam.gserviceaccount.com` |
| DNS zone | `gszep-com` |
| DNS record | `flow.gszep.com. CNAME ghs.googlehosted.com.` |

The runtime identity has no project roles. The build identity uses the standard
`roles/run.builder` role for source deployment. No keys are created or downloaded.
Deploy with no minimum instances, at most one instance, one CPU and 256 MiB memory.
The public static service uses the invoker-IAM-check setting, following the existing
site pattern; this does not grant public access to other services or datasets.
Account/configuration bindings remain in private operator configuration.

## Build and stage

```sh
pnpm --filter @flow-atlas/ui build
node --test --test-concurrency=1 deploy/static-server.test.mjs
node deploy/prepare.mjs "$PACKAGE_DIR" --revision "$(git rev-parse HEAD)" \
  --publication-root "$PUBLICATION_ROOT"
```

`PACKAGE_DIR` must be an invocation-owned empty destination outside the checkout.
The staging command does not rebuild by default. It verifies the file set, byte
sizes and hashes and emits `release.json`; deploy only a clean, reviewed source
revision. The staged package starts with `npm start` and contains no external
runtime dependencies. The Cloud Run source build uses its Node 24 buildpack.

The publication variant additionally stages the exact manifest-listed files from
an explicitly supplied source directory. Per-file hashes and sizes must match;
unlisted data remain excluded. The companion snapshot has 33 FCS files containing
3,885,530 events (290,739,412 FCS bytes) and a 5,102,255-byte WSP. The paper describes
32 files; label the loaded companion version and its actual counts explicitly.
Large data responses must stream rather than buffer whole files in the server.
All loaded events are projected/rendered; any codebook-training limit is a separate
displayed setting and is not a claim to reproduce the paper's embedding.
`PUBLICATION_ROOT` is an explicitly supplied private source-directory binding,
never an automatically scanned corpus or a path embedded in the public manifest.
Omit the publication option only for a code-only package.

`?publication` starts the complete companion load. `?publication&training=all`
uses every loaded event per SOM training epoch; the alternative caps training at
100,000. Both use a 20-by-20 SOM, ten epochs and seed 42, then project all events
with EmbedSOM. Initialization statistics remain strided and are disclosed. The
computation summary reports wall-clock phases with queue completion, not isolated
GPU timestamps; uninstrumented memory/utilization fields remain unknown.

From that staged package, the authorized operator uses the approved named gcloud
configuration and project binding:

```sh
gcloud run deploy flow-atlas-demo --source "$PACKAGE_DIR" \
  --project ninth-iris-405514 --region europe-west1 \
  --no-invoker-iam-check --port 8080 --memory 256Mi --cpu 1 \
  --min-instances 0 --max-instances 1 \
  --service-account flow-atlas-demo-runtime@ninth-iris-405514.iam.gserviceaccount.com \
  --build-service-account projects/ninth-iris-405514/serviceAccounts/flow-atlas-demo-build@ninth-iris-405514.iam.gserviceaccount.com
```

Use the service's managed domain mapping to obtain/verify DNS records rather than
changing any existing site's mapping. Google-managed TLS activation is a separate
acceptance condition from a successful Cloud Run deployment.

## Acceptance and rollback

Before publishing, run the affected UI build/typecheck, scoped checks and visual
QA of the synthetic load, legend/colour controls, responsive layout and unsupported
WebGPU message. Confirm that the staged package contains only intended public files.
Follow the normal branch/review/CI/merge flow; deploy the accepted source revision.

After deployment, verify the Cloud Run URL and the custom-domain HTTPS URL without
disabling certificate verification. Check the served release identity and assets,
and exercise the synthetic example in a real WebGPU browser. Record exact source,
Cloud Run revision/image identity, domain/TLS status, checks and limitations.

Cloud Run preserves prior revisions. For an update, capture the currently serving
revision and restore its traffic if acceptance fails. For the first deployment,
there is no prior demo revision; report any incomplete domain/TLS activation rather
than claiming the requested URL is live. Do not alter other subdomains/services.
