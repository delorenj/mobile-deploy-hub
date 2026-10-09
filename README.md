# Mobile Deploy Hub

One deploy contract for Jarad's mobile apps: Tower of Lost Things (`pile-of-dumb-things`), Green In Between (`green-in-between`) and Gruvato (`gruvato`). The hub is a library: one reusable workflow, one composite action, a Node tool and one policy file. Each app calls it from `.github/workflows/deploy.yml`, a verbatim copy of [`templates/deploy.yml`](templates/deploy.yml) pinned to the floating `@v1`, and the jobs run on the app's own repo-scoped runners (big-chungus for Linux, the Mac for macOS). The hub has no runners, no secrets and no CI of its own. Design: [docs/design-hub-v1.1.md](docs/design-hub-v1.1.md) (v1.0: [docs/design-hub-v3.md](docs/design-hub-v3.md), v2 history: [docs/design-hub-v2.md](docs/design-hub-v2.md)).

## Deploy

Every new version of an app deploys through this hub, the same way in all three repos, from any machine with `gh`, wherever the devices are:

```sh
mise run deploy                    # dry run: builds and checks everything; publishes, installs and sends nothing
mise run deploy --dry-run false    # real: patch bump, publish, install where the devices are, one Bloodbank event
mise run deploy:train --dry-run false   # in the hub: Tower, then Green In Between, then Gruvato; stops at a red run
```

