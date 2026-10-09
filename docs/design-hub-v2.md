# Mobile Deploy Hub v2

Status: implemented 2026-10-09 in both repos. **Dry run proven except the Mac's secret references and the Xcode handoff** (run 37893441282, below). No Release, TestFlight upload or Play call has happened through the hub. Scope: Tower of Lost Things now, Jarad's other Godot apps later.
Goal: every new app version deploys through this repo, and runners stay repo-scoped.

## What was wrong

The hub was set up incorrectly. There is a more idiomatic way.

1. **It was a `repository_dispatch` relay.** On a personal account a runner registers to one repo. The hub has no runners, so the dispatch simply ran a copy of the workflow inside the game repo. That is a fork, not a hub.
2. **Cross-repo checkout cannot work.** `GITHUB_TOKEN` reads only its own private repo and GitHub answers 404 for the rest. Runs 37821589234 and 37821602791 died at "Checkout Source Repo" for exactly that. The usual fix is a PAT, a long-lived secret patching a flaw the design created.
3. **Vendored copies drift.** `deploy-hub.yml` and `deploy-hub.mjs` (41ccc60) were byte-identical forks on day one.
4. **`pre_export_command` was `eval`'d from a dispatch payload.** That is an injection point.
5. **It never knew this app.** No SDK or audio prep, no `bundled_only` staging, no signing profile, no ASC build lookup, no Owner Testing step, no APK lane. It asked for a `delonet` label big-chungus lacks, defaulted to `native/godot`, and pointed at a WIF pool that does not exist. The working path was the app's own `testflight.yml` and `tools/testflight.mjs`.

## Shape

The hub is a library. The app is the caller. Jobs run on the caller's runners.

| Piece | Where | Does |
|---|---|---|
| `.github/workflows/mobile-deploy.yml` | hub, `on: workflow_call` | job graph, runner routing, Linux-to-Mac artifact handoff, dry-run gating, per-job concurrency, keyless auth |
| `actions/hub/action.yml` | hub, composite | puts `tools/ci/hub.mjs` on the runner; inputs only, mapped to `HUB_*` env |
| `tools/ci/hub.mjs`, `tools/ci/lib/*` | hub | the commands: `plan`, `android`, `play`, `release`, `ios-export`, `ios-upload` |
| `deploy.yml` | app, thin caller | inputs, triggers, `permissions: contents: write, id-token: write` |
| `tools/ci/mobile-deploy.json` | app | hook commands and identity pins (the caller passes its path as `manifest`) |
| `tools/hub-version.mjs` | app | the `version` hook |

The composite action exists because a called workflow cannot reliably `actions/checkout` the private hub (expect the same 404), and `uses: ./` there resolves against the caller. The runner downloads composite actions under the hub's Actions access, and `github.action_path` finds the tool. Everything else the workflow does is `actions/checkout`, artifact up/download and the Google auth action. The YAML contains no `run:` step, so no workflow expression is ever spliced into a shell line; the action maps inputs to env vars and `hub.mjs` validates them.

