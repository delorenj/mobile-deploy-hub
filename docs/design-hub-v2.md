# Mobile Deploy Hub v2

Status: implemented 2026-10-09 in both repos, dry-run proof pending (it needs both commits on `main`). Scope: Tower of Lost Things now, Jarad's other Godot apps later.
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

`uses:` takes no expressions, so the caller's ref and the workflow's inner `uses: delorenj/mobile-deploy-hub/actions/hub@REF` must match (a hub test asserts one ref everywhere). Bring-up uses `@main`. After proof, tag `v1.0.0`, move `v1`, and flip every ref in one commit.

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
| `linux_runner`, `mac_runner` | JSON label arrays | `["self-hosted","linux","godot"]`, `["self-hosted","macOS","ios-signing"]` |
| `wif_provider`, `play_sa` | strings | caller passes `vars.GCP_WIF_PROVIDER`, `vars.PLAY_SA_EMAIL` |

Job graph: `plan` (Linux, 10 min) -> `android` (Linux, 30) and `ios-export` (Linux, 30) -> `ios-upload` (Mac, 60). `plan` checks out the app on `linux_runner`, runs the `version` hook, validates every input, refuses an unbuildable request (a platform the manifest lacks, `play` with no bundle hook, a real Play run without auth inputs) and outputs `version`, `android_code`, `run_android`, `run_ios`. The other jobs `needs: plan`. A `vX.Y.Z` tag run (after cutover) is real, both platforms, sideload; `plan` fails if the tag differs from the version in the presets.

**Dry runs ship less.** Retention is 1 day on a dry run and 7 days on a real run. A dry run uploads the iOS receipts (kilobytes) but not the 97 MB Xcode archive unless `dry_handoff=true`, so the Mac then verifies the toolchain and the receipt without the handoff and says so in its receipt. Reason: artifact storage is the Free plan's 500 MB shared across repos, the game already holds 194 MB, and a quota recalculation after deletes lags hours.

**Concurrency.** Each of `android`, `ios-export` and `ios-upload` has its own group (`mobile-deploy-<job>-<repo>`, `cancel-in-progress: false`), written out literally because `github.job` is not available when a job-level group is evaluated. A shared group would hold one running and one pending job, and a second dispatch would replace the first run's pending job. The single runners serialize everything else. A third queued run still replaces the second's pending job; for one developer that is acceptable.

## Hooks

`mobile-deploy.json` holds shell commands run under `bash -eo pipefail` from the app root, taken from the committed file at the built ref and never from an event payload. Env passed in: `HUB_OUT`, `HUB_BUILD`, `HUB_DRY_RUN`, `HUB_CHANNEL`. Store and GitHub tokens never reach a hook. The loader rejects unknown keys, non-string hooks and paths that leave the checkout.

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

**Where the APK goes.** A GitHub artifact is login-gated and expires, so it is not delivery. A real sideload run publishes the APK, the app receipt and the hub receipt as a **private GitHub Release** `vX.Y.Z` on the app repo (`contents: write`), and refuses to overwrite an existing release of that version. Get it onto a phone: `gh release download v0.3.0 -p '*.apk' -D artifacts --clobber && mise run android:install`. The human still carries the file to the family phones and confirms the update installs (docs/acceptance.md); "deployed through the hub" means built, signer-checked and published, not installed. The run also keeps the artifact `android-out` for 7 days.

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
3. Run the proof below.
4. After one real hub TestFlight run reaches `TESTFLIGHT_READY`, which happens with 0.3.0 in R1-14, cut over. Add `v*` tags to `deploy.yml`, delete `testflight.yml` (and its two assertions in `tests/hub-manifest.test.mjs`) so one caller remains, repoint `mise run testflight` (`mise.toml:165`), and fix `docs/testflight.md`.
5. Green-in-between: delete its stale `DEPLOY_HUB_PAT` secret and `deploy-hub.yml`.

## Steps and files

