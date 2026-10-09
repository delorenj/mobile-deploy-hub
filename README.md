# Mobile Deploy Hub

One deploy contract for Jarad's mobile apps: Tower of Lost Things (`pile-of-dumb-things`), Green In Between (`green-in-between`) and Gruvato (`gruvato`). The hub is a library: one reusable workflow, one composite action and a Node tool. Each app calls it from a thin `deploy.yml`, and the jobs run on the app's own repo-scoped runners (big-chungus for Linux, mommymac for macOS). The hub has no runners, no secrets and no CI of its own. Design: [docs/design-hub-v3.md](docs/design-hub-v3.md) (v2 history: [docs/design-hub-v2.md](docs/design-hub-v2.md)).

## Deploy

Every new version of an app deploys through this hub, the same way in all three repos:

```sh
mise run deploy                    # dry run: builds, checks both devices and the event, changes nothing
mise run deploy --dry-run false    # real: patch bump, install on the S26 and the iPad, Bloodbank event
```

A real deploy bumps the patch version (`--bump minor` or `--bump major` for more), commits and tags it on `main`, installs the build in place on the S26 and the iPad, reads the version back from both, and sends one `bloodbank.project.deployment.completed` (or `.failed`) event. `--platform android` or `--platform ios` narrows it to one device. A deploy that failed after its bump is finished with `gh run rerun <run-id> --failed` (same version, same commit), never with a second bump.

Before you run it:

1. Wireless debugging is on on the S26 (the quick-settings tile; it turns itself off after a reboot or a Wi-Fi change).
2. The iPad is awake and on the home Wi-Fi.
3. The Mac is on and Jarad is logged in (the runners start at login).

## What a run does

| Job | Runs on | Does |
|---|---|---|
| `preflight-ios` | Mac | the iPad answers by UDID, the development identity signs, a profile covers the iPad for 30+ days, 15 GiB free; with `--testflight` the App Store Connect references resolve |
| `plan` | Linux | the S26 answers by serial, the event passes `bb-emit --check`, then the bump: the app's `version.bump` hook, the exact semver increment, a new tag. Real: commit, tag, `git push --atomic` to `main`. Dry: the same commit, tag and `git push --dry-run --atomic` (guards and write access), then rewound |
| `android` | Linux | build, signer pin, APK identity, `adb install -r` on the S26, readback of versionName, versionCode and the on-device `base.apk` sha256, then the private Release `vX.Y.Z` |
| `ios-export` | Linux | Tower only: Godot's Xcode project, sent to the Mac over the LAN (no artifact quota) |
| `ios` | Mac | the app's `ios.device` hook, export with method `debugging`, IPA checks, `devicectl device install app` on the iPad, readback; TestFlight with `--testflight` |
| `announce` | Linux | one event per deploy from the job results and receipts (`bb-emit --strict`); a dry run only checks it |

A dry run never commits to the remote, tags, installs, releases, uploads or emits. Each lane applies the plan's bump to its own checkout, so the dry run builds and checks the next version. The hub only installs in place (`adb install -r`, `devicectl device install app`) and never removes an app, clears its data or downgrades it; a test greps the hub for those commands.

## Use it from an app

1. Hub Actions access is `user` (set once: `gh api -X PUT repos/delorenj/mobile-deploy-hub/actions/permissions/access -f access_level=user`).
2. Register a Linux runner on big-chungus (started through `runsvc-op.sh`, so jobs have `OP_SERVICE_ACCOUNT_TOKEN`) and a macOS runner on mommymac (LaunchAgent through `~/actions-runner/runsvc-op.sh`, which reads the service-account token from the login keychain: generic password, service `op-service-account`, account `github-runner`; never a file).
3. Write `tools/ci/mobile-deploy.json` (below), a thin `deploy.yml` and the shared `mise run deploy` task, which fetches [`tools/deploy.mjs`](tools/deploy.mjs) from this repo at the ref in `deploy.yml` and runs it.

```yaml
name: Deploy
run-name: ${{ inputs.dry_run && 'Deploy (dry run)' || 'Deploy REAL' }} ${{ inputs.platform }} bump=${{ inputs.bump }}
on:
  workflow_dispatch:
    inputs:
      dry_run: { type: boolean, default: true }
      bump: { type: choice, options: [patch, minor, major], default: patch }
      platform: { type: choice, options: [both, android, ios], default: both }
      testflight: { type: boolean, default: false }
      play: { type: boolean, default: false }
      dry_handoff: { type: boolean, default: false }
permissions:
  contents: write   # the bump commit and tag, the sideload Release, checkout of the private app
  id-token: write   # keyless Play
jobs:
  deploy:
    uses: delorenj/mobile-deploy-hub/.github/workflows/mobile-deploy.yml@v1.0.0
    with:
      manifest: tools/ci/mobile-deploy.json
      dry_run: ${{ inputs.dry_run }}
      bump: ${{ inputs.bump }}
      platform: ${{ inputs.platform }}
      testflight: ${{ inputs.testflight }}
      play: ${{ inputs.play }}
      dry_handoff: ${{ inputs.dry_handoff }}
```

The `REAL` in a real run's title is how `mise run deploy` finds the last real run (it offers `gh run rerun --failed` when that run is red). The caller's ref and the `actions/hub@REF` refs inside the workflow must match (a test asserts one ref). All three apps pin `v1.0.0`. A new hub version flips the inner refs in one commit, tags that commit, then flips each caller; a real iPad deploy needs a green `--dry-handoff true` dry run at that ref first (the proof ledger `~/.local/state/mobile-deploy-hub/ipad-proofs.json`).

## The manifest (schema 2)

| Key | Meaning |
|---|---|
| `project` | `{slug, name}`: the pjangler slug and the name the event uses |
| `version.read` | prints one line of JSON: `{"version":"X.Y.Z","android_code":N,"ios_build":...}` |
| `version.bump` | `<level>` is appended; rewrites the app's version authority files (no git) and prints the same JSON plus `"files"`, exactly the files it changed |
| `android.package`, `prepare`, `export`, `artifact`, `receipt`, `signer_sha256` | the APK the S26 gets; the signer pin is mandatory (the key on the phone) |
| `android.bundle`, `bundle_artifact` | the Play AAB, used with `--play` |
| `ios.bundle`, `device`, `device_artifact` | the Mac hook that leaves an unsigned `.xcarchive` (the hub exports it) or an `.ipa` in `$HUB_OUT/ios` |
| `ios.export`, `archive`, `receipt`, `prepare` | optional Linux half (Tower's Godot export), handed to the Mac |
| `ios.store` | `{archive, receipt, upload, assign, signer_sha1, secrets}` for `--testflight` (Tower only) |

Hooks are shell commands from the committed manifest, run under `bash -eo pipefail` in the app root with `HUB_OUT`, `HUB_DRY_RUN`, `HUB_VERSION`, `HUB_ANDROID_CODE`, `HUB_IOS_BUILD`, `HUB_TEAM` set. Store, GitHub and OIDC tokens never reach a hook. Unknown keys, non-string hooks and paths outside the checkout are rejected. Devices (S26 serial and model, iPad UDID and model, Apple team, development signer, the Mac) live once, in [`tools/ci/devices.json`](tools/ci/devices.json).

A schema 1 manifest still runs the v2 way (no bump, no installs, no event) until its app moves.

## Checks

```sh
mise run check   # actionlint on the workflow, then node --test tools/ci/*.test.mjs
```