**Hub Actions access is `user`** (set 2026-10-09 and read back with a GET, because with `none` the caller's `uses:` ends in `startup_failure`): `gh api -X PUT repos/delorenj/mobile-deploy-hub/actions/permissions/access -f access_level=user`. That one setting covers the workflow and the composite action.

**Caller permissions.** Any `permissions:` block zeroes every scope it does not list, and a called workflow cannot raise what the caller grants. The caller therefore grants `contents: write` (checkout of the private app repo in every job, the Mac included, plus the Release) and `id-token: write` (Play). The hub workflow narrows per job: only `android` gets write, only `plan` and the iOS jobs get read alone. Every job checks out `github.sha`, because the manifest's hooks are the app's own tools.

The hub has no runners and no CI, since private-repo hosted minutes are billed. Its checks run locally: `mise run check` (actionlint on the workflow, then `node --test tools/ci/*.test.mjs`).

`uses:` takes no expressions, so the caller's ref and the workflow's inner `uses: delorenj/mobile-deploy-hub/actions/hub@REF` must match (a hub test asserts one ref everywhere). Bring-up uses `@main`, and `main` moves under a real run. **Before the first real run (R1-14) the refs must be a tag.** After the first complete dry run (unlocked Mac, `dry_handoff=true`, receipt shows every secret reference resolving), tag and flip in this order:

```sh
# hub: flip every inner ref in one commit, then tag that very commit (the tag must contain the flipped refs,
# or the caller's v1.0.0 workflow would still call actions/hub@main)
sed -i 's#mobile-deploy-hub/actions/hub@main#mobile-deploy-hub/actions/hub@v1.0.0#' .github/workflows/mobile-deploy.yml
mise run check && git commit -am "chore: pin the inner action refs to v1.0.0" && git push
git tag -a v1.0.0 -m "mobile-deploy-hub v1.0.0" && git push origin v1.0.0
# game: one commit changes deploy.yml's @main to @v1.0.0 and the matching regex in tests/hub-manifest.test.mjs
```

Then one more strict dry run proves the tag resolves, and its receipts show `hub_ref: v1.0.0`.

Each receipt records `hub_ref` (the ref the runner fetched the hub at: `main` during bring-up, `v1.0.0` after the flip), so a Release or a TestFlight build traces to the hub code that made it. A real run whose receipts say `main` was not pinned. The workflow sha is in the run log (`Uses: ...mobile-deploy.yml@refs/heads/main (33ab07dc...)`), but the `github` context exposes no sha to the job, so the receipt cannot hold it.

## Inputs

| Input | Values | Default |
|---|---|---|
| `manifest` | path inside the app checkout | `mobile-deploy.json` (Tower passes `tools/ci/mobile-deploy.json`) |
| `platform` | android, ios, both | both |
| `android_channel` | sideload, play | sideload |
| `track` | Play track | internal |
| `play_status` | Play release status | draft |
| `build` | iOS build override, positive integer | blank, meaning next after App Store Connect |
| `dry_run` | bool | true on dispatch |
| `dry_handoff` | bool | false |
| `strict` | bool | true (caller leaves it at the default). A dry run fails, as a real run does, when a check could not be made: a locked Mac leaves the 1Password references unread |
| `linux_runner`, `mac_runner` | JSON label arrays | `["self-hosted","linux","godot"]`, `["self-hosted","macOS","ios-signing"]` |
| `wif_provider`, `play_sa` | strings | caller passes `vars.GCP_WIF_PROVIDER`, `vars.PLAY_SA_EMAIL` |

Job graph: `plan` (Linux, 10 min) -> `android` (Linux, 30) and `ios-export` (Linux, 30) -> `ios-upload` (Mac, 60). `plan` checks out the app on `linux_runner`, runs the `version` hook, validates every input, refuses an unbuildable request (a platform the manifest lacks, `play` with no bundle hook, a real Play run without auth inputs) and outputs `version`, `android_code`, `run_android`, `run_ios`. The other jobs `needs: plan`. A `vX.Y.Z` tag run (after cutover) is real, both platforms, sideload; `plan` fails if the tag differs from the version in the presets.

**Artifacts are receipts, not builds.** Retention is 1 day on a dry run and 7 days on a real run. `android-out` holds the two Android receipts (kilobytes), never the 68 MB APK: a sideload run delivers the APK in the private Release, a Play run hands the AAB to Play, and the receipts carry the sha256 and the signer. The one big artifact is the iOS Xcode archive (97 to 110 MB), and a dry run uploads it only with `dry_handoff=true`, so the Mac otherwise verifies the toolchain and the receipt without the handoff and says so in its receipt. Reason: artifact storage is the Free plan's 500 MB shared across repos, and a quota recalculation after deletes lags hours. Before run 3 the first design uploaded the APK on every run: runs 1 and 2 plus two `testflight.yml` archives took the game to 447 MB of 500 MB on 2026-10-09. Every upload sets `overwrite: true`, so "Re-run failed jobs" can replace the artifact a failed attempt left behind (upload-artifact@v4 otherwise fails on the name).

**Concurrency.** Each of `android`, `ios-export` and `ios-upload` has its own group (`mobile-deploy-<job>-<repo>`, `cancel-in-progress: false`), written out literally because `github.job` is not available when a job-level group is evaluated. A shared group would hold one running and one pending job, and a second dispatch would replace the first run's pending job. The single runners serialize everything else. A third queued run still replaces the second's pending job; for one developer that is acceptable.

## Hooks

`mobile-deploy.json` holds shell commands run under `bash -eo pipefail` from the app root, taken from the committed file at the built ref and never from an event payload. Env passed in: `HUB_OUT`, `HUB_BUILD`, `HUB_DRY_RUN`, `HUB_CHANNEL`. Store, GitHub and OIDC tokens never reach a hook: `hookEnvironment` strips `PLAY_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN` and `ACTIONS_RUNTIME_TOKEN`. The runner sets the OIDC pair in every step of the `android` job, because that job holds `id-token: write` on dry runs too, and they can mint a federated Google token; a hub test pins the list. The loader rejects unknown keys, non-string hooks and paths that leave the checkout.

```json
{
  "schema": 1,
  "version": "node tools/hub-version.mjs",
  "android": {
    "package": "io.automaticai.towerofdumbthings",
    "prepare": "node tools/bootstrap.mjs",
    "export": "node tools/project.mjs android",
    "artifact": "artifacts/TowerOfDumbThings.apk",
    "receipt": "artifacts/android-receipt.json",
    "signer_sha256": "2d4954863dabb5da86d69ce4b60b3e400e73669b50a80658b0941440a7941a97"
  },
  "ios": {
    "bundle": "io.automaticai.towerofdumbthings",
    "export": "node tools/testflight.mjs export --out \"$HUB_OUT/ios\" ${HUB_BUILD:+--build \"$HUB_BUILD\"}",
    "archive": "TowerOfDumbThings-xcode.tgz",
    "receipt": "testflight-export.json",
    "upload": "node tools/testflight.mjs upload \"$HUB_OUT/ios/TowerOfDumbThings-xcode.tgz\"",
    "assign": "node tools/testflight.mjs assign \"$HUB_OUT/ios/testflight-export.json\"",
    "signer_sha1": "F8A5C5309FC1B6C7DD7662A28EA822BE3309C351",
    "secrets": ["op://DeLoSecrets/App Store Connect API Key/key_id", "..."]
  }
}
```

`prepare` is per platform (`android.prepare`, `ios.prepare`), not global: the proven `testflight.yml` ran no bootstrap before the iOS export, so Tower declares it for Android only, where it extracts the empty Android templates. An Android section may declare `godot: {path, preset}` instead of `export`, which uses the hub's fallback exporter (engine from `GODOT_BIN`, log scan for `SCRIPT ERROR`).

**The hub owns:** the job graph, the fallback Godot exporter, the Play uploader, the APK signer check, the Release step, receipts and summaries. **The app owns:** SDK and audio prep, `bundled_only` staging, icon alpha, signing, build-number lookup and Owner Testing, all inside `tools/testflight.mjs`. The hub does not reimplement signing, and the old `uploadIos` is deleted. A second app plugs in by writing its own manifest. Green-in-between's cargo `pre_export_command` becomes its `android.prepare`.

## Android: family APK and Play AAB

**Sideload (default).** This is the only Android build the family gets. The hook is `mise run android:build` (`node tools/project.mjs android`), which makes a debug-signed APK. The hub runs `apksigner verify --print-certs` and requires exactly one signer whose SHA-256 equals `signer_sha256`. A mismatch means phones could not update in place, so the job fails. The pin is correct: `2d4954...1a97` is the signer of the existing APK and of `~/.local/share/godot/keystores/debug.keystore` (`~/.android/debug.keystore` is a different key, D0:9A...).

apksigner execs bare `java`, and the runner service has no `JAVA_HOME` or `ANDROID_HOME` (`java` is a mise shim that refuses the untrusted `mise.toml` inside `_work`). So `tools/ci/lib/android.mjs` sets `JAVA_HOME` to `~/.local/share/mise/installs/java/17.0.2` when unset, as `tools/project.mjs` does, and finds the newest `apksigner` under `~/Android/Sdk/build-tools`. Verified here with both variables unset.

**Where the APK goes.** A GitHub artifact is login-gated and expires, so it is not delivery. A real sideload run publishes the APK, the app receipt and the hub receipt as a **private GitHub Release** `vX.Y.Z` on the app repo (`contents: write`), and refuses to overwrite an existing release of that version. Get it onto a phone: `gh release download v0.3.0 -p '*.apk' -D artifacts --clobber && mise run android:install`. The human still carries the file to the family phones and confirms the update installs (docs/acceptance.md); "deployed through the hub" means built, signer-checked and published, not installed. The run keeps the artifact `android-out` (receipts only) for 7 days. The `android` job publishes the Release before the iOS lane finishes, so an iOS failure leaves the Release in place: recover with `gh run rerun <id> --failed` (docs/deploy.md), never by deleting a good Release.

`debug.keystore` exists only on big-chungus, so this lane is pinned to that machine and the signer check is the guard, until Jarad approves saving it to 1Password.

**Play.** With `android_channel=play` the hub needs an `android.bundle` hook (and `bundle_artifact`); Tower declares none, so `plan` refuses with a clear message. It stays blocked on the Play spec: release keystore, Gradle template, versionCode and the bundled-only call. The uploader still ships now. It refuses a versionCode at or below the Console maximum (bundles and APKs), deletes its edit on any failure, and defaults the release status to `draft`, because `completed` on a never-released app is likely rejected (unverified). Unit-tested against a fake API.

## Keyless auth

- **Play:** the caller grants `id-token: write`, and `google-github-actions/auth@v3` exchanges the OIDC token through WIF. No JSON key. The OIDC `repository`, `sub` and `repository_id` claims are the caller's even in a reusable workflow (`job_workflow_ref` is the hub's), so trust stays keyed to the app repo id.
- **GCP fix, needed only before Play.** The current variable `GCP_WIF_PROVIDER` names pool `github-actions`, which does not exist. The project is `greeninbetween` (number 228417675069), the pool is `github`, and it has one provider, `green-in-between`. Create a sibling by copying that provider's mapping. Without `attribute.repository_id` the condition and the binding match nothing and the STS exchange returns 403.

  ```sh
  gcloud iam workload-identity-pools providers create-oidc tower-of-lost-things \
    --project=greeninbetween --location=global --workload-identity-pool=github \
    --display-name="delorenj/pile-of-dumb-things" \
    --issuer-uri=https://token.actions.githubusercontent.com \
    --attribute-mapping='google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref=assertion.ref,attribute.workflow_ref=assertion.workflow_ref' \
    --attribute-condition="assertion.repository_id == '1398941373' && assertion.repository_owner_id == '242611'"

  gcloud iam service-accounts add-iam-policy-binding gib-play-publisher@greeninbetween.iam.gserviceaccount.com \
    --project=greeninbetween --role=roles/iam.workloadIdentityUser \
    --member='principalSet://iam.googleapis.com/projects/228417675069/locations/global/workloadIdentityPools/github/attribute.repository_id/1398941373'

  gh variable set GCP_WIF_PROVIDER --repo delorenj/pile-of-dumb-things \
    --body projects/228417675069/locations/global/workloadIdentityPools/github/providers/tower-of-lost-things
  ```

  Then invite the service account to Tower in Play Console. Not run: it is a GCP write, and Play is not launched.
