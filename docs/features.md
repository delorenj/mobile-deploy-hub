# Mobile Deploy Hub: features

Repo: https://github.com/delorenj/mobile-deploy-hub (public). Local checkout: `~/code/mobile-deploy-hub`. pjangler project `mobile-deploy-hub`, Plane board `MOBI`. Full reference: [README.md](../README.md); design of record: [design-hub-v1.1.md](design-hub-v1.1.md).

What it is: one shared deploy pipeline (a reusable GitHub workflow, a composite action, Node tools and one policy file) that every mobile app calls. The apps are Tower of Lost Things, Green In Between, Gruvato, Navi, Earshot and Shortwave. Each app carries only a thin caller (`.github/workflows/deploy.yml`), a manifest (`tools/ci/mobile-deploy.json`) and the `mise run deploy` task.

## Deploying

- **One front door per app:** `mise run deploy` (dry run) and `mise run deploy --dry-run false` (real). It dispatches the workflow, watches it and ends `DEPLOY_GREEN`, `DEPLOY_RED` or `DEPLOY_UNKNOWN`.
- **Version bump:** patch, minor or major, committed and tagged on `main` by the hub only. A version is never reused, and a red run after its bump is finished with `gh run rerun <id> --failed`.
- **Android:**
  - build and signer pin check;
  - `adb install -r` on the S26, then readback of version, code and APK sha256;
  - Quickdrop copy (only when the S26 syncs from the LAN);
  - private GitHub Release `vX.Y.Z`.
- **iPad:**
  - the Mac builds and signs (development);
  - `devicectl` install, with readback;
  - over-the-air install link (`manifest.plist`).
- **TestFlight:** upload and assign to the app's beta groups (policy `testflight.groups`, default Owner Testing). Opt-in with `--testflight true` in the live hub (v1.2.25).
- **Play internal track:** upload with `--play`, keyless via Workload Identity Federation.
- **Away devices are `pending`, not failures:** a catch-up job installs the build when the device comes back. It runs every 2 min for the S26 (big-chungus) and every 5 min for the iPad (the Mac), and never while the app is on screen.
- **Mac awareness:** home, metered or offline is decided at the gate. The iPad lane is skipped when the Mac is offline or a metered link would exceed its data budget. A watchdog cancels an iPad job stuck waiting for its runner.
- **Downgrade guards:** never installs an older build over a newer one; never uninstalls or clears data.
- **One Bloodbank event per run attempt** (`bloodbank.project.deployment.completed`/`.failed`) with each device's status. ntfy notifications carry the install links.
- **`deploy:train`** (in the hub): deploys Tower, then Green In Between, then Gruvato, stopping at the first red run.

## Rules (the policy)

- **One policy file**, `tools/ci/policy.json`, read from the pinned hub tag: the apps and their pinned package, bundle and signer; bump levels; event rules; delivery targets; Mac data budget; catch-up cadence.
- **Caller allowlist:** an app's `deploy.yml` must be a verbatim copy of `templates/deploy.yml`, checked by hash.
- **Conformance:** no app may bump, tag, `gh release create`, upload to TestFlight or install a release build outside the hub.
- **Releases of the hub itself:** `mise run release -- X.Y.Z` tags, moves `v1`, and proves the release with one dry run per app; `v1` moves back on red.

## The build directory (what https://s3.delo.sh/builds shows)

- Written by the run's `deliver-android` and `deliver-ios` jobs to the MinIO bucket `builds`. Device statuses are later updated by the catch-up jobs.
- `builds/index.json` and `index.html` cover every app; `builds/<slug>/latest.json` is the per-app delivery contract (version, commit, run, each platform's artifact, sha256 and device status); `builds/<slug>/index.html` holds the install buttons and history.
- TestFlight and App Store Connect state (processing, review, availability) is **not** recorded there today.

## Shared phones and emulators

- **`hub-device`:** FIFO leases on the shared S26 and S24 (`lease`, `release`, `run`, `status`), plus a throwaway emulator pool with identity-checked teardown.

## Implemented but not activated by the current policy (hub `main`)

- `mise run ship`: dry run, then real run on the same commit, then a completion verdict. With the deployed v1.2.25 policy's absent `completion` block, it does **not** require device arrival, TestFlight, or automatic reruns.
- The optional strict `completion` contract has tests for requiring every lane's device, TestFlight for App Store apps, refusing unavailable required lanes before the bump, and one same-version rerun. It is deferred to a separate policy decision/release, not part of the authored release-notes adoption.
- Store preflight (when TestFlight is requested) and duplicate App Store upload avoidance on rerun.
- **Per-app TestFlight policy (JIMB-466, hub `main`; reaches apps with the next `v1` release):** the `apps.<repo>.testflight` block names the beta `groups` an app's `assign` hook gives each build to (default Owner Testing, passed to hooks as `HUB_TESTFLIGHT_GROUPS`) and the `train` of its iOS marketing version (`patch`, the default, or `minor`: `0.3.7` ships to TestFlight as `0.3.0` while the build number keeps climbing, so Apple's per-version Beta App Review is not repeated for patch deploys). The plan prints `HUB_TESTFLIGHT_PLAN` and records `ios_version` and the groups in its receipt; the iOS hooks see `HUB_IOS_VERSION`. An optional `ios.store.review` hook records Apple's beta review state in the store receipt and the completion reason. README, "TestFlight groups, the iOS version train and the 90-day clock", has the contracts and the 90-day build-expiry rebuild cadence.

## Not built

- A status CLI (`mhub status`) listing every managed app's platforms, versions and TestFlight/App Store review state.
- Durable TestFlight tracking after the run (processing to valid to assigned, review status in `latest.json`, the event and the completion verdict: "uploaded" is not yet told apart from "testers can install" there; the review state is in the run's receipt only).
- A Candybar job that rebuilds an app's TestFlight build before its 90-day expiry (the cadence is documented; the clock is not created by the hub).
- Catch-up heartbeats, so "pending" proves the catch-up is actually running.
