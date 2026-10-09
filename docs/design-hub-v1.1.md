# Mobile Deploy Hub v1.1.0: one policy, deploy from anywhere, links in the push

Status: design, 2026-10-09. Nothing here is built yet. It answers Jarad's four asks:
1. one deploy rule for every mobile deployer (patch bump, one Bloodbank event, and the rest);
2. deploy while away, and still get every device updated, through S3, Quickdrop or a later automatic install;
3. deploy Tower, then Green In Between, then Gruvato;
4. an ntfy notification, driven by the Bloodbank event, with download links.

It extends [design-hub-v3.md](design-hub-v3.md) (hub `v1.0.0`). Everything there still holds unless a section below changes it: the bump in `plan`, real runs only on `main`, the build must match the plan, signer pins, in-place installs, host locks, dry runs that change nothing, one event per run attempt, and every `HUB_*` marker.

## How this design was chosen

Three independent designs were scored from 1 to 10 on five criteria.

| | answers both asks | no path bypasses the policy | remote delivery, fewest taps | failure modes and data budget | size of change (10 = smallest) | total |
|---|---|---|---|---|---|---|
| minimal | 8 | 6 | 8 | 6 | 9 | 37 |
| **robust** (winner) | 9 | 9 | 8 | 9 | 5 | **40** |
| frictionless | 8 | 7 | 9 | 7 | 6 | 37 |

The winner is **robust**. It has a gate job that runs before any version or Mac byte is spent, a caller allowlist, a separate `deliver` job, forward-only pointers, a failure-mode table and a delta handoff.

Ideas taken from the other two:
- **From minimal:**
  - the policy digest in every job's log and every receipt;
  - hooks get throwaway `GITHUB_ENV`, `GITHUB_OUTPUT` and `GITHUB_PATH` files;
  - Quickdrop writes through Syncthing's own temporary-file name, then renames;
  - deploy events skip the router's rate limits (loud types);
  - the `tailscale nc` ssh route to the Mac, which minimal tested;
  - the release procedure that moves `v1` back after a red dry run.
- **From frictionless:**
  - Jarad's tap list;
  - the `deploy:train` task that runs Jarad's order;
  - the `skipped` delivery status;
  - one `.failed` event after three failed catch-up attempts;
  - the `--rsyncable` and sorted-tar fallback for the handoff.

Everything else dropped from the runners-up is listed in "Rejected" at the end.

## Decisions

### D1. Callers pin a floating `@v1`; every run uses one exact hub version

- Each app's `deploy.yml` pins `delorenj/mobile-deploy-hub/.github/workflows/mobile-deploy.yml@v1`. This is the last hub edit any app needs for v1.x.
- Inside the hub, the workflow's `actions/hub@` refs stay exact (`@v1.1.0`). So a run, and every rerun of it, uses one hub version. Receipts and events keep the exact `run.hub_ref` (`github.action_ref` of the inner action).
  - GitHub keeps a run's original workflow file on a rerun. It fetches the action ref again, but that ref is an exact tag that never moves.
- `mise run release` (in the hub) ships a release:
  1. checks the work tree is clean, `mise run check` passes, and all of `policy.callers` is consistent (see A3);
  2. flips the inner refs to `vX.Y.Z` in one commit, tags it, and pushes;
  3. force-moves `v1` to that tag and pushes it (GitHub Free has no tag protection);
  4. runs one strict dry run with `--dry-handoff true` per app, in Jarad's order (Tower, Green In Between, Gruvato);
  5. if any of them is red, moves `v1` back to the previous tag and says so. The run ids go into the annotation of `vX.Y.Z`.
- Breaking changes (a removed input, a stricter manifest) wait for `v2`. A hub test freezes the v1 caller surface.
- The front door's iPad proof ledger (`~/.local/state/mobile-deploy-hub/ipad-proofs.json`) is retired. Reasons:
  - it is a local file on big-chungus;
  - it is keyed by the ref, so a stale proof still passes;
  - under `@v1` it looks up `v1` but records `v1.1.0`, so every real iPad deploy would be refused;
  - the release procedure's dry runs now prove each app's IPA once per hub version, which is what the ledger was for.

### D2. The policy lives in the hub, and the hub's own jobs enforce it

- The rules live in one file: `tools/ci/policy.json`, at the exact tag.
- The jobs read it from the action path. It is never taken from an input, an environment variable, the app manifest or a hook.
- The front door, `gh workflow run`, the GitHub mobile app's Run workflow button and reruns all run the same jobs, so they all obey it.
- Only the hub can change the rules: a policy change is a hub release.

### D3. An absent device is pending, not a stop

- When a device is away:
  - the version is still bumped;
  - the build is checked as today;
  - the build is published to S3, Quickdrop and the GitHub Release;
  - that device's delivery is `pending`, and the run is green;
  - a catch-up unit installs the build when the device is back, and sends its own notification.
- These still stop the run before the bump: a broken Mac (signing, profile, disk), a wrong device, a planned downgrade, a broken event contract and a gate refusal.
- A device that is present but refuses the install or the readback still fails the run, as today.

### D4. Only big-chungus writes builds

- MinIO is written only from big-chungus, over a loopback port, as a MinIO user that can write only the `builds` bucket.
- The Mac never writes to S3 or talks to MinIO's API. It sends its IPA to big-chungus over ssh.
- Everyone reads through `https://s3.delo.sh`. Cloudflare caps proxied uploads at 100 MB, not downloads.

## A. The policy

### A1. `tools/ci/policy.json`

```json
{
  "schema": 1,
  "bump": { "levels": ["patch", "minor", "major"], "default": "patch" },
  "event": { "per": "run-attempt", "strict": true, "catch_up": true, "types": ["bloodbank.project.deployment.completed", "bloodbank.project.deployment.failed"] },
  "manifest_schema": [2],
  "apps": {
    "delorenj/pile-of-dumb-things": { "slug": "tower-of-dumb-things", "lanes": ["android", "ios"] },
    "delorenj/green-in-between": { "slug": "green-in-between", "lanes": ["android", "ios"] },
    "delorenj/gruvato": { "slug": "gruvato", "lanes": ["android", "ios"] }
  },
  "callers": {
    "workflow": ".github/workflows/deploy.yml",
    "manifest": "tools/ci/mobile-deploy.json",
    "accept": ["<sha256 of templates/deploy.yml, normalized>"]
  },
  "runners": { "linux": ["self-hosted", "Linux"], "mac": ["self-hosted", "macOS"] },
  "devices": { "absent": "pending", "android_wait_s": 180, "ipad_wait_s": 60 },
  "delivery": {
    "s3": { "bucket": "builds", "public": "https://s3.delo.sh/builds", "write": "http://127.0.0.1:9012", "keep_apk": 5, "keep_ipa": 1 },
    "quickdrop": { "dir": "quickdrop/builds", "max_mb": 120, "keep": 1 },
    "release": true
  },
  "mac": { "lan_cidr": "192.168.1.0/24", "metered_budget_mib": 150 },
  "catch_up": { "android_every_s": 120, "ios_every_s": 300, "max_failures": 3 }
}
```

Notes on the file:
- It sits beside `devices.json`, which is still the device identity registry (S26, iPad, team, development signer, Mac). The `HUB_DEVICES` override still exists, but only for that file and only on a runner host.
- `lib/policy.mjs` parses it strictly: unknown keys are refused, and `"none"` can never be a bump level.
- Every job logs `HUB_POLICY sha256=<8>`, and every receipt records the full digest.
- The MinIO write credentials are not in the file. A1's `write` is only the endpoint. The keys come from 1Password at job time (B4).

### A2. Where each rule is enforced

The `gate` is a new first job, on Linux. It runs before the Mac is touched and before any version is spent.

