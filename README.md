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

The front door reads the run it started with one `gh api` call every 30 s and ends only on what the run itself reports: `DEPLOY_GREEN`, or `DEPLOY_RED` for a completed run that did not succeed. GitHub being unreachable or rate limited is no verdict: it backs off (to 5 minutes, or to the rate limit's reset) and keeps asking. Only after 6 hours without a verdict does it end `DEPLOY_UNKNOWN` (exit status 3, neither green nor red) with the run URL and the command to finish by hand (`gh run watch <id> --repo <repo> --interval 30 --exit-status`); a release dry run that ends unknown leaves `v1` where it is instead of rolling it back.

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
2. `mise run release`: it checks a clean tree, runs `mise run check` and `mise run conformance` (every app's caller hash, manifest and out-of-hub drift), tags `vX.Y.Z`, moves `v1`, and proves the release with one strict dry run per app in the policy (Tower, Green In Between, Gruvato, Navi, Earshot) — moving `v1` back if any is red.

Apps need no edit for a policy change: their callers pin `@v1`. A caller changes only when the template itself changes, and the new template's hash joins `callers.accept` in the same release, so moving `v1` never refuses a caller that has not been updated yet.

**Adopting the policy in a new app:**

1. Copy `templates/deploy.yml` verbatim into `.github/workflows/deploy.yml`; it pins `@v1`, and the gate hashes the caller, so never edit it.
2. Write `tools/ci/mobile-deploy.json` (schema 2) and register the app's own repo-scoped runners (Linux on big-chungus, macOS on the Mac).
3. Add the `mise run deploy` task that fetches this repo's [`tools/deploy.mjs`](tools/deploy.mjs) at the pinned ref.
4. One hub release adds the app to `apps` and its caller hash to `callers.accept`.
5. Put the deploy sentence in the app's `AGENTS.md` (see the skillex `mobile-devex` skill) so its agents follow the same rule.

Everything out-of-hub is refused or retired: no app path may bump a version, mint a tag, `gh release create`, upload to TestFlight or install a release build on a device.

*Status (2026-10-25): `v1` points at `v1.2.25` (`36dc85d`), moved by hand on the operator's call. Its release proof stopped red at Navi (40136564561), but that red was a `curl: (56) Recv failure: Operation timed out` inside Navi's own `ios.device` hook, not a hub defect; Tower 40132955028, Green In Between 40133369554 and Gruvato 40135846496 were green. v1.2.23 (red at Gruvato) and v1.2.24 (red at Green In Between) had rolled back to `v1.2.22`, which lacks `a74688b`: an iPad that `devicectl` lists without its live hardware details (asleep or away) is pending, not a red preflight. Without it, every Green In Between and Tower deploy with the iPad asleep failed at `preflight-ios` (GIB 40139297297, Tower 40141625760). If a deploy breaks on it, move `v1` back to `9d4e5c9`.*

*Status (2026-10-13): `v1` points at `v1.2.7` (`4d98f428`), the release that gave Navi its iOS lane (`AutomaticAI-io/james-brennan`, lanes android+ios, bundle `io.automaticai.ipm.navi`, runner `mommymac-james-brennan`) — the first Expo app on the hub: the Linux export prebuilds the Xcode project (`expo prebuild`) into a deterministic tarball and the Mac pods, archives unsigned and, with `--testflight`, re-signs with a pinned App Store profile and uploads with the App Store Connect API key. Its proofs: Tower 38342456660, Green In Between 38342655050, Gruvato 38343228600, james-brennan 38343553935 — and the first real run, navi-v0.2.2 (38347114576): S26 and iPad installed and read back, TestFlight VALID with the Owner Testing invite out. The release took three attempts: v1.2.4 died on the Mac's 15 GiB disk floor (stale simulator runtimes removed), v1.2.5 on a transient Godot import hang, v1.2.6 on a real GIB regression from POOL-11 (velocity clamps bound `apply(dt=0)`; fixed at the source, green-in-between `7132561`). Navi's first two store-lane runs taught the hooks: re-run `pod install` after untarring the store project (the lockfile's COCOAPODS line), and never automatic signing with the App Manager-role key (manual pinned-profile export; the key authenticates the upload only). v1.2.4 and v1.2.5/v1.2.6 tags are burned by their own dry runs, as designed. Before this, v1.2.x brought Navi onto the hub Android-only (first deploy navi-v0.1.1, run 38179298829).*

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
| (tag-versioned apps) | an app whose policy entry says `"version": "tag"` keeps its version in its tags alone: `version.read` reads the newest `<tag_prefix>X.Y.Z` tag, `version.bump` changes nothing and prints `"files": []`, and the plan pushes only the annotated tag on main's tip (no commit; main may require pull requests). `tag_prefix` (default `v`) also names the Release. Navi (`AutomaticAI-io/james-brennan`, `navi-v`) is the first |
| `android.package`, `prepare`, `export`, `artifact`, `receipt`, `signer_sha256` | the APK; the signer pin is mandatory (the key on the phone) |
| `android.bundle`, `bundle_artifact` | the Play AAB, used with `--play`: a dry run builds it and mints the Play token through the caller's `vars.GCP_WIF_PROVIDER` and `vars.PLAY_SA_EMAIL` (the keyless exchange, proven before a version is spent) and never contacts Play; a real run uploads it to the `internal` track as a `completed` release, so testers get it at once (other tracks default to `draft`; the workflow's `play_status` input, empty by default, overrides either). Google refuses a non-draft release on an app that has never been published ("Only releases with status draft may be created on draft app"): when the status came from the default, the hub retries once in the same edit as a `draft`, logs `PLAY_DRAFT_APP` and you roll it out in Play Console; an explicit `completed` fails loudly (receipt `android-play`) |
| `ios.bundle`, `device`, `device_artifact` | the Mac hook that leaves an unsigned `.xcarchive` (the hub exports it) or an `.ipa` in `$HUB_OUT/ios` |
| `ios.export`, `archive`, `receipt`, `prepare` | optional Linux half (Tower's Godot export), handed to the Mac |
| `ios.store` | the TestFlight lane, `--testflight`. With `ios.export` (Tower, Navi) it is `{archive, receipt, upload, assign, signer_sha1, secrets}`: the Linux half writes the App Store Xcode project. For a Mac-only app (no `ios.export`, Green In Between) it is `{bundle?, build, artifact, upload, assign, signer_sha1, secrets}`: `build` runs on the Mac in a dry run too and leaves the signed App Store IPA `artifact` in `$HUB_OUT/ios`; the hub checks that IPA (the planned bundle, version and build number, signed by the pinned `signer_sha1`, an App Store profile that lists no devices, no `get-task-allow`) and only a real run calls `upload` then `assign`. `bundle` is the App Store bundle id when it differs from `ios.bundle`; the policy pins it as `apps.<repo>.ios.store_bundle`. The preflight also proves the runner can sign with `signer_sha1` |

Hooks are shell commands from the committed manifest, run under `bash -eo pipefail` in the app root with `HUB_OUT`, `HUB_DRY_RUN`, `HUB_VERSION`, `HUB_ANDROID_CODE`, `HUB_IOS_BUILD`, `HUB_TEAM` set, and throwaway `GITHUB_ENV`, `GITHUB_OUTPUT`, `GITHUB_PATH` files. Store, GitHub, OIDC and MinIO credentials never reach a hook. Unknown keys, non-string hooks and paths outside the checkout are rejected; schema 1 is gone. Devices (the S26, the S24, the iPad, the Apple team and signer, the Mac's ssh alias `hub-mac` and tailscale peer, big-chungus's staging) live once, in [`tools/ci/devices.json`](tools/ci/devices.json). Deploys read `android` (the S26) alone; the extra phones in `android_extra` are `hub-device`'s.

## Devices

Two phones are shared by many repos and no one owns them: the S26, which deploys install on, and the S24. Each leases under its own host lock (`~/.cache/mobile-deploy-hub/locks/`, or `$HUB_LOCK_DIR`) — the S26's lock is `adb`, the one a deploy takes for the length of its job, so a lease and a deploy still exclude each other; the S24's is `s24`. `hub-device` takes a lock for a person or an agent for as long as they ask. A lease outlives the command that took it and ends at `release` or at its `--for` expiry; a lease whose `--pid` process is gone (or is now another process) is reclaimed like a dead job. Waiters for a lease queue first in, first out (`<name>.queue/` beside the lock); a deploy keeps polling its lock as before. A deploy itself takes the `adb` lock twice with a gap in between (the plan job's S26 check, then the android job's install), so a lease taken in that gap is not wrong — it simply makes that run's android job wait on the lock (up to its 15-minute limit) and fail if the lease outlasts it; an `s24` lease never touches a deploy at all. `lease` and `run` connect the phone through the same `findPhone` the deploys use (adb server on 5037, matched by `ro.serialno`, the mDNS nudge included, over Wireless debugging or USB) and give you `ANDROID_SERIAL`, `ANDROID_ADB_SERVER_PORT` and `HUB_DEVICE`; SIGINT or SIGTERM while they look for it stops at once and holds nothing. A phone that does not come within `--wait` (default 2m) prints exactly `HUB_DEVICE_AWAY <device>` on stdout and exits 75, holding nothing, with the reason on stderr (`absent` — turn Wireless debugging on, `unauthorized` — pair again, `offline`); a lock that is not free within `--wait` prints `HUB_DEVICE_BUSY <device> ...` (naming the holder) on stderr and exits 76. Check `$?` for both: never `eval` the output unchecked, or the AWAY line runs as a command. `status` only looks: it never kills, starts or reconnects anything but the emulator pool's own expired leases (below), which every invocation reaps first. `tools/catchup/units/install.sh` installs `~/.local/bin/hub-device`, a wrapper that runs the release's copy.

`phone` in place of a device name takes whichever phone is free and reachable: the S24 first, then the S26. It is an ordered try with `--wait` as one overall budget — each pass takes a free phone's lock and gives that phone a slice of what is left (`HUB_DEVICE_PHONE_SLICE_MS`, default 10s) to appear before falling through to the next, then waits a poll tick and tries again, so a phone that frees or appears mid-wait is picked up. `HUB_DEVICE` in the exports (and the `device` field of `--json`) says which one it took, and `release` frees it by lease id like any other. When no phone comes: every phone held is BUSY (76, naming each holder), a free phone that never appeared is AWAY (75, naming each reason). It does not queue FIFO behind another `phone` taker — the ordered try wins at the next poll; single-device leases (`s24`, `s26`) still queue FIFO on their own locks.

```sh
vars="$(hub-device lease s24|s26|phone --for 30m --why 'tower: S24 proof' [--wait 5m] [--holder WHO] [--env-serial MY_DEVICE] [--verbose])" && eval "$vars"
                                                      # exports HUB_LEASE_ID, HUB_DEVICE (s24|s26), ANDROID_SERIAL, ANDROID_ADB_SERVER_PORT; $? is 75 (away) or 76 (busy) otherwise
hub-device release [<lease_id>|--any]                # no id: $HUB_LEASE_ID (what lease exported); a bare release with neither refuses (exit 2) rather than freeing whatever is there; --any frees whichever phone lease is held; a deploy's lock is never touched
hub-device status [--json]                            # phones (held/free and reachable), leases, waiters, and adb servers / emulators / Xvfb displays marked managed or foreign
hub-device run s24|s26|phone [--for 1h --why TEXT --wait 5m --holder WHO] [--env-serial NAME]... [--verbose] -- <cmd...>   # lease, run, release on any exit; returns the command's code
hub-device lease s26 --for 12h --why 'who: why' --no-connect --id my-hold   # the lock only, phone away or not (adapters, e.g. green-in-between's loop-ship hold)
```

The phones are found the same way over Wireless debugging (the default; the mDNS nudge connects when auto-connect is slow) and over USB (plug in a data cable). `--holder` names who holds the lease (default `$HUB_DEVICE_HOLDER`, else `user@host`); `--verbose` adds the full why-the-phone-was-away detail to an AWAY. `release` answers `HUB_DEVICE_RELEASED` (naming the phone), `HUB_DEVICE_CANCELLED` (it was still queued) or `HUB_DEVICE_NOT_HELD` (nothing, or something else, holds it; exit 0 either way), and exits 1 only when it would have to touch a deploy job's lock or a lock that is mid-change. `status`'s PHONES block reads one `adb devices` query (plus the mDNS service list, to tie a bare `host:port` id back to its phone) — only when the inventory shows the adb server already running, so status still starts nothing — and says for each phone `reachable`, `unauthorized`, `offline`, `absent`, or why it could not ask.

The hub's own adb server (the port deploys use) is `managed`; an emulator or Xvfb is `managed` only when its environment has `HUB_MANAGED=1` or its pid is in `<lock dir>/managed.json` (`{"pids": [...]}`), and everything else is `foreign`.

Rollout: leases are honoured only by hub code with this `lock.mjs`. A deploy on an older pin (`actions/hub@v1.2.25` and before) and a catch-up from an older `current` see a lease's short-lived `pid` as a dead job and reclaim the lock at once. So the hub release that carries leases (the pin flip) must land before, or with, `hosts:install` putting `hub-device` on PATH; until then `lease` and `run` print one warning on stderr when `~/.local/share/mobile-deploy-hub/current` predates leases — that warning sees only the installed catch-up, never the deploys' pin, so the pin flip landing first is the only real guard.

### Emulators

`hub-device lease|run emulator` gives you a throwaway emulator from a small pool instead of the phone: made for your lease and torn down at its end. Nothing about it is shared, so it never touches anybody else's emulator, adb server or AVD.

```sh
vars="$(hub-device lease emulator [--profile default|playstore] --for 30m --why 'tower: layout proof' [--wait 5m] [--id ID] [--pid N] [--holder WHO] [--env-serial MY_DEVICE] [--json])" && eval "$vars"
                                                      # exports HUB_LEASE_ID, ANDROID_SERIAL (emulator-<port>), ANDROID_ADB_SERVER_PORT; $? is 76 when the pool is full
adb shell getprop ro.kernel.qemu                      # the exports point adb at the emulator's own server
hub-device release emulator [<lease_id>]              # no id: $HUB_LEASE_ID; an empty or malformed id is refused (exit 2), never "any lease"; `hub-device release <lease_id>` works too
hub-device run emulator [--profile default|playstore --for 1h --why TEXT --wait 5m] [--env-serial NAME]... -- <cmd...>   # make, run, tear down on any exit; returns the command's code
```

- **What a lease makes.** A private adb server on a free port in 15000-15099 (never 5037; it never scans the shared emulator ports 5555-5585 and never connects over mDNS or USB (`ADB_MDNS=0`, `ADB_USB=0`), so it cannot pick up the S26 or somebody's emulator), a free even console port in 5600-5698 whose adb port (+1) is free too and overlaps nobody's pair (5554 never; a `HUB_EMULATOR_CONSOLE_PORTS` override reaching below 5586 is refused), and its own AVD `hub-<lease_id>` made by `avdmanager` from the profile in its own AVD home under `~/.cache/mobile-deploy-hub/emulators/<lease_id>/` (never `~/.android/avd`). The emulator starts headless (`-no-window -no-audio -gpu swangle_indirect -no-snapshot -wipe-data`) with its own `TMPDIR` and `XDG_RUNTIME_DIR`, so it never shares a netsimd or discovery file, and the lease returns once `sys.boot_completed=1` (`HUB_EMULATOR_BOOT_TIMEOUT_MS`, default 6 min). `--for` runs from that moment, so a slow boot never eats the lease.
- **Profiles.** Both are API 36, x86_64, 1080x2400 at 420 dpi, 2 GB, 4 cores. `default` uses `system-images;android-36;google_apis;x86_64` and `playstore` uses `system-images;android-36;google_apis_playstore;x86_64`. Each uses exactly its own image: no fallback, no download. A missing image fails at once with one line naming it and the `sdkmanager` command that installs it. Both are installed on big-chungus.
- **The record.** `<lock dir>/emulators/<lease_id>.json` and the slot's lease record name every process the lease started (adb server, emulator, and the helpers it daemonizes, such as crashpad_handler and netsimd, found by the lease's own `HUB_EMULATOR_LEASE=<lease_id>.<nonce>` environment marker, the nonce kept in the record), each with its process start time, plus every path it made. Release or expiry signals exactly those processes, each only after checking its pid still has the recorded start time: SIGTERM, then SIGKILL after `HUB_EMULATOR_KILL_GRACE_MS` (default 15s), the emulator and its helpers before its adb server. It then rescans for the lease's marker and stops, the same way, any helper started during shutdown. Then it deletes the AVD (`.ini` and `.avd`), the folders and the record, and frees the slot and the ports. Nothing is ever killed by name, pattern or process group. If any recorded or marked process will not die, the record stays, so its slot stays out of the pool until the next reap succeeds. A release frees the slot lock before the teardown, so a `lease` still booting that emulator ends as `HUB_DEVICE_CANCELLED emulator`. The record keeps the slot out of the pool until the teardown is done.
- **The cap.** At most 2 emulators at once. The cap is the host's: `$HUB_EMULATOR_POOL`, else the number in `<lock dir>/emulator-pool`, 1 to 8. A request may pass `--pool N` only to ask for fewer, and a larger N is refused (exit 2). Slots are the locks `emulator-1` .. `emulator-N`. Requests queue first in, first out on the `emulator` lock: the first in line holds it and takes the first slot that frees. `--wait` (default 2m) bounds the wait, and a full pool exits 76 with `HUB_DEVICE_BUSY emulator the emulator pool is full ...` on stderr, naming the slots' holders, or the requests ahead when others are already waiting. `release <id>` cancels a request that is still waiting.
- **The reaper.** There is no timer, cron job, unit or Candybar job. Every `hub-device` invocation (`status` included) first tears down the pool's leases that expired, whose `--pid` holder (or `run` process) is gone, or whose slot no longer holds them. It touches only their recorded, identity-checked processes and logs `HUB_EMULATOR_REAPED <id> <slot> (<why>)` on stderr. So an expired lease keeps its emulator until the next `hub-device` call on the host. While a lease is still being made it is tied to the process making it, so killing that process mid-boot leaves nothing for long.
- `status` lists the pool's emulators under EMULATORS, and in the inventory their adb server and emulator are `managed (lease <id>)`. Everything else stays `foreign` and is never touched. Linux (big-chungus) only. Prefix `heavy` (`heavy hub-device run emulator -- ...`) to put the boot in `batch.slice`.

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
