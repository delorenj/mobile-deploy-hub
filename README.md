# Mobile Deploy Hub

One deploy contract for Jarad's mobile apps: Tower of Lost Things (`tower-of-lost-things`, renamed from `pile-of-dumb-things` on 2026-10-09; the S3 build folder moved with it), Green In Between (`green-in-between`) and Gruvato (`gruvato`). The hub is a library: one reusable workflow, one composite action, a Node tool and one policy file. Each app calls it from `.github/workflows/deploy.yml`, a verbatim copy of [`templates/deploy.yml`](templates/deploy.yml) pinned to the floating `@v1`, and the jobs run on the app's own repo-scoped runners (big-chungus for Linux, the Mac for macOS). The hub has no runners, no secrets and no CI of its own. Design: [docs/design-hub-v1.1.md](docs/design-hub-v1.1.md) (v1.0: [docs/design-hub-v3.md](docs/design-hub-v3.md), v2 history: [docs/design-hub-v2.md](docs/design-hub-v2.md)).

## Deploy

Every new version of an app deploys through this hub, the same way in all three repos, from any machine with `gh`, wherever the devices are:

```sh
mise run deploy                    # dry run: builds and checks everything; publishes, installs and sends nothing
mise run deploy --dry-run false    # real: patch bump, publish, install where the devices are, one Bloodbank event
mise run deploy:train --dry-run false   # in the hub: Tower, then Green In Between, then Gruvato; stops at a red run
```