| Rule | Enforced in | Refusal |
|---|---|---|
| Every deploy bumps (patch default, minor or major allowed, never none) | `lib/config.mjs` levels from the policy; `plan`'s `bumpTransaction` (unchanged) | input error / `HUB_GATE_REFUSED bump` |
| One event per run attempt, sent with `--strict` | `announce`, `if: always()` (unchanged); `plan`'s `eventPreflight` before the bump (unchanged) | red run |
| One event per catch-up install | `tools/catchup/` reporter (E) | — |
| Manifest schema 2 only; the v2 code path is deleted | `gate`; `lib/manifest.mjs` | `HUB_GATE_REFUSED manifest schema 1` |
| The repo is listed, and its manifest declares every lane in `apps.<repo>.lanes` | `gate` | `HUB_GATE_REFUSED lanes` (an app can no longer narrow "both" by dropping a section) |
| The caller file is the hub's template | `gate` reads `GITHUB_WORKFLOW_REF` and `GITHUB_WORKFLOW_SHA`, normalizes the caller file and checks it against `callers.accept` | `HUB_GATE_REFUSED caller` |
| `strict` is true; runner labels and manifest path equal the policy's | `gate` (as well as the caller check) | `HUB_GATE_REFUSED inputs` |
| A real run uses released hub code: `HUB_REF` matches `^v\d+\.\d+\.\d+$` | `gate` | `HUB_GATE_REFUSED hub_ref main` |
| A real run is on `refs/heads/main` | `gate` and `plan` (unchanged) | refusal |
| Android never downgrades: the planned code must be above both the installed code and the newest published code in `latest.json` | `plan` (S26 present or not); `android` lane; catch-up | `HUB_PLAN_REFUSED` / `HUB_CATCHUP_AHEAD` |
| The iPad never downgrades (new) | `preflight-ios` reads the installed version, and `plan` refuses before the bump when it is newer than the plan; the `ios` lane and catch-up compare again | `HUB_IPAD_NEWER` |
| Installs are in place only | `lib/adb.mjs`, `lib/devicectl.mjs`; a test greps `tools/` (now including `tools/catchup/`) for uninstall, `pm clear`, `install -d`, `--downgrade` | test failure |
| Signer pins | `android` lane (unchanged); `deliver` re-checks the APK before publishing; catch-up checks again | refusal |
| Hooks cannot reach job control | `hookEnvironment` gives every hook throwaway `GITHUB_ENV`, `GITHUB_OUTPUT` and `GITHUB_PATH` files (no app hook writes them today) and strips `MC_HOST_*` and every credential variable | — |
| Store lanes are opt-in | unchanged | — |

### A3. The caller template

- The template is `templates/deploy.yml` in the hub: today's `deploy.yml` with these changes:
  - `uses: …@v1`;
  - `permissions` gain `actions: read`, so the front door's last-run lookup can also be done with the job token;
  - a new input `metered` (`auto` | `allow`, default `auto`, see F).
- Normalizing a caller means:
  - LF line endings;
  - comment lines and trailing spaces removed;
  - one space after each `:`.
  
  `callers.accept` lists the sha256 of every template version accepted within v1, so moving `v1` never refuses a caller that has not been updated yet. A hub test asserts that the current template's hash is in the list.
- The caller check closes these holes, so the gate refuses any of them:
  - `strict: false`;
  - another manifest;
  - other runner labels, including hosted ones;
  - a run-name without `REAL`;
  - a re-pin to `@main` or to an old exact tag;
  - narrowed permissions;
  - `on: push`.
- What GitHub Free cannot stop:
  - **An app that stops calling the hub.** These private Free repos get HTTP 403 for rulesets, branch protection, tag protection and required workflows. Three things cover this instead:
    1. `_guard.sh` (the global pre-commit hook) refuses a staged `mobile-deploy-hub` `uses:` line that is not `@v1`, and a staged workflow that runs `gh release create`, `xcrun altool` or `upload-testflight` outside the hub. This is for agents and Jarad on this machine.
    2. `mise run conformance` in the hub checks all three app repos through `gh api`:
       - the caller hash;
       - manifest schema 2;
       - no other workflow that uploads builds;
       - no mise task that tags `v*`, bumps or announces.
       
       `mise run release` runs it first.
    3. Every event carries `run.hub_ref`, so a deploy that went around the hub shows up as one with no hub event.
  - **Out-of-hub paths in the apps.** These are retired as part of the one app edit:
    - Tower's `.github/workflows/testflight.yml` and `mise run testflight` stay only until the first hub `--testflight` run, then they are deleted;
    - Tower's `ios:install` and `android:install`, and Gruvato's `android:install`, become local developer installs: no tag, no event, no Quickdrop;
    - Gruvato's `build`, `tauri-build` and `ios:simulator` stop bumping and tagging. `ios:simulator` keeps its own simulator event, which is not a device deploy.

### A4. How agents learn the rule (RULES builder)

One sentence goes everywhere: **"Mobile app versions ship only through mobile-deploy-hub: `mise run deploy` (dry run), then `mise run deploy --dry-run false`; never bump, tag, `gh release create`, upload to TestFlight or install a release build by hand."**

- **Hub:**
  - a new `AGENTS.md` (`CLAUDE.md` and `GEMINI.md` as symlinks to it): the policy lives in `tools/ci/policy.json`, changes with a test, and ships only through `mise run release`;
  - a "Policy" section in the README.
- **Skill:** skillex `mobile-devex` is rewritten around the hub (front door, policy, remote mode, catch-up, links) and added to the `mobile-dev` set in all three apps.
- **Apps:**
  - the deploy line in each app's `AGENTS.md` is replaced by the sentence above: Tower line 10, Green In Between lines 9 to 12, Gruvato lines 33 to 37 (which lose the out-of-hub bump, tag and announce);
  - each `docs/deploy.md` becomes a two-line pointer to the hub README;
  - Green In Between's stale `.agents/skills/mobile-deploy-hub/SKILL.md` is deleted. Another agent's uncommitted deletion is already on disk, so the RULES builder only stages that path.
- **Global:**
  - the sentence goes in `~/.agents/AGENTS.md`, the source of truth that GEMINI and opencode symlink to;
  - and in the two files that have drifted from it: `~/.claude/CLAUDE.md` (repo delorenj/claude-runtime) and `~/.codex/AGENTS.md`.

## B. Remote deploys

### B1. Jarad's taps

- **Deploy from the phone:**
  1. In the GitHub app, open the app's Deploy workflow (bookmark it).
  2. Tap Run workflow, untick `dry_run`, and tap Run.
- **Deploy from the Mac or big-chungus:**
  - `mise run deploy --dry-run false` in the app;
  - or, in the hub, `mise run deploy:train --dry-run false`. It runs Tower, then Green In Between, then Gruvato, one at a time, and stops at the first red run.
- **Update the S26:** tap **Install APK** in the ntfy notification, then Update. Or open Files → Quickdrop → builds, tap the APK, then Update.
- **Update the iPad:** tap **Install on iPad** in the ntfy notification. Or open the bookmarked `https://s3.delo.sh/builds/index.html` in Safari and tap Install.
- **Back home:** nothing to do. Catch-up installs or confirms each pending build within 2 minutes on the S26 and 5 on the iPad, then sends one notification per device.

### B2. Job graph

`gate` → `preflight-ios` → `plan` → `android` | `ios-export` → `ios` → `deliver` → `announce`

| Job | Runner | v1.1 |
|---|---|---|
| `gate` (new) | Linux | Runs the A2 checks, then reads the state of things (C1, F1), then a MinIO write probe: put and delete `builds/.probe/<run>`. Logs `HUB_GATE ok policy=<sha8> mac=home\|metered\|offline s26=present\|away s3=ok`. Outputs `ios_lane` (`run`, `skip-offline` or `skip-metered`), `metered`, `bundle` and `slug`. |
| `preflight-ios` | Mac | Runs only when `gate.outputs.ios_lane == 'run'`. **No checkout**: the bundle id comes from the gate, so a metered Mac downloads only the hub action. Signing, profile and disk failures still fail it. An unreachable iPad gives `ipad_version=unreachable` and `HUB_IPAD_PENDING`, and the job is still green. |
| `plan` | Linux | Unchanged, except: an absent S26 waits `android_wait_s`, logs `HUB_S26_PENDING` and the bump goes ahead. The downgrade checks use `latest.json`. The iPad check uses preflight's version. A real run writes `builds/<slug>/inflight.json`. |
| `android` | Linux | Build and checks as today. Copies the APK into staging (B5, `HUB_STAGED`) and writes Quickdrop (D, `HUB_QUICKDROP`). Then looks for the S26 for 30 s: if found, `install -r` and readback, otherwise `HUB_S26_PENDING`. Publishes the private Release `vX.Y.Z` after the build checks, whether or not the S26 was there. |
| `ios-export` | Linux | Tower only. The handoff becomes a delta into a persistent cache on the Mac (F2, `HUB_HANDOFF_DELTA bytes=…`). |
| `ios` | Mac | Build and IPA checks as today. Keeps the IPA in the Mac outbox (B5). Sends it to big-chungus when the iPad will need it over the air or the link is not metered (`HUB_OUTBOX_SENT` / `HUB_OUTBOX_SKIPPED`). Then installs and reads back, or logs `HUB_IPAD_PENDING`. |
| `deliver` (new) | Linux | Runs when `plan` succeeded and nothing was cancelled. Under the host lock `s3-<slug>` it uploads the versioned objects, then `manifest.plist`, then `latest.json`, then the pages, in that order (C). Then it prunes old versions and clears `inflight.json`. A dry run logs `HUB_PUBLISH_DRY_RUN`, and nothing is written except the gate's probe. |
| `announce` | Linux | As today, plus the delivery `status`, `data.links` and `data.trigger: deploy` (G). |