A real deploy bumps the patch version (`--bump minor` or `--bump major` for more), commits and tags it on `main`, builds the APK and the iPad IPA, and publishes them to the build directory ([https://s3.delo.sh/builds/index.html](https://s3.delo.sh/builds/index.html): Install APK, Install on iPad), Quickdrop (`~/quickdrop/builds`, APKs up to 120 MB) and the private Release `vX.Y.Z`. It installs in place on the S26 and the iPad when they are reachable and reads the version back. **An away device is `pending`, not a stop**: the run goes green, the ntfy notification carries the install links, and a catch-up installs the build when the device is back (2 minutes on the S26, 5 on the iPad; `tools/catchup/`). One `bloodbank.project.deployment.completed` (or `.failed`) event names each device's status (`installed`, `pending`, `skipped`, `failed`) and carries the links. `--platform android|ios` narrows it; `--metered allow` builds the iPad lane even when the Mac's metered link would go over its data budget. A deploy that failed after its bump is finished with `gh run rerun <run-id> --failed` (same version, same commit); the front door offers it.

Nothing has to be at home first: the `gate` job reads the Mac's link (home, metered or offline, from tailscale) and the S26 itself, and skips the iPad lane when the Mac is offline or a metered link would go over budget.

## Deploy policy

The rules every deploy obeys live in one file in this repo: [`tools/ci/policy.json`](tools/ci/policy.json). The `gate` job reads it from the exact tag the run pins — never from a workflow input, an environment variable, an app manifest or a hook — so the front door, `gh workflow run`, the GitHub mobile app and every rerun all run the same rules. Only the hub can change a rule; apps inherit it through the `@v1` pin and never carry deploy policy of their own.

What it pins: bump levels (patch by default, never "none"), one Bloodbank event per run attempt, manifest schema 2, the caller allowlist (`callers.accept`, the hashes of accepted `templates/deploy.yml` versions), pinned self-hosted runner labels, absent-device handling (`pending`, never a stop), the downgrade refusals, the delivery targets (S3, Quickdrop, the private Release) and the Mac's metered data budget.

**Changing a rule, once, for every app:**

1. Edit `tools/ci/policy.json` and its test in this repo.
2. `mise run release`: it checks a clean tree, runs `mise run check` and `mise run conformance` (every app's caller hash, manifest and out-of-hub drift), tags `vX.Y.Z`, moves `v1`, and proves the release with one strict dry run per app (Tower, Green In Between, Gruvato) — moving `v1` back if any is red.

Apps need no edit for a policy change: their callers pin `@v1`. A caller changes only when the template itself changes, and the new template's hash joins `callers.accept` in the same release, so moving `v1` never refuses a caller that has not been updated yet.

**Adopting the policy in a new app:**

1. Copy `templates/deploy.yml` verbatim into `.github/workflows/deploy.yml`; it pins `@v1`, and the gate hashes the caller, so never edit it.
2. Write `tools/ci/mobile-deploy.json` (schema 2) and register the app's own repo-scoped runners (Linux on big-chungus, macOS on the Mac).
3. Add the `mise run deploy` task that fetches this repo's [`tools/deploy.mjs`](tools/deploy.mjs) at the pinned ref.
4. One hub release adds the app to `apps` and its caller hash to `callers.accept`.
5. Put the deploy sentence in the app's `AGENTS.md` (see the skillex `mobile-devex` skill) so its agents follow the same rule.

Everything out-of-hub is refused or retired: no app path may bump a version, mint a tag, `gh release create`, upload to TestFlight or install a release build on a device.

*Status (2026-10-09): v1.1 is built ([design and build log](docs/design-hub-v1.1.md)). `v1.1.0` was burned by its own release dry run (Tower 37972648770: preflight-ios refused 1Password references with spaces), and `v1` was removed again. `v1.1.1` is tagged and its release dry runs are running; until they are green, `v1` may be missing and the callers (which pin `@v1`) cannot start a run.*

## What a run does

| Job | Runs on | Does |
|---|---|---|
| `gate` | Linux | the policy on this run: the repo is listed, the manifest is schema 2 with every lane, the caller is the template (normalized hash in `callers.accept`), strict, runners and manifest are the policy's, a real run uses a released hub on `main`; then the Mac's link, the S26, and an S3 write probe. Decides the iPad lane: `run`, `skip-offline`, `skip-metered` |
| `preflight-ios` | Mac | no checkout: the development identity signs, a profile covers the iPad for 30+ days, 15 GiB free; the iPad's installed version, or `unreachable` (pending) |
| `plan` | Linux | the S26 (away after 180 s is pending), the event contract, the downgrade guards (the S26, the published `latest.json`, a newer iPad), then the bump. Real: commit, tag, `git push --atomic` to `main`, `inflight.json`. Dry: the same commit, tag and `git push --dry-run --atomic`, then rewound |
| `android` | Linux | build, signer pin, APK identity, staging for deliver, Quickdrop (real), then `adb install -r` and readback on the S26, or pending; the private Release `vX.Y.Z` |
| `ios-export` | Linux | Tower only: Godot's Xcode project, handed to the Mac as an rsync delta into a cache there (`HUB_HANDOFF_DELTA`, `HUB_MAC_BYTES`) |
| `ios` | Mac | the app's `ios.device` hook, export with method `debugging`, IPA checks, the Mac outbox, `devicectl device install app` and readback, or pending; the IPA goes back to big-chungus only when the iPad needs it over the air or the link is free |
| `deliver` | Linux | the build directory, under a host lock: versioned objects, `manifest.plist`, `latest.json`, the pages, retention (5 APKs, the newest IPA), forward-only pointers. A dry run checks and renders, and writes nothing |
| `announce` | Linux | one event per run attempt from the job results and receipts (`bb-emit --strict`), with statuses and links; a dry run only checks it |

A dry run never commits to the remote, tags, installs, publishes, uploads or emits. Each lane applies the plan's bump to its own checkout, so the dry run builds and checks the next version. The hub only installs in place (`adb install -r`, `devicectl device install app`) and never removes an app, clears its data or downgrades it; a test greps `tools/` (the catch-up too) for those commands.

## The build directory

MinIO bucket `builds` (public read, written only from big-chungus over `127.0.0.1:9012` by the MinIO user `mobile-deploy-hub`, whose keys are the DeLoSecrets item "MinIO builds writer (mobile-deploy-hub)", read with `op read` at call time into the `mc` child's environment only):

```
builds/index.html, index.json                    every app: newest version, device states, install links
builds/<slug>/index.html                         Install APK, Install on iPad, device states, sizes, commit, run, history
builds/<slug>/latest.json                        the delivery contract (tools/ci/lib/latest.mjs), read by the catch-up
builds/<slug>/inflight.json                      a real run between plan and deliver
builds/<slug>/ios/manifest.plist                 the one OTA manifest, always the newest IPA
builds/<slug>/<X.Y.Z>/<slug>-<X.Y.Z>-<code>.apk, <slug>-<X.Y.Z>-<build>.ipa, icon-57.png, icon-512.png, receipt.json
```

## Use it from an app

1. Hub Actions access is `user` (set once: `gh api -X PUT repos/delorenj/mobile-deploy-hub/actions/permissions/access -f access_level=user`).
2. Register a Linux runner on big-chungus (started through `runsvc-op.sh`, so jobs have `OP_SERVICE_ACCOUNT_TOKEN`) and a macOS runner on the Mac (LaunchAgent through `~/actions-runner/runsvc-op.sh`, which reads the service-account token from the login keychain; never a file).
3. Copy [`templates/deploy.yml`](templates/deploy.yml) to `.github/workflows/deploy.yml` (only comment lines may differ: the gate hashes the normalized file), write `tools/ci/mobile-deploy.json` (below) and the shared `mise run deploy` task, which fetches [`tools/deploy.mjs`](tools/deploy.mjs) from this repo at the ref `deploy.yml` pins (`v1`) and runs it.
4. One hub release adds the app to `apps` in `tools/ci/policy.json`.

The `REAL` in a real run's title is how the front door finds the last real run. Callers pin `@v1`; inside the hub, every `actions/hub@` ref is one exact tag, so a run and its reruns use one hub version. `mise run release -- X.Y.Z` flips them, tags, moves `v1`, and proves the release with one strict `--dry-handoff true` dry run per app (the iPad proof, once per hub version), moving `v1` back if any is red.

## The manifest (schema 2)

| Key | Meaning |
|---|---|
| `project` | `{slug, name, icon?}`: the pjangler slug (it must match the policy), the name the event uses, and an optional square PNG for the iPad's install prompt |
| `version.read` | prints one line of JSON: `{"version":"X.Y.Z","android_code":N,"ios_build":...}` |
| `version.bump` | `<level>` is appended; rewrites the app's version authority files (no git) and prints the same JSON plus `"files"`, exactly the files it changed |
| `android.package`, `prepare`, `export`, `artifact`, `receipt`, `signer_sha256` | the APK; the signer pin is mandatory (the key on the phone) |
| `android.bundle`, `bundle_artifact` | the Play AAB, used with `--play` |
| `ios.bundle`, `device`, `device_artifact` | the Mac hook that leaves an unsigned `.xcarchive` (the hub exports it) or an `.ipa` in `$HUB_OUT/ios` |
| `ios.export`, `archive`, `receipt`, `prepare` | optional Linux half (Tower's Godot export), handed to the Mac |
| `ios.store` | `{archive, receipt, upload, assign, signer_sha1, secrets}` for `--testflight` (Tower only) |

Hooks are shell commands from the committed manifest, run under `bash -eo pipefail` in the app root with `HUB_OUT`, `HUB_DRY_RUN`, `HUB_VERSION`, `HUB_ANDROID_CODE`, `HUB_IOS_BUILD`, `HUB_TEAM` set, and throwaway `GITHUB_ENV`, `GITHUB_OUTPUT`, `GITHUB_PATH` files. Store, GitHub, OIDC and MinIO credentials never reach a hook. Unknown keys, non-string hooks and paths outside the checkout are rejected; schema 1 is gone. Devices (the S26, the iPad, the Apple team and signer, the Mac's ssh alias `hub-mac` and tailscale peer, big-chungus's staging) live once, in [`tools/ci/devices.json`](tools/ci/devices.json).

## Hosts and checks

```sh
mise run check          # actionlint on the workflow, then node --test 'tools/**/*.test.mjs' (the catch-up included)
mise run conformance    # every app still deploys only through the hub (gh api)
mise run hosts:install  # the bucket index, hub-mac, the Mac's quickdrop .stignore and handoff cache, the catch-up units
```
