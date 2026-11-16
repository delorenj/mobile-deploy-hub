# iOS Actions-history transport proof

The iOS reusable job declares `contents: read` and `actions: read`. Its execution
step supplies `${{ github.token }}` as the composite action's `github_token`, then
`GH_TOKEN`. The caller must already grant Actions read: a reusable job cannot
raise that ceiling. Ordinary app hooks have GitHub credentials removed; only a
real TestFlight `ios.store.upload` hook receives this ephemeral token. Missing
job tokens fail before native/device/store work. No saved `gh` login or new
secret is required.

## What the dry-run diagnostic proves

A TestFlight dry run does **not** invoke `ios.store.upload`. On attempt 2 or later,
the same iOS execution step uses the upload hook's environment construction and
runner user for read-only `gh api` requests. The probe passes only PATH, GH_TOKEN
and GH_HOST to `gh`, excluding HOME and saved-login configuration. It reads the
current run identity, then every earlier attempt's complete paginated jobs list
and its returned step records. If the list omits the optional `steps` property,
it fetches that job's detail; absence is not assumed to mean zero steps.

`HUB_IOS_HISTORY_TRANSPORT_READ` with `proof: "transport-only"` means authenticated
same-run history was completely enumerated within the probe's bounds (at most
1000 attempts and 1000 pages per attempt). The JSON lists attempt, job id/name,
status/conclusion and step number/name/status/conclusion. Missing/denied reads,
invalid identities, inconsistent totals, missing pages, duplicates and malformed
job/step records fail the read proof. An explicitly empty complete list can pass
transport, but cannot supply the operational evidence of an earlier Mac job.
Failure is logged as
`HUB_IOS_HISTORY_TRANSPORT_REFUSED`; provider error bodies and token values are
not logged or persisted.

This is **not upload eligibility or safe-to-upload proof**. It neither requires a
particular job/step name or outcome nor interprets runner assignment. Cancelled
before runner, skipped with contradictory runner metadata, executing, failed and
successful jobs are all readable history. Their upload significance belongs to
the app's guard. The probe does not certify that an upload never happened. The
production hook still owns its complete fail-closed retry/provider reconciliation
checks; the hub does not duplicate or weaken them. Fixture subprocess tests prove
token delivery through the hub's actual bash/Node upload-hook launcher, not a real
Apple upload or Mac job-token read.

## Operational proof after reviewed normal release

Do not run this procedure from a feature branch or before the reviewed hub release
is published. The release owner first uses the normal clean-main
`mise run release -- X.Y.Z` process, records the version tag and peeled `v1`
commit, and retains all app release dry-run receipts. Those ordinary dry runs do
not opt into TestFlight and cannot establish this diagnostic's runner proof.
No extra release policy or automatic rerun is introduced for this check.

When authorized, run the following from the **game's existing production front
door** on a host with `mise`, `gh`, Python and access to that checkout. The Mac must
be available and actually run `deploy / ios`; a skipped/offline lane is HOLD.
`--dry-handoff true` also exercises the ordinary native dry build, but does not
upload, assign, install, publish or spend a version. This creates a **new dry run**
and reruns only the id captured from that invocation. Never substitute the old
0.3.25/build 11 run, an arbitrary latest run, `ship`, a real deploy, or a manually
invoked upload hook.

```bash
set -euo pipefail
cd /home/delorenj/code/tolt/tower-of-lost-things
proof_dir="$(mktemp -d "${TMPDIR:?profile scratch required}/tolt137-mac-proof.XXXXXX")"
export proof_dir
mise run deploy --platform ios --dry-run true --testflight true --dry-handoff true \
  | tee "$proof_dir/first.log"
NEW_DRY_RUN_ID="$(python3 -c 'import os,re,pathlib; text=pathlib.Path(os.environ["proof_dir"],"first.log").read_text(); ids=re.findall(r"^DEPLOY_RUN ([0-9]+) https://github.com/delorenj/tower-of-lost-things/actions/runs/[0-9]+$",text,re.M); assert len(ids)==1, "need exactly one fresh front-door run"; print(ids[0])')"
export NEW_DRY_RUN_ID
gh api "repos/delorenj/tower-of-lost-things/actions/runs/$NEW_DRY_RUN_ID" \
  > "$proof_dir/first-run.json"
python3 -c 'import json,os,pathlib; r=json.loads(pathlib.Path(os.environ["proof_dir"],"first-run.json").read_text()); assert str(r["id"])==os.environ["NEW_DRY_RUN_ID"] and r["event"]=="workflow_dispatch" and r["display_title"].startswith("Deploy (dry run)") and r["run_attempt"]==1 and r["conclusion"]=="success", "not a fresh successful dry run"'
# All jobs, not --failed: a green first attempt has no failed jobs to rerun.
gh run rerun "$NEW_DRY_RUN_ID" --repo delorenj/tower-of-lost-things
gh run watch "$NEW_DRY_RUN_ID" --repo delorenj/tower-of-lost-things --interval 30 --exit-status
gh api "repos/delorenj/tower-of-lost-things/actions/runs/$NEW_DRY_RUN_ID" \
  > "$proof_dir/rerun.json"
gh api --paginate --slurp \
  "repos/delorenj/tower-of-lost-things/actions/runs/$NEW_DRY_RUN_ID/attempts/1/jobs?per_page=100" \
  > "$proof_dir/prior-jobs.json"
gh run view "$NEW_DRY_RUN_ID" --repo delorenj/tower-of-lost-things --attempt 2 --log \
  > "$proof_dir/attempt-2.log"
python3 -c 'import json,os,pathlib; p=pathlib.Path(os.environ["proof_dir"]); r=json.loads((p/"rerun.json").read_text()); log=(p/"attempt-2.log").read_text(); assert r["run_attempt"]==2 and r["conclusion"]=="success"; assert "HUB_IOS_HISTORY_TRANSPORT_READ " in log and "HUB_IOS_HISTORY_TRANSPORT_REFUSED " not in log; print(r["html_url"]); print("transport-only; verify consumed hub revision and Mac job/step links before acceptance")'
```

Retain the fresh run URL, both attempts' Mac job URLs, execution-step logs and
`referenced_workflows` SHAs from the run JSON; compare the reusable-workflow SHA
and inner composite pin with the reviewed published release. Confirm gate output
`testflight=true`, the Mac execution step really ran, and the transport JSON names
this run, attempt 2, all attempt-1 jobs and their steps. Do not call a green run
without that marker proof. A read failure holds this capability proof; it is not
a finding that an upload occurred. This procedure establishes the released
runner-token transport capability only; app safety checks and rollout remain
separate. Review and release authority are not granted by this document.