When the Mac is offline or over budget, the gate skips `preflight-ios`. That way a phone dispatch never sits in the queue for 24 hours while holding `announce`. The iPad delivery is then `skipped` (not built), with its reason.

### B3. Delivery status, per device

| Status | Meaning | Event |
|---|---|---|
| `installed` | read back in this run (Android also checks the `base.apk` sha256) | `.completed` |
| `pending` | built, checked and published, but the device could not be reached | `.completed`, `verified: false` |
| `skipped` | not built: Mac offline, Mac over its data budget, or `--platform` narrowed it | `.completed`, `verified: false` |
| `failed` | a present device refused the install, the readback did not match, or the wrong device, signer or a downgrade was found | `.failed` |

- `.failed` is sent when any delivery is `failed`, or when `plan`, a build or `deliver` failed.
- `verified` is true only when every delivery in scope is `installed`.

### B4. Front door changes (`tools/deploy.mjs`): works from any machine with `gh`

- **Removed:**
  - the iPad proof ledger (D1);
  - the refusal after a red last real run. The front door still **offers** `gh run rerun <id> --failed` when the last `REAL` run is red, but no longer refuses a new version: catch-up converges the devices either way.
- **Changed:**
  - The S26 adb pre-check is now information only, and only on big-chungus: `DEPLOY_NOTE the S26 is away; it will be pending`.
  - The Mac-online check no longer refuses. It says `DEPLOY_NOTE the iPad lane will be skipped: <runner> offline`. The gate decides.
- **New:**
  - `--metered allow|auto`, passed through as the `metered` input.
  - `mise run deploy:train [--dry-run false]` in the hub.
- **Unchanged:** it dispatches on `main`, watches its own run, and runs `git pull --ff-only` after a green real run. These are conveniences only.
- **Running it on the Mac:** it is fetched with `gh api` at the caller's ref (`v1`), like today. The Mac has node and gh, so `mise run deploy` works there too.

### B5. Staging and the outbox

- **big-chungus staging:** `~/.cache/mobile-deploy-hub/staging/<owner>-<repo>/<run>/`.
  - Holds the APK, the IPA and the receipts. `deliver` reads it.
  - The three apps' Linux runners all run as delorenj on this one host, so they share it.
  - Pruned after 7 days, which is the window for rerunning a real run's artifacts.
- **Mac outbox:** `~/Library/Caches/mobile-deploy-hub/outbox/<slug>/<X.Y.Z>-<build>.ipa`.
  - Keeps the newest two IPAs per app.
  - The iPad catch-up installs from here, so it downloads nothing over a metered link.
  - The IPA is sent to big-chungus over ssh: `rsync` to `<linux.host>:.cache/mobile-deploy-hub/staging/…`.
  - `devices.json` gains `linux: { "host": "big-chungus" }`, an ssh alias on the Mac over the tailnet. Mac → big-chungus ssh works today.

## C. The build directory (S3)

### C1. Bucket, write path, credentials

- **Bucket:** `builds` on MinIO (container `delodrive`).
  - Public read with `mc anonymous set download deloroot/builds`. Jarad is fine with a public builds bucket. An anonymous listing works too, but the generated pages are the interface.
- **Write path:** the MinIO stack (`~/docker/stacks/persistence/minio`) publishes `127.0.0.1:9012:9000`.
  - 9000, 9001 and 9005 are taken on loopback; 9012 is free, checked 2026-10-09.
  - Writes never touch Cloudflare's 100 MB cap (Gruvato's APK is 312 MB) or Traefik.
  - Fallback if the port cannot be published: `MC_RESOLVE=s3.delo.sh:443=<big-chungus LAN address, read at run time>`, which the 10-09 recon proved.
- **Credentials:**
  - A new MinIO user `mobile-deploy-hub` with a policy limited to `s3:PutObject`, `GetObject`, `DeleteObject` and `ListBucket` on `builds` and `builds/*`.
  - Its keys go into a new DeLoSecrets item, "MinIO builds writer (mobile-deploy-hub)". Code refers to it by item UUID once it exists.
  - `deliver`, the gate's probe and the catch-up reporter run `op read` for each key at call time. They build `MC_HOST_builds` in the environment of the `mc` child process only, never in argv, `GITHUB_ENV` or a file.
  - `MC_HOST_*` joins `credentialVariables`, so no hook, `adb` or `bb-emit` ever sees it.
- **Reads:**
  - Phones and the iPad read through `https://s3.delo.sh/builds/…` (Cloudflare cache bypass, HEAD and Range work).
  - The Android catch-up reads from `http://127.0.0.1:9012/builds/…` anonymously.

### C2. Key layout

```
builds/index.html                                   every app: newest version, device states, install links
builds/index.json                                   the same, as data
builds/<slug>/index.html                            app page: Install APK, Install on iPad, device states, sizes, commit, run, history
builds/<slug>/latest.json                           the delivery contract (C3)
builds/<slug>/inflight.json                         {version, run}: a real run is between plan and deliver
builds/<slug>/ios/manifest.plist                    the one OTA manifest, always the newest IPA
builds/<slug>/<X.Y.Z>/<slug>-<X.Y.Z>-<code>.apk
builds/<slug>/<X.Y.Z>/<slug>-<X.Y.Z>-<build>.ipa
builds/<slug>/<X.Y.Z>/icon-57.png, icon-512.png     when the manifest names project.icon (optional new key)
builds/<slug>/<X.Y.Z>/receipt.json                  the run's receipts, merged; no credentials, no paths
builds/.probe/<run>                                  the gate's write probe, deleted at once
```

- **Content types,** always set explicitly at upload:

  | Object | Content-Type |
  |---|---|
  | `.apk` | `application/vnd.android.package-archive` |
  | `.ipa` | `application/octet-stream` |
  | `.plist` | `text/xml` |
  | `.html` | `text/html; charset=utf-8` |
  | `.json` | `application/json` |
  | `.png` | `image/png` |

- **Cache-Control:** `no-cache` on `index.*`, `latest.json`, `inflight.json` and `manifest.plist`. `public, max-age=31536000, immutable` on versioned objects.
- **Upload order:**
  1. versioned objects;
  2. `manifest.plist`;
  3. `latest.json`;
  4. `index.json` and the pages.
  
  So a reader never sees a pointer to bytes that are not there yet.
- **Retention:** five APK versions per app; IPAs, newest only. OTA allows downgrades, so no older IPA is ever reachable. An old IPA URL returns 404.
- **Forward only:** `deliver` replaces a platform block in `latest.json` only when the new (version, code or build) is greater, or equal with the same sha256 (a rerun). Otherwise it logs `HUB_POINTER kept <newer>` and changes nothing.

### C3. `latest.json`: what the catch-up installers and the pages read