- **iOS:** unchanged. The ASC key comes from `op read` on the runners. No `.p8` is written. The Mac preflight only checks that each `ios.secrets` reference resolves and discards the value unread.

## Versioning and receipts

- Marketing version and Android versionCode live in `game/export_presets.cfg`, pinned by tests, and change in the bump commit (0.3.0, code 4, story R1-14). The hub reads and never writes them.
- The iOS build number belongs to the store. `testflight.mjs` takes the next number after ASC, and `build` overrides it.
- `tools/hub-version.mjs` prints `{version, android_code, ios_build}` from the presets and **throws if Android `version/name` and iOS `short_version` differ**, so a bump that touches one platform cannot deploy two versions. Only the marketing version is compared: the iOS `application/version` is a floor under the store's counter, not a twin of the versionCode. `tests/hub-manifest.test.mjs` asserts the mismatch fails.
- Each job writes `hub-receipt-<lane>.json` (`android`, `ios-export`, `ios-upload`) into its artifact and into `$GITHUB_STEP_SUMMARY`. It holds repo, sha, run id, dry_run, version, build, artifact sha256s and the signer; never a credential. The app's own receipts (`android-receipt.json`, `testflight-export.json`) are copied in verbatim, and their version must equal the plan's.

## What reaches whom

- **Android:** a private Release with a signer-checked APK. Nobody gets it until a human installs it.
- **iOS:** `assign` adds the build to the **Owner Testing** group, which holds only the developer account. The family sit in the external **Family** group, which needs Beta App Review (docs/testflight.md). A successful hub iOS run reaches Jarad, not the family. Family delivery is a separate, explicit step (`assign` to the Family group plus the review submission) that is not in the hub; it is a decision for Jarad, recorded in the release story.
- **Game packs** (`mise run content:publish`) are not app versions and stay as they are.