A real deploy bumps the patch version (`--bump minor` or `--bump major` for more), commits and tags it on `main`, builds the APK and the iPad IPA, and publishes them to the build directory ([https://s3.delo.sh/builds/index.html](https://s3.delo.sh/builds/index.html), or just `s3.delo.sh/builds` in a browser: Install APK, Install on iPad), Quickdrop (`~/quickdrop/builds`, APKs up to 120 MB, only while the S26 syncs from the LAN) and the private Release `vX.Y.Z`. It installs in place on the S26 and the iPad when they are reachable and reads the version back. **An away device is `pending`, not a stop**: the run goes green, the ntfy notification carries the install links (with the download's size), and a catch-up installs the build when the device is back (2 minutes on the S26, 5 on the iPad; `tools/catchup/`), never while the app is on screen. One `bloodbank.project.deployment.completed` (or `.failed`) event names each device's status (`installed`, `pending`, `skipped`, `failed`) and carries the links. `--platform android|ios` narrows it; `--metered allow` builds the iPad lane even when the Mac's metered link would go over its data budget. A deploy that failed after its bump is finished with `gh run rerun <run-id> --failed` (same version, same commit); the front door offers it for 7 days (the window of its receipts and staging), and after that a new version is the way.

Nothing has to be at home first: the `gate` job reads the Mac's link (home, metered or offline, from tailscale, this app's own Mac runner and GitHub's view of it) and the S26 itself, and skips the iPad lane when the Mac is offline or a metered link would go over budget. The APK half never waits for the Mac (`deliver-android`), and a Mac that goes away after the gate costs the iPad lane, not the deploy: the plan probes the Mac again (`skip-lost`), and the host watchdog gives up an iPad job no runner takes within `mac.queue_limit_min` (15 minutes) instead of letting GitHub hold it for 24 hours.

**One-time setup on the devices:**
- **S26:** subscribe the ntfy app to `bloodbank` on `https://ntfy.delo.sh` (it already is). In Syncthing on the S26, set the run conditions to Wi-Fi only (Settings > Run conditions, at least for the `quickdrop` folder); the hub also writes Quickdrop only while the S26 syncs from the LAN, but the phone decides when it pulls. The first Install APK asks once to let the browser install unknown apps.
- **iPad (and an iPhone):** subscribe ntfy-ios to **`deploys`** on `https://ntfy.delo.sh`. iOS wakes only for topics the ntfy upstream gate forwards, never for the `bloodbank` firehose; the router copies every deploy event there. Bookmark `https://s3.delo.sh/builds/index.html` in Safari as the fallback.
- **GitHub app:** bookmark each app's Deploy workflow (Run workflow, untick `dry_run`).

**The taps:**
- **S26 away:** Install APK in the notification, then Download (Chrome warns that the file type can harm the device), Open, Update. On Wi-Fi at home it is shorter: Files > Quickdrop > builds > the APK > Update, or nothing at all, since the catch-up installs it within 2 minutes once the S26 is on big-chungus's adb.
- **iPad away:** Install on iPad in the notification (or Install on the build page in Safari), then Install in the iPadOS prompt.
- **Back home:** nothing. The catch-up installs or confirms each pending build and sends one notification per device; it waits while the app is on screen.

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

*Status (2026-10-09): v1.1 is out; `v1` points at `v1.1.6` (`fd826d9`, released green — Tower 38011234012 ran the whole lane set with the Mac home, so the renamed handoff cache and runner work folder are proven; Green In Between 38011453208 and Gruvato 38011955640 green; `hosts:install` put `releases/v1.1.6` on both hosts). `v1.1.6` also carries the rename's review fixes: the old slug's pointer page names the explicit `index.html` key (the bucket serves no directory index), a catch-up pass that can read no manifest names the apps instead of `no apps`, and the design doc's normative examples state the renamed repo and slug. Before it, `v1.1.5` (`db089d6`) rode the rebrand — Tower `delorenj/tower-of-lost-things`, slug `tower-of-lost-things`, the S3 build folder moved to `builds/tower-of-lost-things/` (the old folder serves a pointer page), the catch-up on both hosts reading the new slug with the devices' states preserved (design doc, "Build log: the rebrand rename") — with `v1.1.3` and `v1.1.4` burned by their own Tower dry runs (a Godot cache wiped by the rename, then the import SIGSEGV, absorbed since Tower `ebc9e88`). Before the rename, `v1` pointed at `v1.1.2` (`9bee7ff`); its release dry runs were green in all three apps — Tower 37975743662 (the Mac on a metered hotspot: 37 KB handoff delta, 24 KB out), Green In Between 37977334285 and Gruvato 37979031860 (the Mac home on the LAN). `v1.1.0` and `v1.1.1` were burned by their own release dry runs (1Password references with spaces; the Mac dropping off the tailnet mid-handoff). Design and build log: [docs/design-hub-v1.1.md](docs/design-hub-v1.1.md).*

## What a run does

| Job | Runs on | Does |
|---|---|---|
| `gate` | Linux | the policy on this run: the repo is listed, the manifest is schema 2 with every lane, the caller is the template (normalized hash in `callers.accept`), strict, runners and manifest are the policy's, a real run uses a released hub on `main`; then the Mac's link, the S26, and an S3 write probe. Decides the iPad lane: `run`, `skip-offline`, `skip-metered` |
| `preflight-ios` | Mac | no checkout: the development identity signs, a profile covers the iPad for 30+ days, 15 GiB free; the iPad's installed version, or `unreachable` (pending) |
| `plan` | Linux | the S26 (away after 180 s is pending), the event contract, the downgrade guards (the S26, the published `latest.json`, a newer iPad), then the bump. Real: commit, tag, `git push --atomic` to `main`, `inflight.json`. Dry: the same commit, tag and `git push --dry-run --atomic`, then rewound |
| `android` | Linux | build, signer pin, APK identity, staging for deliver, `adb install -r` and readback on the S26, or pending; Quickdrop (real, only while the S26 syncs from the LAN, never over a newer APK); the private Release `vX.Y.Z` (its own receipt: a failed upload is stage `deliver`, the S26 keeps its status) |
| `ios-export` | Linux | Tower only: Godot's Xcode project, handed to the Mac as an rsync delta into a cache there (`HUB_HANDOFF_DELTA`, `HUB_MAC_BYTES`; a broken transfer resumes from its partial file) |
| `ios` | Mac | the app's `ios.device` hook, export with method `debugging`, IPA checks, the Mac outbox, `devicectl device install app` and readback, or pending; the IPA goes back to big-chungus when the iPad needs it over the air (a refused install too) or the link, read again on the Mac, is free |
| `deliver-android` | Linux | the APK half of the build directory, under a host lock, as soon as the android job ends (it never waits for the Mac): the APK, `latest.json`'s android block, the pages, retention (5 APKs), forward-only pointers |
| `deliver-ios` | Linux | the IPA half when the ios job ends: the IPA, `manifest.plist`, `latest.json`'s ios block, the pages (the newest IPA only). A dry run of either checks and renders, and writes nothing |
| `announce` | Linux | one event per run attempt from the job results and receipts (`bb-emit --strict`), with statuses and sized links; a dry run only checks it |

Inside a job every hub command first checks that the run was started by the app's own `.github/workflows/deploy.yml` (`GITHUB_WORKFLOW_REF`); the gate and the plan also hash that caller. A second workflow that `uses:` the hub's action or reusable workflow, at any ref, does nothing, and conformance, every gate (on its own checkout) and the global pre-commit guard refuse one. Each job pins its runner labels itself (`[self-hosted, Linux]`, `[self-hosted, macOS]`).

A dry run never commits to the remote, tags, installs, publishes, uploads or emits. Each lane applies the plan's bump to its own checkout, so the dry run builds and checks the next version. The hub only installs in place (`adb install -r`, `devicectl device install app`) and never removes an app, clears its data or downgrades it; a test greps `tools/` (the catch-up too) for those commands.

## The build directory

MinIO bucket `builds` (public read, written only from big-chungus over `127.0.0.1:9012` by the MinIO user `mobile-deploy-hub`, whose keys are the DeLoSecrets item "MinIO builds writer (mobile-deploy-hub)", read with `op read` at call time into the `mc` child's environment only):

```
builds/index.html, index.json                    every app: newest version, device states, install links
builds/<slug>/index.html                         Install APK, Install on iPad, device states, sizes, commit, run, history
builds/<slug>/latest.json                        the delivery contract (tools/ci/lib/latest.mjs), read by the catch-up
builds/<slug>/inflight.json                      a real run between plan and deliver
builds/<slug>/ios/manifest.plist                 the one OTA manifest, always the newest IPA
builds/<slug>/<X.Y.Z>/<slug>-<X.Y.Z>-<code>.apk, <slug>-<X.Y.Z>-<build>.ipa, icon-57.png, icon-512.png, receipt-android.json, receipt-ios.json
```

`inflight.json` names the platforms a real run builds; each deliver job clears its own, and the catch-up holds every older pending build of those platforms until then. A device block's package, signer and bundle must be the policy's pins (`tools/ci/policy.json` `apps`), or the catch-up refuses the file.

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
mise run conformance    # every app still deploys only through the hub (gh api); every deploy's gate runs it on its own checkout too
mise run hosts:install  # the bucket index, hub-mac, the Mac's quickdrop .stignore and handoff cache, the catch-up units and the Mac watchdog
```

The catch-up installs only on a host in live mode, and both are live since 2026-10-09 (`catchup.mjs mode` prints it; every gate logs `HUB_CATCHUP_MODE`, and a pending device on a host in watch mode reads "catch-up off" in the event and on the page):

```sh
node ~/.local/share/mobile-deploy-hub/current/tools/catchup/catchup.mjs mode live          # big-chungus
ssh hub-mac '~/.local/share/mise/installs/node/24/bin/node ~/.local/share/mobile-deploy-hub/current/tools/catchup/catchup.mjs mode live'
```

The Mac watchdog (`tools/ci/macwatch.mjs`, systemd timer `mobile-deploy-hub-macwatch.timer` on big-chungus, every 2 minutes) cancels a deploy run whose Mac job has waited longer than `mac.queue_limit_min` for its runner, once the run's APK half is done; it uses big-chungus's `gh` login. `HUB_MACWATCH_*` lines in its journal say what it did.