```json
{
  "schema": 1,
  "slug": "tower-of-dumb-things",
  "name": "Tower of Lost Things",
  "version": "0.2.2",
  "commit": "<40 hex>",
  "hub_ref": "v1.1.0",
  "run": { "repo": "delorenj/pile-of-dumb-things", "id": "37940000000", "attempt": 1, "url": "https://github.com/delorenj/pile-of-dumb-things/actions/runs/37940000000" },
  "correlation": "<UUIDv5 of mobile-deploy:<repo>:<run id>>",
  "updated_at": "2026-10-09T20:00:00Z",
  "android": {
    "package": "io.automaticai.towerofdumbthings", "version": "0.2.2", "code": 4,
    "key": "tower-of-dumb-things/0.2.2/tower-of-dumb-things-0.2.2-4.apk",
    "url": "https://s3.delo.sh/builds/tower-of-dumb-things/0.2.2/tower-of-dumb-things-0.2.2-4.apk",
    "bytes": 72300000, "sha256": "<64 hex>", "signer_sha256": "<64 hex>",
    "quickdrop": "builds/tower-of-dumb-things-0.2.2-4.apk",
    "device": { "name": "S26", "model": "SM-S948U", "status": "pending", "since": "…", "by": null, "reason": "not on big-chungus's adb", "failures": 0 }
  },
  "ios": {
    "bundle": "io.automaticai.towerofdumbthings", "version": "0.2.2", "build": "4",
    "key": "tower-of-dumb-things/0.2.2/tower-of-dumb-things-0.2.2-4.ipa",
    "url": "https://s3.delo.sh/builds/tower-of-dumb-things/0.2.2/tower-of-dumb-things-0.2.2-4.ipa",
    "bytes": 27300000, "sha256": "<64 hex>",
    "manifest_url": "https://s3.delo.sh/builds/tower-of-dumb-things/ios/manifest.plist",
    "install_url": "itms-services://?action=download-manifest&url=https://s3.delo.sh/builds/tower-of-dumb-things/ios/manifest.plist",
    "device": { "name": "iPad", "model": "iPad14,5", "status": "installed", "since": "…", "by": "deploy", "reason": null, "failures": 0 }
  }
}
```

How the fields are used:
- `device.status` is one of `installed`, `pending`, `skipped`, `failed`. `device.by` is one of `deploy`, `catch-up`, `manual`.
- A platform that was not built keeps its previous block (status `skipped` and a reason) or is `null`.
- The `ios` block may have `url: null` when the iPad was installed in the run and the link was metered (`HUB_OUTBOX_SKIPPED`). Its page then reads "installed; no over-the-air copy".
- Who writes the file:
  - only `deliver` and the catch-up reporter, both on big-chungus, both under the `s3-<slug>` lock;
  - the reporter changes only `device` fields, and only while the block still names the version it installed.
- `lib/latest.mjs` (HUB) holds the parser and validator. The catch-up code imports them; it does not copy them.

### C4. The OTA manifest and the pages