## Migration

1. Build the hub side, then the game's caller. `testflight.yml` is not touched and stays the shipping path. (Done.)
2. Delete the game's `deploy-hub.yml` and `tools/ci/deploy-hub.mjs` now, and the hub's relay `deploy.yml` and `tools/ci/deploy-hub.mjs`. Nothing references them (grepped) and they only fail. (Done.)
3. Run the proof below. **Partly done:** run 37893441282 (below) passed, with the Mac's secret references unverified and the handoff skipped. Not proven: see "Not yet proven".
4. After one complete dry run, tag the hub `v1.0.0` and flip every ref (see "Versioning" above). Then, after one real hub TestFlight run reaches `TESTFLIGHT_READY`, which happens with 0.3.0 in R1-14, cut over. Add `v*` tags to `deploy.yml`, delete `testflight.yml` (and its two assertions in `tests/hub-manifest.test.mjs`) so one caller remains, repoint `mise run testflight` (`mise.toml:165`), and fix `docs/testflight.md`.
5. Green-in-between: delete its stale `DEPLOY_HUB_PAT` secret and `deploy-hub.yml`. **Not done.** The secret (created 2026-10-08) points at a relay that no longer exists, and a stored PAT is what the mobile-devex keyless rule forbids. Needs Jarad's OK, because it is a GitHub write in another repo: `gh secret delete DEPLOY_HUB_PAT --repo delorenj/green-in-between`, then delete its `deploy-hub.yml` or port it to a `mobile-deploy.json` manifest (it still carries the old `pre_export_command` eval shape).