**mobile-deploy-hub**
- `.github/workflows/mobile-deploy.yml`: jobs `plan`, `android`, `ios-export`, `ios-upload`. Timeouts 10/30/30/60.
- `actions/hub/action.yml`, `tools/ci/hub.mjs`, `tools/ci/lib/{config,exec,manifest,godot,android,play,receipt}.mjs`
- `tools/ci/hub.test.mjs` (44 tests: argument handling, manifest, signer, plan, dry runs that never publish, Release, Play against a fake API, receipts, workflow and action hardening) and `mise.toml` task `check`
- deleted `.github/workflows/deploy.yml` and `tools/ci/deploy-hub.mjs`
- GitHub write: Actions access `user` (done, read back)

**pile-of-dumb-things**
- `tools/ci/mobile-deploy.json`, `tools/hub-version.mjs`, `.github/workflows/deploy.yml` (dispatch-only caller)
- `tests/hub-manifest.test.mjs`: bundle id, signer pin, artifact names, iOS pins equal the owning tool, hooks exist and use no eval, version mismatch fails, caller permissions
- deleted `.github/workflows/deploy-hub.yml` and `tools/ci/deploy-hub.mjs`
- `docs/deploy.md` (new), `docs/testflight.md` note
- at cutover: delete `.github/workflows/testflight.yml`, edit `mise.toml`, edit `docs/testflight.md`

## Proof: export only, uploads nothing

Both commits on `main` first. Then, with `@main` refs:

```sh
gh workflow run deploy.yml -f platform=both -f dry_run=true -f dry_handoff=true
```

1. The workflow resolves from the private hub. This proves access `user` and the caller's permissions.
2. `plan` prints `HUB_PLAN version=0.2.1 android_code=3 ... dry_run=true`.
3. `android` on big-chungus runs `prepare`, exports the APK, and prints `APK_SIGNER_OK 2d49...1a97`. It uploads artifact `android-out` (1 day). The Play auth, Play upload and Release steps are skipped.
4. `ios-export` on big-chungus runs `testflight.mjs export`: SDK and audio prep, a read-only ASC build lookup, the Godot iOS export, the icon fix. Artifacts `ios-receipt` and (with `dry_handoff`) `xcode-project`.
5. `ios-upload` on carries-macbook-air, dry: downloads both, checks the tgz sha256 against the receipt, finds the `.xcodeproj` in it, runs `xcodebuild -version` and `security find-identity -v -p codesigning` (the pinned SHA-1 must be listed), and resolves each secret reference. It prints `HUB_IOS_DRY_RUN` and never calls `upload` or `assign`. Each `op read` is bounded (45 s, `HUB_OP_TIMEOUT_MS`): with the Mac's screen locked 1Password waits for a person, so a real run fails there with "Unlock the Mac" before anything uploads, and a dry run warns, writes `UNVERIFIED` into its receipt and does not count the references as proven.
6. Nothing left the machines. Logs lack `TESTFLIGHT_UPLOADED`. The ASC build list is the same before and after (GET only). Play was never contacted. No Release exists.
7. Both `hub-receipt-*.json` files show `dry_run: true`. `gh workflow view testflight.yml` still lists the workflow. Never dispatch `testflight.yml` as proof: it has no dry run and uploads.

Quota: this run holds about 155 MB (APK 58 MB plus the 97 MB archive) for a day, on top of the 194 MB the game's two `xcode-project` artifacts from `testflight.yml` already occupy until they expire on 2026-10-14. Use `dry_handoff=true` once; retry without it, because two such runs inside a day would pass the 500 MB cap and the recalculation after deleting lags hours.

Likely first-run findings: missing Android templates, ImageMagick, Kokoro paths.

## Needs Jarad

- Saving the Godot `debug.keystore` (`~/.local/share/godot/keystores/debug.keystore`, not `~/.android/debug.keystore`) to 1Password.
- The GCP provider and binding above, plus the Play spec decisions, before any Play run.
- Confirmation that a `v*` tag means a real TestFlight upload after cutover.
- Whether hub iOS runs should also put the build in the Family group (with Beta App Review), or stay Owner Testing only.

## Review findings applied (2026-10-09)

All twelve were valid and applied. Differences from the suggested fixes: concurrency groups are literal per-job names, since `github.job` is empty at job-level concurrency evaluation; `actionlint` lints the workflow only, so a hub test checks that every composite `run:` step has `shell: bash`; `hub-version.mjs` compares the marketing version only.
