#!/usr/bin/env bash
# One-time operator bootstrap. GitHub deployments subsequently use OIDC, not this login.
set -euo pipefail

: "${GCLOUD_CONFIGURATION:?Set GCLOUD_CONFIGURATION to the intended named gcloud configuration}"
project=ninth-iris-405514
repo=gszep/flow-atlas
pool=flow-atlas-github
provider=github
account_id=flow-atlas-demo-deploy
account="$account_id@$project.iam.gserviceaccount.com"
common=(--configuration="$GCLOUD_CONFIGURATION" --project="$project" --quiet)

# Check operator authorization before changing any cloud resources. No token is printed.
number=$(gcloud "${common[@]}" projects describe "$project" --format='value(projectNumber)')
repo_id=$(gh api "repos/$repo" --jq '.id')
owner_id=$(gh api "repos/$repo" --jq '.owner.id')
workflow="$repo/.github/workflows/ci.yml@refs/heads/main"
condition="assertion.repository_id == '$repo_id' && assertion.repository_owner_id == '$owner_id' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref == '$workflow'"
mapping='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref'

gcloud "${common[@]}" services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

if ! gcloud "${common[@]}" iam service-accounts describe "$account" >/dev/null 2>&1; then
  gcloud "${common[@]}" iam service-accounts create "$account_id" --display-name='FlowAtlas GitHub deployer'
fi

if ! gcloud "${common[@]}" iam workload-identity-pools describe "$pool" --location=global >/dev/null 2>&1; then
  gcloud "${common[@]}" iam workload-identity-pools create "$pool" --location=global --display-name='FlowAtlas GitHub Actions'
fi

if gcloud "${common[@]}" iam workload-identity-pools providers describe "$provider" --location=global --workload-identity-pool="$pool" >/dev/null 2>&1; then
  existing=$(gcloud "${common[@]}" iam workload-identity-pools providers describe "$provider" --location=global --workload-identity-pool="$pool" --format='value(attributeCondition)')
  if [ "$existing" != "$condition" ]; then
    echo 'Existing provider has a different trust condition. Inspect it before changing it.' >&2
    exit 1
  fi
else
  gcloud "${common[@]}" iam workload-identity-pools providers create-oidc "$provider" \
    --location=global --workload-identity-pool="$pool" \
    --display-name='FlowAtlas main workflow' \
    --issuer-uri=https://token.actions.githubusercontent.com \
    --attribute-mapping="$mapping" --attribute-condition="$condition"
fi

principal="principalSet://iam.googleapis.com/projects/$number/locations/global/workloadIdentityPools/$pool/attribute.repository_id/$repo_id"
gcloud "${common[@]}" iam service-accounts add-iam-policy-binding "$account" \
  --member="$principal" --role=roles/iam.workloadIdentityUser --format=none

# Documented source-deployment permissions; runtime/build impersonation is app-scoped.
for role in roles/run.sourceDeveloper roles/serviceusage.serviceUsageConsumer; do
  gcloud "${common[@]}" projects add-iam-policy-binding "$project" \
    --member="serviceAccount:$account" --role="$role" --condition=None --format=none
done
for target in flow-atlas-demo-runtime flow-atlas-demo-build; do
  gcloud "${common[@]}" iam service-accounts add-iam-policy-binding "$target@$project.iam.gserviceaccount.com" \
    --member="serviceAccount:$account" --role=roles/iam.serviceAccountUser --format=none
done

full_provider="projects/$number/locations/global/workloadIdentityPools/$pool/providers/$provider"
gh variable set FLOW_GCP_WIF_PROVIDER --repo "$repo" --body "$full_provider"
gh variable set FLOW_GCP_DEPLOY_ACCOUNT --repo "$repo" --body "$account"
printf 'Configured keyless deployment for %s main via %s\n' "$repo" "$account"
printf 'IAM propagation can take several minutes. Verify a complete GitHub deployment next.\n'