## Steps and files

**mobile-deploy-hub**
- `.github/workflows/mobile-deploy.yml`: jobs `plan`, `android`, `ios-export`, `ios-upload`. Timeouts 10/30/30/60.
- `actions/hub/action.yml`, `tools/ci/hub.mjs`, `tools/ci/lib/{config,exec,manifest,godot,android,play,receipt}.mjs`
- `tools/ci/hub.test.mjs` (47 tests: argument handling, manifest, signer, plan, dry runs that never publish, strict dry runs, Release, Play against a fake API, receipts, workflow and action hardening) and `mise.toml` task `check`
- deleted `.github/workflows/deploy.yml` and `tools/ci/deploy-hub.mjs`
- GitHub write: Actions access `user` (done, read back)

**pile-of-dumb-things**
- `tools/ci/mobile-deploy.json`, `tools/hub-version.mjs`, `.github/workflows/deploy.yml` (dispatch-only caller)
- `tests/hub-manifest.test.mjs`: bundle id, signer pin, artifact names, iOS pins equal the owning tool, hooks exist and use no eval, version mismatch fails, caller permissions
- deleted `.github/workflows/deploy-hub.yml` and `tools/ci/deploy-hub.mjs`
- `docs/deploy.md` (new), `docs/testflight.md` note
- at cutover: delete `.github/workflows/testflight.yml`, edit `mise.toml`, edit `docs/testflight.md`

## Proof: export only, uploads nothing

