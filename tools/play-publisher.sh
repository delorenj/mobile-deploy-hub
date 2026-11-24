#!/usr/bin/env bash
# Give one hub app a keyless Play publisher: a per-app service account that only
# that repo's GitHub Actions can impersonate (Workload Identity Federation), and
# the repo variables the hub's --play lane reads (GCP_WIF_PROVIDER, PLAY_SA_EMAIL,
# GCP_PROJECT_ID). Idempotent: rerunning repairs a partial setup.
#
#   tools/play-publisher.sh <owner/repo> [gcp-project]
#
# Default project: hub-play-publishers (one shared project, one provider + one SA
# per app). The last step is manual and printed at the end: invite the service
# account in Play Console > Users and permissions with release rights on the app.
# A brand-new Play app still needs its first bundle uploaded by hand in Console.
set -euo pipefail
repo="${1:?usage: play-publisher.sh <owner/repo> [gcp-project]}"
project="${2:-hub-play-publishers}"
slug="$(basename "$repo" | tr '[:upper:]_' '[:lower:]-' | cut -c1-32)"
sa_id="$(printf '%s' "$slug" | cut -c1-20)-play"
sa="${sa_id}@${project}.iam.gserviceaccount.com"
pool=github
provider="$(printf '%s' "$slug" | cut -c1-32)"

read -r repo_id owner_id < <(gh api "repos/$repo" --jq '"\(.id) \(.owner.id)"')

if ! gcloud projects describe "$project" >/dev/null 2>&1; then
  gcloud projects create "$project" --name="Hub Play publishers" >/dev/null
fi
number="$(gcloud projects describe "$project" --format='value(projectNumber)')"
gcloud services enable iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com androidpublisher.googleapis.com --project "$project" >/dev/null

gcloud iam workload-identity-pools describe "$pool" --location=global --project "$project" >/dev/null 2>&1 \
  || gcloud iam workload-identity-pools create "$pool" --location=global --project "$project" --display-name="GitHub Actions" >/dev/null

condition="assertion.repository_id == '${repo_id}' && assertion.repository_owner_id == '${owner_id}'"
mapping='google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id'
if gcloud iam workload-identity-pools providers describe "$provider" --workload-identity-pool="$pool" --location=global --project "$project" >/dev/null 2>&1; then
  gcloud iam workload-identity-pools providers update-oidc "$provider" --workload-identity-pool="$pool" --location=global --project "$project" \
    --attribute-mapping="$mapping" --attribute-condition="$condition" >/dev/null
else
  gcloud iam workload-identity-pools providers create-oidc "$provider" --workload-identity-pool="$pool" --location=global --project "$project" \
    --issuer-uri=https://token.actions.githubusercontent.com --attribute-mapping="$mapping" --attribute-condition="$condition" >/dev/null
fi

gcloud iam service-accounts describe "$sa" --project "$project" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$sa_id" --project "$project" --display-name="Play publisher: $repo" >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$sa" --project "$project" --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${number}/locations/global/workloadIdentityPools/${pool}/attribute.repository_id/${repo_id}" >/dev/null
# The operator can mint a token locally to verify Play access (and do a one-off reconcile).
me="$(gcloud config get-value account 2>/dev/null)"
[ -n "$me" ] && gcloud iam service-accounts add-iam-policy-binding "$sa" --project "$project" --role=roles/iam.serviceAccountTokenCreator --member="user:$me" >/dev/null

wif="projects/${number}/locations/global/workloadIdentityPools/${pool}/providers/${provider}"
gh variable set GCP_WIF_PROVIDER -R "$repo" --body "$wif"
gh variable set PLAY_SA_EMAIL -R "$repo" --body "$sa"
gh variable set GCP_PROJECT_ID -R "$repo" --body "$project"

cat <<EOF
PLAY_PUBLISHER_READY $repo
  provider  $wif
  account   $sa
Last step (Play Console, once): Users and permissions > Invite new users > $sa,
App permissions > the app > Release to testing tracks + Release to production + Manage testing tracks.
Check: gcloud auth print-access-token --impersonate-service-account=$sa, then GET
https://androidpublisher.googleapis.com/androidpublisher/v3/applications/<package>/edits (POST) answers 200.
EOF