- `manifest.plist`:
  - one `software-package` asset (the IPA's URL);
  - `display-image` and `full-size-image` when `project.icon` exists, resized by `deliver`;
  - metadata: `bundle-identifier`, `bundle-version` (the short version), `kind: software` and `title`.
- The install link: `itms-services://?action=download-manifest&url=https://s3.delo.sh/builds/<slug>/ios/manifest.plist`. It is not percent-encoded, as in Apple's documentation; `URL(string:)` accepts it.
- The pages are static HTML rendered by `deliver`, using no external scripts, so Safari on the iPad and Chrome on the S26 open them directly.

## D. Quickdrop

- **Layout:** `~/quickdrop/builds/<slug>-<X.Y.Z>-<code>.apk`. Only hub APKs go there. The existing loose APKs at the root and in `android/` are Jarad's and are left alone.
- **Atomic write:**
  1. copy to `~/quickdrop/builds/.syncthing.<name>.tmp`, a name Syncthing never syncs;
  2. `fsync`;
  3. `rename` it into place;
  4. check `lstat` shows a regular file (never a symlink: Syncthing symlinks break APK installs).
- **Retention:** one APK per app. Older hub APKs of the same slug are removed after the rename.
- **Size cap:** 120 MB (`HUB_QUICKDROP_SKIPPED <bytes>`). Tower (72 MB) and Green In Between (96 MB) fit. Gruvato's 312 MB debug APK does not; its page and the ntfy button still link to S3.
- **Peers:** the folder syncs to phoneballs, PottyBarron (the S26), tiny-chungus, Tom and mommymac.
  - The Mac's quickdrop `.stignore` gains `/builds`, so APKs never cross its hotspot.
  - On the S26, Syncthing pulls each new APK automatically. On cellular that costs phone data. Jarad sets Syncthing on the S26 to sync on Wi-Fi only (the hub cannot), so Quickdrop is the "already on the phone when back on Wi-Fi" channel and the ntfy button is the "now" channel.
- **Who writes:** `android` (real runs only). Dry runs write nothing.

## E. Catch-up installers

The code lives in `tools/catchup/`, owned by the CATCHUP builder. The HUB builder never edits that directory.

It imports these hub modules read-only, and their exported signatures are frozen for v1:
- `tools/ci/lib/adb.mjs` (`createAdb`, `findPhone`);
- `devicectl.mjs` (`createDevicectl`, `createIpad`);
- `lock.mjs` (`withLock`);
- `announce.mjs` (`bbEmit`, `correlationFor`, `sanitizeReason`);
- `latest.mjs`;
- `receipt.mjs` (`sha256File`);
- `android.mjs` (`verifySigner`, `apkIdentity`).

### E1. Units

| Host | Unit | Runs | Every |
|---|---|---|---|
| big-chungus | systemd user units `mobile-deploy-hub-catchup.timer` and `.service` (`~/.config/systemd/user/`, `Persistent=true`). The `.service` is `Type=oneshot`, has `Environment=HOME=%h` and `ExecStart=node %h/.local/share/mobile-deploy-hub/current/tools/catchup/catchup.mjs android`. Linger stays on, as the runners already need. | the S26 pass | 120 s |
| Mac | LaunchAgent `sh.delo.mobile-deploy-hub.catchup` (`~/Library/LaunchAgents/…plist`). It is bootstrapped into `gui/502`, because devicectl and the keychain work only in Jarad's GUI session, never over plain ssh. `StartInterval 300`, `ProgramArguments` = node (absolute path from mise) `…/current/tools/catchup/catchup.mjs ios`, `PATH` includes `/usr/bin:/opt/homebrew/bin` and the mise shims. Logs go to `~/Library/Logs/mobile-deploy-hub/catchup.log`. | the iPad pass | 300 s |

- **Installing:** `mise run hosts:install` in the hub installs both. The Mac side goes over ssh to `hub-mac` and runs `launchctl bootstrap gui/502 …`.
- **Code updates:** the code runs from `~/.local/share/mobile-deploy-hub/current`, a symlink to `releases/<hub_ref>`. Each real run refreshes it:
  - on big-chungus, `deliver` copies its own action path's `tools/` there and flips the symlink;
  - on the Mac, the `ios` job does the same. This is a local copy, so it costs no network bytes.

### E2. The S26 pass (big-chungus)

1. Read each app's `latest.json` from `http://127.0.0.1:9012`. Act only on apps whose `android.device.status` is `pending`, and skip any version named in `inflight.json` (a deploy is running).
2. Take the `adb` host lock (the one deploys use). Look for the S26 by serial for 20 s, without a nudge storm. If it is absent: `HUB_CATCHUP_IDLE`, exit 0, no event.
3. Read the installed code, then:

   | Installed code vs. `latest.json` | What the pass does |
   |---|---|
   | higher | `HUB_CATCHUP_AHEAD`: record `skipped` with the reason, send no event, never touch the phone. |
   | equal, and the `base.apk` sha256 matches | `HUB_CATCHUP_CONFIRMED`: Jarad installed it from ntfy or Quickdrop. Record `installed`, `by: manual`. |
   | equal, other bytes | install those same bytes in place, as a rerun does (step 4). |
   | lower | fetch the APK over loopback, check its sha256 and signer against `latest.json`, then `adb install -r`. |

4. Read back versionName, versionCode and the `base.apk` sha256, then report: `HUB_CATCHUP_INSTALLED`, `by: catch-up`.
5. A failure leaves the device `pending` and adds one to `failures`. After `max_failures` (3) on the same version, it records `failed` and sends one `.failed` event (`HUB_CATCHUP_FAILED`), then stops trying that version. The next deploy, or `catchup.mjs retry <slug> android`, resets it.

### E3. The iPad pass (Mac)

1. Read `latest.json` from `https://s3.delo.sh` (a few KB). Act only on `ios.device.status == pending`.
2. Take the `mac-ios` lock. Run `devicectl list devices`. If the iPad is not listed: `HUB_CATCHUP_IDLE`.
3. Compare the installed version and build with `latest.json`. The version is compared as semver first, then the build: as a number when both are numbers, otherwise as semver (Gruvato's build is `0.2.5`).

   | Installed vs. `latest.json` | What the pass does |
   |---|---|
   | newer | `HUB_IPAD_NEWER`: record `skipped`, send no event. |
   | equal | `HUB_CATCHUP_CONFIRMED` (installed over the air). |
   | older | install from the outbox IPA (sha256 must equal `latest.json`'s): unzip `Payload/*.app`, `devicectl device install app`, read back. |

4. If the IPA is missing from the outbox: download it from S3 only when the link is not metered (the gateway is inside `lan_cidr`). Otherwise wait.
5. Report over ssh: `ssh <linux.host> node ~/.local/share/mobile-deploy-hub/current/tools/catchup/catchup.mjs record --slug <slug> --platform ios --version <v> --build <b> --by catch-up|manual`. Every argument is validated against a pattern. Nothing secret crosses.

### E4. The report (big-chungus, `catchup.mjs record`)

1. Take the `s3-<slug>` lock and read `latest.json` again.
2. Update `device` only if the block still names this version. If the pointer has moved forward, still send the event, but leave the newer block alone.
3. Write `latest.json`, then re-render the app page and the index.
4. Send one event with `bb-emit --strict` (G3): `data.trigger: catch-up`; one delivery; the original deploy's `run` (id, attempt, url) and its correlation.
5. If the bus is dead, the device update stays and the event is retried on the next pass: a marker `event_pending` in `device` makes this exactly once.

There is no second notification for a device the run itself installed: its status was never `pending`.

## F. Data budget (the Mac on a hotspot)

### F1. Metered detection

- The gate reads `tailscale status --json` on big-chungus. The Mac peer (`carries-macbook-air`) can be in one of three states:
  - **offline:** `Online: false`, or the runner process is missing. The gate checks the process over ssh with `ssh hub-mac pgrep -f Runner.Listener`, a few hundred bytes.
  - **home:** its `CurAddr` is inside `lan_cidr`.
  - **metered:** anything else, including a DERP relay.
- `hub-mac` is a new ssh alias on big-chungus: `ProxyCommand tailscale nc carries-macbook-air %p`. It works on and off the LAN; minimal tested it and got the Mac's ssh banner.
  - big-chungus has no MagicDNS, so the existing `mac` alias (a `.ts.net` name) and `mommymac.local` (LAN-only, stale 192.168.1.23) both fail off the LAN.
  - `devices.json` `mac.host` becomes `hub-mac`.
- Accepted blind spot: a remote network that also uses 192.168.1.0/24, reached on a direct tailnet path, reads as `home`. With the F2 delta transfers, that costs at most one Tower run's roughly 30 MB.

### F2. Bytes per run, and how they are kept small

| What | v1.0.0 | v1.1 |
|---|---|---|
| Actions downloaded by the Mac jobs (checkout, upload/download-artifact, hub) | about 7 MB | about 5 MB: `preflight-ios` has no checkout and no upload-artifact; its receipt goes back through a job output |
| Tower's Xcode handoff | 113.5 MB tgz every run | `rsync -z --delete` of the unpacked export into `~/Library/Caches/mobile-deploy-hub/handoff-cache/<owner>-<repo>/` on the Mac. Usually 15 to 20 MB, mostly the PCK. The engine libraries (`libgodot.a`, MoltenVK) do not change. The Mac checks the tree against `tree_sha256`, a sha256 over the sorted `sha256  path` list carried in the ios-export receipt. |
| First delta on a cold cache | — | **0 bytes over the hotspot**: `hosts:install` seeds the cache on the Mac from the newest handoff tgz already in `~/Library/Caches/mobile-deploy-hub/handoff/` (four of them are there from the 10-09 dry runs) |
| IPA back to big-chungus | none | sent once, only when the iPad is `pending` or the link is not metered. Tower is about 27 MB; Green In Between and Gruvato are measured on their first run and logged as `HUB_MAC_BYTES`. |
| Catch-up | — | a few KB per pass (`latest.json`); installs use the outbox |
| Quickdrop | APKs synced to the Mac | none (`.stignore /builds`) |

- If openrsync (macOS's rsync since 15) cannot do the delta transfer, two fallbacks apply:
  - `--rsync-path=/opt/homebrew/bin/rsync` when that binary exists;
  - otherwise a tarball made with sorted entries, `--mtime` pinned and `gzip --rsyncable`, sent with rsync against the previous tgz.
- Every Mac transfer logs `HUB_MAC_BYTES in=<n> out=<n>` from `rsync --stats`. The receipt keeps the numbers.
- **Budget:** on a metered link, the gate estimates the run's Mac bytes. The estimate is the previous run's measured `HUB_MAC_BYTES` (stored in `latest.json` under `mac_bytes`), or 150 MiB when there is no history.
  - If the estimate is over `metered_budget_mib` and the run's `metered` input is `auto`, the gate skips the iOS lane (`HUB_IOS_DEFERRED`) and the iPad delivery is `skipped`.
  - `metered: allow` (front door: `--metered allow`) overrides it.
  - At today's sizes no app goes over: Tower about 30 MB after seeding, the others about 5 to 12 MB.
- **Phone side:**
  - a tap downloads the APK over cellular: Tower 72 MB, Green In Between 96 MB, Gruvato 312 MB;
  - the Gruvato page and its notification show the size;
  - stripping Gruvato's unstripped `.so` is a Gruvato task, not part of the hub.

## G. Bloodbank: additive schema edits

Both `schemas/bloodbank/project/deployment.{completed,failed}.json` get the same edits. Nothing is renamed, removed or made required.

| Field | Shape | Notes |
|---|---|---|
| `data.links` | array of 1 to 6 items `{rel, label, url}`, `additionalProperties: false` | `rel`: `page`, `apk`, `ota`, `release`, `run`. `label`: 1 to 32 characters. `url`: at most 600 characters, pattern `^(https\|itms-services)://[^\s"<>]+$`. Any project event can carry links; the router treats them the same way for every type. |
| `data.trigger` | `deploy` \| `catch-up` | Optional; absent means `deploy`. |
| `$defs.delivery.status` | `installed` \| `pending` \| `skipped` \| `failed` | Optional; the hub always sets it. `reason` (already 1 to 300 characters) also explains `pending` and `skipped`. |
| `$defs.delivery.device` | string, 1 to 40 characters | The friendly name (`S26`, `iPad`) next to the model in `target`. |
| `$defs.delivery.by` | `deploy` \| `catch-up` \| `manual` | Optional. |
| stage enums | `data.stage` (failed) and `$defs.delivery.stage` gain `deliver` | A publish failure after the build. |
| descriptions | completed: "or published for a later install while a device was away (deliveries[].status pending)" | Text only. |

- The HUB builder makes these edits, in the bloodbank repo. It stages only those two files, leaves the other 22 dirty files alone, and runs:
  - `mise run validate:schemas`;
  - `smoketest:schema-contract-consistency`;
  - `smoketest:schemas`.
- `bb-emit --check` must pass on three events:
  - a `.completed` with one delivery installed and one pending, plus links;
  - a catch-up `.completed`;
  - a `.failed` at `deliver`.
- The event `plan` checks before the bump (`sampleEvent`) gains links and statuses, so a schema that lacks them stops a real run before any version is spent.

### G1. What `announce` puts in `data.links`

| Event | Links, in order |
|---|---|
| deploy `.completed` | `apk` "Install APK" (when published), `ota` "Install on iPad" (when an IPA is published and the iPad is not installed), `page` "Builds", `run` "Run" |
| deploy `.failed` | `run` "Open run", `page` "Builds" (when anything was published) |
| catch-up `.completed` | `page` "Builds" |
| catch-up `.failed` | `page` "Builds", `run` "Run" |

### G2. Summary

`data.summary`, at most 200 characters, still works on its own, for every other consumer:
> Tower of Lost Things 0.2.2 (4) 1a2b3c4: S26 pending, iPad installed, verified=false

### G3. Catch-up event

- Type `bloodbank.project.deployment.completed`, `data.trigger: catch-up`.
- `target` names the one device: `android-device` with the serial, or `ios-device` with the UDID.
- `deliveries` has one entry, `status: installed`, `by: catch-up` or `manual`.
- `run` is the original deploy run; the correlation is the original deploy's UUIDv5.
- `source` is `urn:33god:service:mobile-deploy-hub`, and the producer is `mobile-deploy-hub-catchup`.

## H. The notification (NOTIFY builder: `33GOD/bloodbank/services/ntfy-router/`)

### H1. Router behaviour

- **Links → actions:** an event whose `data.links` is a non-empty list gets ntfy `view` actions.
  - At most 3, which is ntfy's limit.
  - They are taken in the order the event lists them, ignoring `run` when 3 better links exist.
  - Each is `{action: "view", label, url, clear: true}`.
  - Only `https://` and `itms-services://` URLs pass; anything else is dropped and logged.
- **Click:** the `page` link, or else the `run` link, or else the first `https` link.
- **Transport:** such events are published as **JSON to the ntfy root** (`POST https://ntfy.delo.sh/` with `{topic, title, message, priority, tags, click, actions}`). This allows UTF-8 titles and structured actions without escaping headers. Events without links keep today's header publish, so they are unchanged.
- **Deployment titles** (`bloodbank.project.deployment.*`):

  | Event | Title |
  |---|---|
  | deploy completed | "Tower of Lost Things 0.2.2 deployed" |
  | catch-up completed | "Tower of Lost Things 0.2.2 installed on S26" |
  | deploy failed | "Tower of Lost Things 0.2.2 deploy failed at build" |
  | catch-up failed | "Tower of Lost Things 0.2.2 catch-up failed on iPad" |

- **Deployment body:** one line per delivery, then the size line, then the run link text. For example:
  ```
  S26: pending (not on big-chungus's adb)
  iPad: installed 0.2.2 (4), verified
  APK 72 MB
  ```
  A failed deploy's body is the stage, the reason and the run.
- **Priority and tags:**

  | Event | Priority | Tags |
  |---|---|---|
  | deploy completed | 5 | `package` |
  | deploy failed | 5 | `rotating_light` |
  | catch-up | 4 | `white_check_mark` |

- **Loud types:** `NTFY_ROUTER_LOUD_TYPES` (default `bloodbank.project.deployment.*`) skips the per-type cap and the shared bucket, so the three train deploys and their catch-ups never fall into the digest. They still respect ntfy's own 429 or 5xx pause (counted into the digest during a pause).
- **No `Attach`:** ntfy-android's `canOpenAttachment` returns false for `application/vnd.android.package-archive` (`util/Util.kt`, checked 2026-10-09). Since ntfy#684 the app has no REQUEST_INSTALL_PACKAGES, so an attachment would only download 72 to 312 MB and could not be opened. The `view` action hands the APK URL to Chrome, whose download opens in the package installer as an update.
- **Not changed:** the token, the slop topic, mute, digest and rate limits for everything else.

### H2. iOS: does ntfy open `itms-services://`?

- **From the source** (ntfy-ios, checked 2026-10-09): `ntfy/Utils/ActionExecutor.swift` handles `view` with `URL(string: action.url)` and `UIApplication.shared.open(url, options: [:])`, with no scheme filter. A tap on the notification goes through `AppDelegate.swift` the same way. On a self-hosted server, ntfy-ios's notification extension fetches the full message, actions included. So the `itms-services://` URL reaches iPadOS unchanged.
- **Unproven on the device:** whether iPadOS 27 shows the install prompt when a third-party app opens that scheme. Proof step P6 settles it.
- **Fallback:** if it does not, the notification's Click opens the https build page in Safari, where Install is an ordinary link Safari is known to honour. That costs one extra tap.
- On the S26 the "Install on iPad" button does nothing; it is listed second so "Install APK" stays first.

### H3. Router tests and container

1. Fix `FakeNtfy` first: 9 of the 14 tests error today with "`FakeNtfy.__call__()` takes 4 positional arguments but 5 were given", because `post()` gained `event_type`.
2. Then add tests for:
   - links → actions (at most 3, order, scheme filter);
   - Click choice;
   - the JSON publish shape;
   - UTF-8 titles;
   - deployment titles and bodies (deploy, catch-up, failed);
   - loud types bypassing both buckets but not a pause;
   - no `Attach`;
   - events without links byte-identical to today.
3. Commit only `services/ntfy-router/`, with `__pycache__/` ignored. The directory is untracked today but is the live service.
4. Rebuild and restart: `docker compose -f compose.yml up -d --build`, with `BLOODBANK_NTFY_ROUTER_NTFY_TOKEN` read by `op read 'op://DeLoSecrets/ntfy Access Token/credential'` into the environment of that one command.
5. Check `docker logs bloodbank-ntfy-router` for `routed:`.

## I. Ownership: four builders

Each builder commits only its own paths, using a pathspec, and pushes to `main` as each unit lands.

### HUB: hub code, policy, delivery, app manifests and refs, conformance check, filling the event's links

**In the hub repo:**
- `tools/ci/policy.json`;
- `lib/{policy,caller,latest,s3,quickdrop,ota,pages,metered}.mjs`;
- `hub.mjs`: the `gate` and `deliver` commands, pending states, the iPad downgrade guard, staging, outbox, the deleted v2 path, links and statuses in `announce`;
- `lib/{announce,manifest,config,handoff,adb,devicectl}.mjs`;
- `devices.json`: `mac.host` becomes `hub-mac`, and `linux.host` is added;
- the workflow: `gate` and `deliver` jobs, the `metered` input, `if:` conditions, `@v1.1.0` inner refs;
- `actions/hub/action.yml`;
- `tools/deploy.mjs`: no ledger, `--metered`, the train;
- `templates/deploy.yml`;
- `mise.toml`: `release`, `deploy`, `deploy:train`, `conformance` and `hosts:install`. `hosts:install` installs the units CATCHUP writes; it does not write them;
- tests;
- this doc and the v3 doc's status line.

**In the bloodbank repo:** the two schema files (G).

**On the hosts:**
- the MinIO port, bucket, user, policy and the DeLoSecrets item;
- the `hub-mac` ssh alias on big-chungus;
- the Mac's quickdrop `.stignore`;
- seeding the handoff cache.

**In the three apps:**
- `deploy.yml` from the template (`@v1`);
- the caller tests, which assert `@v1` and the template hash;
- the optional `project.icon` in each manifest;
- Tower: the `--rsyncable` and sorted-tar fallback in its export hook, and deleting `testflight.yml` after the first hub `--testflight`;
- Gruvato: `build`, `tauri-build` and `ios:simulator` stop bumping and tagging.

**Fills:** `data.links`, `data.trigger`, `deliveries[].status`, `device` and `by` on deploy events.

**Never touches:** `tools/catchup/`, the router, or the rules text in the apps' `AGENTS.md`.

### NOTIFY: the ntfy router

- **Owns:** `33GOD/bloodbank/services/ntfy-router/` (`main.py`, `test_main.py`, `compose.yml`, `README.md`, `Dockerfile`, a `.gitignore` for `__pycache__/`), the container `bloodbank-ntfy-router`, and the proof that the buttons work on the S26 and in ntfy-ios.
- **Reads, does not edit:** the schemas, which HUB owns.
- **Contract:**
  - G's `data.links`, `data.trigger` and `deliveries[].status`, `device`, `reason`;
  - any event type may carry links.

### CATCHUP: the catch-up installers

- **Owns** `tools/catchup/` in the hub. The HUB builder will not touch this directory. It holds:
  - `catchup.mjs`, with the subcommands `android`, `ios`, `record` and `retry`;
  - `report.mjs`, which builds the catch-up event and runs `bb-emit`;
  - `units/mobile-deploy-hub-catchup.{service,timer}` and `units/sh.delo.mobile-deploy-hub.catchup.plist`;
  - `catchup.test.mjs`, which `mise run check` already picks up through `node --test tools/**/*.test.mjs`. HUB makes that one glob change.
- **Imports read-only:** the hub libraries listed in E.
- **Contract:**
  - C3's `latest.json`: read it, and change only `device` fields, under the `s3-<slug>` lock;
  - G3's event;
  - the host locks `adb` and `mac-ios`;
  - every install is in place with readback.

### RULES: what agents read

Everything in A4:
- skillex `all-skills/mobile-devex/SKILL.md` and the `mobile-dev` set in the three apps;
- the deploy line in each app's `AGENTS.md`, and the pointer in each app's `docs/deploy.md`;
- Green In Between's stale `.agents/skills/mobile-deploy-hub/SKILL.md` deletion;
- `~/.agents/AGENTS.md`, `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`;
- the hub's `AGENTS.md` and the README "Policy" section;
- `_guard.sh`'s `uses:` and release-upload refusal, made in `~/.config/git/hooks/_guard.sh` with its own test.

Where builders meet:
- **RULES and HUB both edit app repos**, but different paths: HUB edits workflows, tests, manifests and `mise.toml`; RULES edits `AGENTS.md` and `docs/deploy.md`.
- **Order:** HUB lands the schemas first (NOTIFY and CATCHUP test against them). After that, HUB, NOTIFY and CATCHUP work in parallel, and `latest.json`, G and the frozen library exports are their only interfaces. RULES goes last, so its text describes what was built.

## J. New markers

All v1.0.0 markers are unchanged.

| Area | Markers |
|---|---|
| Gate and policy | `HUB_POLICY`, `HUB_GATE`, `HUB_GATE_REFUSED` |
| Device states and downgrade | `HUB_S26_PENDING`, `HUB_IPAD_PENDING`, `HUB_IPAD_NEWER`, `HUB_IOS_DEFERRED` |
| Mac link and transfers | `HUB_MAC_LINK`, `HUB_MAC_BYTES`, `HUB_HANDOFF_DELTA` |
| Staging and outbox | `HUB_STAGED`, `HUB_OUTBOX_SENT`, `HUB_OUTBOX_SKIPPED` |
| Publishing | `HUB_PUBLISHED`, `HUB_PUBLISH_DRY_RUN`, `HUB_POINTER`, `HUB_QUICKDROP`, `HUB_QUICKDROP_SKIPPED` |
| Catch-up | `HUB_CATCHUP_IDLE`, `HUB_CATCHUP_INSTALLED`, `HUB_CATCHUP_CONFIRMED`, `HUB_CATCHUP_AHEAD`, `HUB_CATCHUP_FAILED`, `HUB_CATCHUP_REPORTED` |
| Front door | `DEPLOY_TRAIN` |

## K. Tests

**Hub (`mise run check`):**
- **Policy and gate:**
  - strict parsing, and `"none"` impossible;
  - schema 1 refused, and the v2 functions gone;
  - a lane dropped from the manifest is refused;
  - each caller deviation refused: `strict: false`, other runners, another manifest, no `REAL`, `@main`, an old tag, `on: push`, narrowed permissions;
  - a real run at `HUB_REF=main` refused;
  - the template hash is in `callers.accept`;
  - hooks get throwaway `GITHUB_*` files and no `MC_HOST_*`.
- **Pending:**
  - an absent S26 still bumps, publishes and sends `.completed` with `pending` (rewrites the v3 test that expects a stop);
  - a present S26 that fails sends `.failed`;
  - a Mac that is offline or over budget leaves the iPad `skipped`;
  - `.failed` at `deliver` when the publish fails.
- **Downgrades:**
  - the planned code is checked against `latest.json`;
  - a newer iPad is refused before the bump.
- **Publish:**
  - keys, content types, cache headers and upload order;
  - the forward-only pointer;
  - newest IPA only, and the old IPA deleted;
  - the five-APK retention;
  - the `MC_HOST_builds` value never in argv or a file (spy on spawn);
  - Quickdrop: a regular file through rename, the size cap, one per app.
- **Front door:** the ledger is gone; red last run gives an offer, not a refusal; the train order and stop-on-red.
- **Forbidden commands:** the grep walks `tools/` (catch-up included).
- **Event:** `bb-emit --check` on a pending `.completed` with links.

**Catch-up (`tools/catchup/catchup.test.mjs`):**
- pending only, and the inflight version skipped;
- idle when the device is absent, with no event;
- the `AHEAD`, `CONFIRMED`, `INSTALLED` and equal-code reinstall branches;
- sha256 and signer checks before an install;
- one event per status change;
- none for devices the run installed;
- the third failure sends `.failed`, then silence;
- `record` leaves a newer pointer alone;
- locks shared with the deploy jobs.

**Bloodbank:** `validate:schemas`, `smoketest:schema-contract-consistency`, `smoketest:schemas`, and the three `bb-emit --check` events in G.

**Router:** H3.

## L. Proof

1. **Checks:**
   - hub `mise run check`;
   - the Bloodbank checks;
   - router tests (`python3 -m unittest -v test_main`);
   - `bb-emit --check` on the three G events.
2. **Hosts:**
   - from the Mac (off the LAN), an anonymous `curl -I https://s3.delo.sh/builds/index.html` (`hosts:install` renders an empty index) returns 200 with `text/html`;
   - `ssh hub-mac true` works from big-chungus;
   - `systemctl --user list-timers mobile-deploy-hub-catchup.timer` on big-chungus, and `launchctl print gui/502/sh.delo.mobile-deploy-hub.catchup` on the Mac;
   - `node catchup.mjs android` with no pending apps logs nothing to do.
3. **Notification:** a test event with links goes to a scratch topic. It must show three buttons on the S26 and in ntfy-ios. On Android, "Install APK" must download through Chrome and offer Update.
4. **Today, with the devices away** (S26 off adb, iPad unavailable, Mac metered):
   - Command: from the Mac (`mise run deploy` in Tower; any machine works), or `mise run release`'s Tower dry run at `v1.1.0`.
   - Expect: `HUB_POLICY`, `HUB_GATE ok … mac=metered s26=away s3=ok`, `HUB_S26_PENDING`, `HUB_IPAD_PENDING`, `HUB_MAC_LINK metered`, `HUB_MAC_BYTES`, `HUB_HANDOFF_DELTA` (with `--dry-handoff true`), `HUB_PUBLISH_DRY_RUN`, `HUB_EVENT_CHECKED … S26 pending, iPad pending`.
   - Afterwards: no tag, no Release, no S3 object (the probe is gone), no Quickdrop file, no event, `main` unchanged.
   - Same for Green In Between, then Gruvato.
5. **Release:** `mise run release` tags `v1.1.0`, moves `v1`, and the three callers pin `@v1`. The three release dry runs are green, and `run.hub_ref` reads `v1.1.0`.
6. **Real deploys** (Deploy phase), in Jarad's order: Tower 0.2.2, Green In Between 0.0.20, Gruvato 0.2.5, each green before the next starts (`mise run deploy:train --dry-run false`).
   - Expect: `HUB_RELEASED`, `HUB_PUBLISHED`, `HUB_QUICKDROP` (Gruvato: `_SKIPPED`), `HUB_EVENT_SENT`.
   - ntfy shows "<app> <version> deployed", with each device's status.
   - On the S26: tap Install APK, then Update. The update keeps the app's data.
   - In ntfy-ios: tap Install on iPad, and record whether the iPadOS install prompt appears (H2). If it does not, check the Safari fallback.
7. **Back home:**
   - within 2 to 5 minutes, one `HUB_CATCHUP_INSTALLED` or `_CONFIRMED` and one notification for each pending device;
   - the next pass logs `HUB_CATCHUP_IDLE` or nothing;
   - no notification for a device the run installed.
8. **Negative:**
   - schema 1, `strict: false` and a caller at `@main` each hit `HUB_GATE_REFUSED` before any bump;
   - a planned Android code below the published one is refused;
   - a newer iPad build gives `HUB_IPAD_NEWER`;
   - `rerun --failed` of a deploy that failed at `deliver` publishes once and sends no duplicate install notification;
   - an old IPA URL returns 404;
   - Tower and Green In Between dispatched together show `HUB_LOCK_WAIT`.

## M. Unproven, and what happens if each fails

| Unproven | If it fails |
|---|---|
| iPadOS 27 honours `itms-services://` opened by ntfy-ios | Click opens the build page in Safari |
| An over-the-air install of a `debugging` (development) export, with Developer Mode on and the iPad in the wildcard profile | The iPad stays `pending` until catch-up at home. Tower can also use `--testflight`. |
| openrsync's delta transfer | the F2 fallbacks |
| devicectl with the Mac and iPad both on the S26 hotspot | catch-up at home |
| devicectl install while the iPad is locked | carried over from v3 |

Residual risks:
- An app repo can stop calling the hub. A3 lists the layers that make this visible.
- `latest.json` can be edited by someone holding MinIO admin keys. The catch-up still checks sha256 and signer before every install.
- Gruvato's 312 MB APK is costly on cellular.

## Rejected

- From frictionless:
  - **Replacing `devices.json` with the policy:** churn for no rule gain.
  - **Removing workflow inputs in v1.1:** that breaks the v1 interface. The gate refuses non-default values now, and `v2` removes them.
  - **A semantic-only caller check:** the template hash is stricter and simpler.
- From robust and frictionless:
  - **Retiring the last-red check entirely:** the front door still offers the rerun.
- From minimal:
  - **Moving the proof ledger into the Mac jobs:** the release dry runs replace it.
  - **Publishing from `announce`:** a separate `deliver` gives a clean `deliver` stage and a clean rerun.
  - **Keeping ten APKs:** five is enough.
- From the brief:
  - **An `Attach` header:** ntfy-android cannot open APK attachments (H1).

## Build log: catch-up (CATCHUP, 2026-10-09)

**Landed** in `tools/catchup/`:
- `catchup.mjs`: `android` (the S26 pass, E2), `ios` (the iPad pass, E3), `record` (E4), `retry <slug> <platform>`, and `mode [watch|live]`.
- `report.mjs`: the G3 event, sent through the hub's `bbEmit` with `producer: mobile-deploy-hub-catchup`.
- `store.mjs`: anonymous reads of the pointers, and downloads kept only when their size and sha256 match `latest.json`. On the Mac every read carries `If-None-Match`, so a pass with nothing new costs headers only.
- `units/`: `mobile-deploy-hub-catchup.service` and `.timer` (big-chungus), `sh.delo.mobile-deploy-hub.catchup.plist` (the Mac), and `install.sh`, which installs the code and the unit on the host it runs on.
- `catchup.test.mjs`: 26 tests. They cover K's catch-up list:
  - pending only, and the inflight version skipped;
  - idle with no event when the S26 or the iPad is away;
  - AHEAD, CONFIRMED, INSTALLED and the equal-code reinstall;
  - the sha256 and signer checks before an install;
  - one event per status change, and none for a device the deploy installed;
  - the third failure's `.failed`, then silence, then `retry`;
  - `record` leaving a newer pointer alone;
  - the `adb` and `s3-<slug>` locks shared with the deploy jobs.

  They also cover:
  - watch mode;
  - a dead bus (the event is sent once on the next pass);
  - `policy.event.catch_up: false`;
  - the event naming the block's own run;
  - the iPad branches: the outbox, the metered wait, the download at home and foreign outbox bytes;
  - the `record` arguments over ssh;
  - the hub writer's credential handling;
  - `record` through the hub's `createS3` and `publishPages` (with a fake `mc`);
  - the units, and the CLI through the `current` symlink;
  - `bb-emit --check` on the three event shapes.

  They pass on node 24 and on the system node 20.

**The contract as built.**
- `latest.json` goes through `tools/ci/lib/latest.mjs`: `validateLatest`, `updateDevice`, `compareRelease` and the key helpers. A file that fails it is refused and logged (`HUB_CATCHUP_ERROR`), never acted on. The download URL is built from the block's `key`, never taken from `url`.
- The policy comes from `loadPolicy` (`tools/ci/policy.json` at the code that runs); `event.catch_up: false` turns the catch-up events off.
- Writes go through `s3.mjs` (`writerCredentials`, `createS3`). The keys come from the DeLoSecrets item by UUID, read with the runners' service account (`~/.config/op/service-account-token`), and reach only the `mc` child's `MC_HOST_builds`.
- After each change `record` calls the hub's `publishPages` with the same writer, as `deliver` does, so the app page and the index show the new device state.
- The event names the `run`, `correlation` and `commit` of the block it reports. A deploy that skipped a platform kept that platform's older block, so the block's run can be older than the top level's. `run.hub_ref` is set only when the block came from the newest run.
- Only `device` fields change. `event_pending: true` marks an event the bus refused. The next S26 pass sends it and clears the mark; this includes iPad events, because only big-chungus has the bus.
- A failed attempt leaves the device `pending`, adds one to `failures` and sets the reason to "catch-up attempt N of 3 failed at <stage>: ...". The third failure records `failed` and sends one `.failed` (`HUB_CATCHUP_FAILED`). `retry` sets `pending` with 0 failures.
- The iPad counts as away when devicectl lists it with `tunnelState: unavailable`. That is what it reports today.

**Modes.** A host without `~/.config/mobile-deploy-hub/catchup.json` is in watch mode. A pass then reads `latest.json`, finds the device and its installed version, and logs `HUB_CATCHUP_WATCH <slug> <platform> <release>: would ...`. It downloads, installs, writes and sends nothing. `install.sh` writes `watch` only when the file is missing and never writes `live`. `record` and `retry` are explicit commands, so they ignore the mode. The Deploy phase makes both hosts live:
```
node ~/.local/share/mobile-deploy-hub/current/tools/catchup/catchup.mjs mode live                                   # big-chungus
ssh hub-mac '~/.local/share/mise/installs/node/24/bin/node ~/.local/share/mobile-deploy-hub/current/tools/catchup/catchup.mjs mode live'
```

**Hosts.**
- **big-chungus:**
  - The code is at `~/.local/share/mobile-deploy-hub/current -> releases/main-42f3f4c` (`git archive 42f3f4c tools`), until a real run's `deliver` points it at `releases/v1.1.x`.
  - The timer is enabled and the mode is watch. Every 2 minutes the pass logs `HUB_CATCHUP_IDLE android watch: nothing pending (tower-of-dumb-things unpublished, green-in-between unpublished, gruvato unpublished)`.
  - A proof against the real adb server, with a fixture `latest.json` that has Tower 0.2.2 (4) pending, logged `HUB_LOCK adb`, searched 20 s by serial, then `HUB_CATCHUP_IDLE android watch: tower-of-dumb-things 0.2.2 (4) pending; the S26 is away`. It wrote nothing and sent no event.
- **The Mac:**
  - Installed at 17:50Z over `hub-mac`. `rsync` sent the `main-42f3f4c` tree in 162 KB and received 1 KB, over the hotspot (gateway 172.30.235.16, so metered).
  - `install.sh` bootstrapped the LaunchAgent into `gui/502` from ssh: `run interval = 300 seconds`, node 24, mode watch.
  - The first pass, on load, logged `HUB_CATCHUP_IDLE ios watch: nothing pending (tower-of-dumb-things unpublished, ...)`, with `last exit code = 0`.
  - A proof with a fixture `latest.json` (Tower iOS 0.2.2 (4) pending) and the real devicectl logged `HUB_LOCK mac-ios`, then `HUB_CATCHUP_IDLE ios watch: ... pending; the iPad is unavailable to devicectl`, with `metered=true`.
  - The real `record` call from the Mac to big-chungus over ssh, with no ssh agent, took `s3-tower-of-dumb-things` and refused cleanly: `latest.json is gone`, because nothing is published yet.

**For HUB.**
- `mise run hosts:install`:
  - on big-chungus, runs `tools/catchup/units/install.sh <ref>`;
  - on the Mac, runs `rsync -az tools/ hub-mac:.local/share/mobile-deploy-hub/releases/<ref>/tools/` (about 600 KB, sent once), then `ssh hub-mac bash .local/share/mobile-deploy-hub/releases/<ref>/tools/catchup/units/install.sh <ref>`.
- The code refresh in `deliver` and the `ios` job copies `tools/` to `releases/<hub_ref>` and points `current` at it. The mode file lives outside that folder, so it survives.

**Differences from the text above.**
- `ExecStart` runs mise's node 24 by absolute path, because a bare `node` in a systemd unit is the system node 20. The code also runs on node 20. The Mac reaches `record` through ssh, whose PATH has only the system node, so the remote command prefers node 24 when it exists.
- The timer is `OnCalendar=*:0/2`, so `Persistent=true` has an effect; it does nothing on a monotonic timer.
- `KillMode=process` keeps alive an adb server that the pass started, for the deploys and the next pass.
- `record` takes more than E3's `--slug --platform --version --build --by`: also `--status installed|skipped|failure`, `--reason`, `--stage`, `--sha256`, `--commit`, `--run-id` and `--run-attempt`. Each value must match a pattern and is single-quoted on the ssh line. The reason travels as plain words.
- A local journal (`~/.local/state/mobile-deploy-hub/catchup-journal.json`) remembers what this host installed. An install whose report was lost is then recorded as `catch-up`, not `manual`.
- An `inflight.json` older than 6 hours (by `started_at`, else its Last-Modified) no longer holds a build back.
- The iPad pass downloads an IPA only off a metered link, and only into its own cache, never into the deploy's outbox.
- Extra markers:
  - `HUB_CATCHUP_WATCH`;
  - `HUB_CATCHUP_PENDING` (an attempt failed; still pending);
  - `HUB_CATCHUP_FETCHED`;
  - `HUB_CATCHUP_PAGES` (the pages were re-rendered, or why not);
  - `HUB_CATCHUP_ERROR`.