Both commits on `main` first, the Mac unlocked and 1Password approved. Then, with `@main` refs, from the game checkout:

```sh
mise run deploy --dry-handoff true   # dispatches deploy.yml, finds the run it started, watches that run
```

(`mise run deploy` is `tools/deploy.mjs` in the game. It records the latest run id, dispatches, waits for a newer `workflow_dispatch` run on the same sha and runs `gh run watch --exit-status` on it. Running `gh run watch` on "the latest run" straight after `gh workflow run` can watch the previous, already green run.)

1. The workflow resolves from the private hub. This proves access `user` and the caller's permissions.
2. `plan` prints `HUB_PLAN version=0.2.1 android_code=3 ... dry_run=true`.
3. `android` on big-chungus runs `prepare`, exports the APK, and prints `APK_SIGNER_OK 2d49...1a97`. It uploads artifact `android-out` (the two receipts, 1 day). The Play auth, Play upload and Release steps are skipped.
4. `ios-export` on big-chungus runs `testflight.mjs export`: SDK and audio prep, a read-only ASC build lookup, the Godot iOS export, the icon fix. Artifacts `ios-receipt` and (with `dry_handoff`) `xcode-project`.
5. `ios-upload` on carries-macbook-air, dry: downloads both, checks the tgz sha256 against the receipt, finds the `.xcodeproj` in it, runs `xcodebuild -version` and `security find-identity -v -p codesigning` (the pinned SHA-1 must be listed), and resolves each secret reference. It prints `HUB_IOS_DRY_RUN` and never calls `upload` or `assign`. Each `op read` is bounded (45 s, `HUB_OP_TIMEOUT_MS`): with the Mac's screen locked 1Password waits for a person, so the run fails there with "Unlock the Mac, approve 1Password" before anything uploads. A dry run is strict by default for the same reason; only an explicit `strict=false` dry run warns instead, writes `UNVERIFIED` into its receipt and does not count the references as proven. **A dry run is a valid gate only if `hub-receipt-ios-upload.json` says "3 secret references resolve" and carries no `UNVERIFIED` note.**
6. Nothing left the machines. Logs lack `TESTFLIGHT_UPLOADED`. The ASC build list is the same before and after (GET only). Play was never contacted. No Release exists.
7. Both `hub-receipt-*.json` files show `dry_run: true`. `gh workflow view testflight.yml` still lists the workflow. Never dispatch `testflight.yml` as proof: it has no dry run and uploads.

Quota: with receipts-only `android-out`, a dry run costs kilobytes; `dry_handoff=true` adds the 97 to 110 MB archive for a day. The game's two `xcode-project` artifacts from `testflight.yml` (194 MB) stay until 2026-10-14. Runs 1 and 2 left 447 MB of 500 MB live on 2026-10-09 (two 72 MB APKs and a 110 MB archive), which expire 2026-10-10 about 06:15 UTC. Do not start the first `dry_handoff=true` run before then (check: `gh api 'repos/{owner}/{repo}/actions/artifacts?per_page=100' --jq '[.artifacts[]|select(.expired==false).size_in_bytes]|add'`), and keep to one such run a day.

### Run 37893441282 (2026-10-09, dry run of 9603cd1, hub 33ab07d, `dry_handoff=false`)

All four jobs green. Seen in the logs:

- `plan`: `HUB_PLAN version=0.2.1 android_code=3 platform=both channel=sideload dry_run=true`. The caller resolved the private hub workflow and composite action (Actions access `user`).
- `android` on big-chungus: `APK_SIGNER_OK 2d4954863dabb5da86d69ce4b60b3e400e73669b50a80658b0941440a7941a97`; `HUB_ANDROID_BUILT TowerOfDumbThings.apk sha256=23eab55f1bf25eb2a1ca28735d386b93fabc85d73a15c83dcfaeb504074d082b`. No Play, no Release.
- `ios-export` on big-chungus: `HUB_IOS_EXPORTED TowerOfDumbThings-xcode.tgz sha256=502461802e4a82297a3da009cd49d7fbfa83afd4609ae2c46a94d6af2d993b9c`.
- `ios-upload` on carries-macbook-air: `Xcode 27.0 (27A266a)`, the pinned signing identity present and valid, then **`op did not answer within 45s reading ...key_id`** as a warning (the screen was locked). Upload and assign were skipped, as a dry run requires. The receipt carried `UNVERIFIED: 3 secret references were not checked`, and the job still went green. That is the defect the `strict` input closes.

Run 1 (37892301252, `dry_handoff=true`) was cancelled by hand: its `ios-upload` sat 8.5 minutes inside the verify step, before the 45 s `op` bound existed. Its Linux jobs were green.

### Not yet proven

- **The three `op://` references on the Mac.** Needs the Mac unlocked and 1Password approved. Why it depends on a person: see "Needs Jarad".
- **The Xcode handoff.** The archive was not shipped (`dry_handoff=false`): the Mac's sha256 and `.xcodeproj` check has not run on a real handoff.
- **A real Release** (`gh release create` as the `android` job, `contents: write`), including the refusal to overwrite.
- **Upload and assign through the hub.** `testflight.mjs upload` and `assign` as hub hooks, up to `TESTFLIGHT_READY`.
- **A pinned hub ref.** All refs are `@main`; receipts show `hub_ref: main`.
- **Play**, which is blocked on purpose.

Likely first-run findings: missing Android templates, ImageMagick, Kokoro paths.

## Needs Jarad

- **How the Mac gets its 1Password access.** The `ios-upload` job reads the App Store Connect key with `op read`, and on the Mac `op` answers through the desktop app, which waits for a person when the screen is locked or the app wants approval. big-chungus is different: `runsvc-op.sh` exports `OP_SERVICE_ACCOUNT_TOKEN`, so its jobs run unattended. `docs/testflight.md` says both runners start through `runsvc-op.sh`, but the observed hang means the Mac job did not authenticate with a service-account token. Until that changes, every real iOS release (and the old `testflight.yml`) needs a person at the Mac, and the 45 s bound only makes the failure quick. Preferred fix: give the Mac runner's LaunchAgent a service-account token scoped to the App Store Connect item, as on Linux, then re-run the dry run. Otherwise "unlock the Mac and approve 1Password" is a hard step before every deploy (docs/deploy.md and R1-14 say so). Not done here: it changes credentials on the Mac.
- Saving the Godot `debug.keystore` (`~/.local/share/godot/keystores/debug.keystore`, not `~/.android/debug.keystore`) to 1Password.
- The GCP provider and binding above, plus the Play spec decisions, before any Play run.
- Confirmation that a `v*` tag means a real TestFlight upload after cutover.
- Whether hub iOS runs should also put the build in the Family group (with Beta App Review), or stay Owner Testing only.

## Review findings applied (2026-10-09)

### Round 2

Thirteen findings against the first dry-run proof. Applied: the locked-Mac gate (dry runs are strict by default; docs name the unlock prerequisite and the receipt that makes a pass valid); a `mise run deploy` task that dispatches, finds the run it started (a newer `workflow_dispatch` run on the same sha) and watches that one; the standing instruction in AGENTS.md and a notice on `mise run testflight`; receipts-only `android-out` and `overwrite: true` on every upload; OIDC variables stripped from hooks; recovery rows for an iOS failure after the Release; `hub_ref` in the receipts and the tag-then-flip procedure; the stale `package.json` plus `gittag` version authority removed from the game; the decision rows and story text refreshed. Not applied: the Mac service-account token (Jarad's decision, above); tagging `v1.0.0` (it comes after the first complete dry run, which has not happened); deleting `DEPLOY_HUB_PAT` in green-in-between (a GitHub write that needs Jarad's OK). Declined: an opt-in to keep the APK artifact on a dry run, because the receipt holds its sha256 and signer and `mise run android:build` rebuilds it, so the opt-in would only reintroduce the quota problem.

### Round 1

All twelve were valid and applied. Differences from the suggested fixes: concurrency groups are literal per-job names, since `github.job` is empty at job-level concurrency evaluation; `actionlint` lints the workflow only, so a hub test checks that every composite `run:` step has `shell: bash`; `hub-version.mjs` compares the marketing version only.
