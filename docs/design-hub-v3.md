# Mobile Deploy Hub v3: one deploy contract, three apps

Status: hub built 2026-10-09 (`mise run check`: actionlint plus 82 tests, including `tools/ci/v3.test.mjs`); the Bloodbank schema edit landed (bloodbank 79f5e60). Proof steps 1 to 6 are done: tag `v1.0.0` (41ee100) carries the flipped inner refs, all three callers pin it, and one dry run per app at `v1.0.0` is green on both lanes (build log below). Next: Jarad's first real deploy per app. Replaces v2's job graph, manifest and front door.

Every deploy of Tower (`pile-of-dumb-things`), Green In Between (`green-in-between`) and Gruvato: (1) bumps the version, committed and tagged before the build; (2) installs on the S26 and the iPad, verified by reading the version back; (3) sends one Bloodbank event with the outcome.

## Decisions

### One front door

`mise run deploy`, same flags in all three repos:

| Flag | Default | Meaning |
|---|---|---|
| `--dry-run true\|false` | `true` | `false` deploys |
| `--bump patch\|minor\|major` | `patch` | no "none": a deploy that failed after its bump is finished with `gh run rerun <id> --failed`; leave the flag blank so a red last real run is offered that rerun |
| `--platform both\|android\|ios` | `both` | narrows the devices too |
| `--testflight true\|false` | `false` | also TestFlight Owner Testing (apps with `ios.store`: Tower) |
| `--play true\|false` | `false` | also Play (apps with `android.bundle`: none yet) |
| `--dry-handoff true\|false` | `false` | dry run ships the Xcode export to the Mac (Tower only) |

The script is `tools/deploy.mjs`, moved from Tower into the hub: dispatch on `main`, watch only the run it started, then `git pull --ff-only` the bump commit after a green real run. Each app's task is identical: fetch `tools/deploy.mjs` with `gh api` at the ref in the caller's `uses:` line and run it. One copy, one pin.

### The bump runs in the hub

`plan` runs the app's `version.bump <level>` hook, then checks the new version is the exact semver increment, `git status` changed exactly the files the hook listed, and tag `vX.Y.Z` is new. On a real run it commits them (`chore(release): vX.Y.Z`), tags, and runs `git push --atomic origin HEAD:main vX.Y.Z` with `GITHUB_TOKEN` passed through `GIT_CONFIG_*` env vars (never argv or `.git/config`; the hook never sees it). If `main` moved, the push fails before any build. Later jobs check out that commit.

In the hub, because an Actions-tab dispatch must bump too. A `GITHUB_TOKEN` push triggers no workflow; v3 is dispatch-only. The bump follows device preflight, so an unreachable device never costs a version; a build failure after it skips that version.

### S26: `adb install -r` from big-chungus

The `android` job runs as delorenj, using `~/Android/Sdk/platform-tools/adb` and the adb server that holds the wireless pairing. It picks the device whose `ro.serialno` is `R5GL43A7PCH` (the mDNS suffix changes), checks the APK signer against the app's pin (the key on the phone), and refuses a versionCode at or below the installed one. Then `adb -s <serial> install -r` and readback: `dumpsys package` shows the planned versionName and versionCode, and the on-device `sha256sum` of `base.apk` equals the built APK (Gruvato's proven check). Only then does it publish the private Release `vX.Y.Z` (the record, and the file for family phones).

The hub never runs `uninstall`, `pm clear` or `install -d` (a test greps for them). A signer mismatch makes Android refuse the update with data intact.

### iPad: development build, devicectl from the Mac

Not TestFlight:
- devicectl installs now, and `devicectl device info apps --bundle-id` reads back the short version and build in the same job. TestFlight waits for processing, installs on its own schedule, and has no readback.
- Green In Between and Gruvato have no App Store Connect app or App Store profile.
- Every app on the iPad is already a developer build, and the signing exists: Apple Development `FA11A63D` and the Xcode-managed wildcard profile `ff75c3d0` (includes the iPad, expires 2027-10-05).

Recipe, proven by Tower build 4: archive with `CODE_SIGNING_ALLOWED=NO DEVELOPMENT_TEAM=YJ7W7Z36FP`, then `xcodebuild -exportArchive` with method `debugging`, signingStyle `automatic`. Manual signing rejects the managed profile (gib's exit 65). The app's `ios.device` hook leaves an `.xcarchive` (the hub exports it) or an `.ipa` in `$HUB_OUT/ios`. The hub checks the IPA (signer, `get-task-allow`, `application-identifier`, profile lists the iPad), runs `devicectl device install app` (in place, never uninstalls), and reads back. `--testflight` exports the same archive as `app-store-connect` and runs Tower's `upload` and `assign`.

### Event: `bloodbank.project.deployment.completed` / `.failed`

Not `lifecycle.app.deployed`: `lifecycle` is dev-mission status, `app` and `deployed` are off the allowlists (`bb contract` rejects it), and `project.deployment` already means "one install of a project's built artifact on a target". Gruvato emits it today; ntfy-router pushes `data.summary` to Jarad's phone.

One event per deploy, from a final `announce` job on big-chungus (`if: always()`), built from the receipts and sent with `$HOME/.local/bin/bb-emit --strict` (NATS 127.0.0.1:4222). A failed send turns the run red. `--correlation` is a UUIDv5 of repo and run id, so reruns correlate.

Additive edit to `bloodbank/schemas/bloodbank/project/deployment.{completed,failed}.json` (no new type):
- `artifact.kind` += `mobile-app` (`sha256` null);
- `target.kind` += `ios-device`, `device-set` (both devices: `device-set` "SM-S948U + iPad14,5");
- optional `data.deliveries[]`: `{platform, target, version, build, sha256, verified, stage?, reason?}`;
- optional `data.run`: `{id, url, hub_ref}`;
- `.failed` `stage` += `version`, `build`.

`verified` means every readback matched. Gruvato's local emitter retires.

### Dry run

No commit, tag, push, install, Release, TestFlight or Play. Each job applies the bump to its own checkout (the hub checks they agree), so the build carries the next version. Both devices are checked and their installed versions read; signer and IPA checks run; `bb-emit --check` validates the would-be event. **The event is not emitted**: the schema has no `dry_run` field, and ntfy or any listener would fire for a deploy that did not happen. Dry runs stay strict.

## Job graph

| Job | Runner | Does |
|---|---|---|
| `preflight-ios` | Mac | iPad available by UDID; dev identity and profile valid 30+ days; 15 GiB free; `op://` refs with `--testflight` |
| `plan` | Linux | after `preflight-ios`: manifest, S26 present and installed code read, bump; real: commit, tag, push |
| `android` | Linux | prepare, export, signer, install, readback, Release (real); Play with `--play` |
| `ios-export` | Linux | Tower only: Xcode project handoff |
| `ios` | Mac | `ios.device` hook, IPA checks, install, readback; TestFlight with `--testflight` |
| `announce` | Linux | event (real) or `--check` (dry) |

Runner defaults become `["self-hosted","Linux"]` and `["self-hosted","macOS"]` (one runner per OS per app). Every job writes its receipt even on failure (stage, one-line reason); `announce` reads them. "Re-run failed jobs" is the only recovery and is idempotent: it never re-bumps (the plan succeeded), an S26 that already reports the planned name and code is verified by the `base.apk` sha256 (other bytes of the same code reinstall in place with `install -r`), an existing Release `vX.Y.Z` gets the attempt's assets (`gh release upload --clobber`), and the iPad takes the same version again in place.

A dry run rehearses the bump's git half too: the plan commits (the machine's pre-commit guard runs), tags, runs `git push --dry-run --atomic` with the job's token (the pre-push guard runs and GitHub checks write access) and rewinds. So the first real deploy is not the first time the bot commit meets the guards.

## Manifest schema 2 (`tools/ci/mobile-deploy.json`)

```json
{
  "schema": 2,
  "project": { "slug": "tower-of-dumb-things", "name": "Tower of Lost Things" },
  "version": { "read": "node tools/hub-version.mjs", "bump": "node tools/hub-version.mjs bump" },
  "android": { "package": "…", "prepare": "…", "export": "…", "artifact": "….apk", "receipt": "…", "signer_sha256": "…" },
  "ios": { "bundle": "…", "export": "…", "archive": "…", "receipt": "…", "device": "…", "device_artifact": "…",
           "store": { "upload": "…", "assign": "…", "signer_sha1": "…", "secrets": ["op://…"] } }
}
```

`version.read` prints `{version, android_code, ios_build}`; `version.bump <level>` rewrites the authority files (no git) and adds `files`. `ios.export` (Linux) is optional; `ios.device` runs on the Mac and leaves `device_artifact`. Devices live once, in the hub's `tools/ci/devices.json`: S26 (SM-S948U, R5GL43A7PCH), iPad (iPad14,5, 00008112-000138390CFB401E), team YJ7W7Z36FP, dev signer FA11A63DB5E856366C0F8723577CFE8FC4479478.

| App | Version authority | Bump writes | android_code | iOS build |
|---|---|---|---|---|
| Tower | `game/export_presets.cfg` | version/name, short_version, version/code+1 | 3 → 4 | next after App Store Connect |
| Green In Between | `native/godot/export_presets.cfg` | 3 presets: name, short_version, codes+1, iOS version = code | 19 → 20 | = code |
| Gruvato | `.mise/version-files.conf` + Cargo.lock entry | `versioning.sh bump`, `cargo update --workspace --offline` | M·10⁶+m·10³+p | version string |

## Steps per repo

**mobile-deploy-hub**
- `tools/ci/hub.mjs` (`preflight-ios`, bump, failure receipts); new `lib/adb.mjs`, `lib/devicectl.mjs`, `lib/ipa.mjs`, `lib/announce.mjs` (ported from Gruvato's emitter); `lib/manifest.mjs` schema 2 only; new `tools/ci/devices.json`, `tools/deploy.mjs`.
- `.github/workflows/mobile-deploy.yml`: the graph; inputs `bump`, `testflight`, `play`.
- `tools/ci/hub.test.mjs`: increment rules, files equal the diff, existing tag refused, dry runs never commit, push, install or emit (spies), serialno match, forbidden-command grep, payload passes `bb-emit --check`.
- README; v2's Mac token item is resolved (strict dry run 37911019368).

**33GOD/bloodbank**: the schema edit; `mise run validate:schemas`, `smoketest:schema-contract-consistency`, `smoketest:schemas`.

**pile-of-dumb-things**
- `tools/hub-version.mjs bump <level>`.
- Manifest schema 2: `ios.device` = new `node tools/testflight.mjs device <tgz>` (unsigned Mac-local archive, the Mac form of `tools/ios.mjs`'s private route); `upload` and `assign` move under `ios.store`.
- `deploy.yml`: add `bump`, `testflight`, `play`; drop `android_channel`, `track`. `mise.toml`: shared `deploy` body.
- `tests/hub-manifest.test.mjs:99-104`: still no mise-versioning or bump task; assert `bump` rewrites name, short_version and code together, nothing else; drop "bumped by hand".
- Rewrite `docs/deploy.md` (no Mac-unlock step). Delete `testflight.yml` after the first real `--testflight` run.

**green-in-between**
- Presets to semver 0.0.19, code and build 19. Replace the `preview-19` literals (`ios-build.py:27-28` plus 8, `ui/practice.gd:1862`, `practice_test.gd:500`, `shot_replay_test.gd:336`, `test_ios_build.py:374`) with reads of the preset. Delete the BASELINE/ALLOWED_CHANGES gate, the mise-versioning block and `.mise/version-files.conf`.
- New `native/tools/ci/hub-version.mjs`, `hub-android-prepare.sh` (both `.so` builds, `bake.sh`); `ios-build.py --hub-out` (Mac only: Rust iOS lib, gib's own pinned Godot, unsigned archive).
- Android export with the spike keystore, password from a new `op://DeLoSecrets` item; gib1 runner moves to `runsvc-op.sh`. Signer pin `d9d0253a…222a`.
- Manifest, `deploy.yml`, `mise run deploy`.
- Delete `deploy-android.yml`, `deploy-ios.yml`, `deploy-hub.yml`, `tools/ci/deploy-hub.mjs`, secret `DEPLOY_HUB_PAT`; cancel run 37784570383. Keep `play-auth-check.yml`.

**gruvato**
- Repo-scoped runners: `big-chungus-gruvato` (systemd as delorenj via `runsvc-op.sh`; `.env` sets `MISE_TRUSTED_CONFIG_PATHS`, `ANDROID_HOME`, `JAVA_HOME`) and `mommymac-gruvato` (LaunchAgent via the shared `runsvc-op.sh`, no SessionCreate, Homebrew and mise shims on `.path`).
- `scripts/release/bump-version.sh <level>` (versioning.sh plus cargo, no git), `scripts/release/hub-version.mjs`.
- `scripts/android/build.sh` stops bumping; `android:deploy` becomes `android:install` (no event); retire `emit-deploy-event.py`, `announce-deploy.sh`, `tests/deploy-announce.test.mjs`.
- iOS: commit `src-tauri/gen/apple` (like `gen/android`), `bundle.iOS.developmentTeam` YJ7W7Z36FP, pnpm through mise in the Xcode pre-build script, fix the Xcode 27 UIKit failure, `scripts/ios/build-device.sh` (`tauri ios build`, debugging export).
- Manifest (Android `sh.delo.drumjangler`, signer `d09a011f…3a3c`; iOS `sh.delo.gruvato`, no `store`), `deploy.yml`, `mise run deploy`.
- `linux-tauri.yml`, `website.yml`: `runs-on: [self-hosted, Linux]` ($0 rule).

## Proof (dry runs only)

1. Hub `mise run check`; Bloodbank schema checks; `bb-emit --check` on a two-delivery `.completed` and an iOS `.failed` at `install`.
2. Tower `mise run deploy`, then `--dry-handoff true` at most daily (the Mac needs it to build the dev IPA). Expect `HUB_PLAN version=0.2.1 next=0.2.2 dry_run=true`, S26 at code 3, iPad at 0.2.1 (4), `APK_SIGNER_OK 2d49…1a97`, dev IPA verified, `HUB_EVENT_CHECKED`.
3. After each: no new tag, same `main`, no Release, old versions on both devices, ntfy silent, App Store Connect unchanged.
4. Negative: Wireless debugging off fails `plan` before any bump; `--bump minor` plans 0.3.0; `--testflight true` refused for gib and Gruvato.
5. Gruvato Android (0.2.4, code 2004), iOS after the Xcode 27 fix; gib Android (0.0.20, code 20 > 17, signer `d9d0…`), then iOS.
6. Tag the hub `v1.0.0`, flip inner refs and the three callers; one more dry run per app shows `hub_ref: v1.0.0`. Done 2026-10-09: Tower 37931518291, Green In Between 37931519842, Gruvato 37931523316.

The first real deploy (`--dry-run false`) is Jarad's, per app, after step 6.

## Needs Jarad

- Unproven until a real run: devicectl install while the iPad is locked.
- The first real deploy per app (`mise run deploy --dry-run false`). The tag is in place: all three callers pin `v1.0.0` and each has its iPad proof recorded at `v1.0.0`. Gruvato's is its first install on the iPad.

## Build log (2026-10-09)

**Landed.** Hub v3 (770199a, then 936c561, 986751f, 10c600f); Bloodbank schema edit (79f5e60: `mobile-app`, `device-set`, `deliveries[]`, `run`, failed stage `version`; `validate:schemas` and `smoketest:schemas` green); Tower caller (2238305, 642680e); Gruvato caller (f7a1f18) and iPad lane (c941f4e: `scripts/ios/build-device.sh`, `tauri ios build --archive-only --no-sign`, the Xcode 27 link fix); Green In Between caller (374088d) and iPad lane (e3d14c8 `ios-build.py --hub-out`, 87e7e94 manifest; the Preview 19 BASELINE gate is gone). Hub `v1.0.0`: 41ee100 flips the workflow's eight `actions/hub@` refs, and the annotated tag `v1.0.0` sits on that commit, so a caller at `@v1.0.0` gets `actions/hub@v1.0.0` (the tag was created there, never moved). Callers pinned to `@v1.0.0`: Tower f3aadec, Green In Between 2e9b366, Gruvato 137fb17.

**Proof, Tower (strict dry runs, `@main`).**
- 37924832437, both devices, `--dry-handoff true`: every marker in one run. `HUB_PLAN version=0.2.1 next=0.2.2`, `HUB_PUSH_REHEARSED v0.2.2` (commit, tag and `git push --dry-run --atomic` through the guards), `APK_SIGNER_OK 2d4954...1a97`, `HUB_S26_DRY_RUN would install 0.2.2 (4) over 0.2.1 (3)`, `HUB_HANDOFF_RECEIVED`, `IPAD_ARCHIVED 0.2.2 (4)`, `HUB_IPA_OK ... signer=FA11A63D profile=iOS Team Provisioning Profile: *`, `HUB_IPAD_DRY_RUN would install 0.2.2 (4) over 0.2.1 (4)`, `HUB_EVENT_CHECKED ... installed on SM-S948U + iPad14,5`. Attempt 1's ios-export crashed in Godot's headless import (signal 11 after a threaded font reimport); "Re-run failed jobs" finished it green, which also exercised the recovery path. Tower now retries that import once (642680e).
- 37923646167 (iOS only) and 37923899195 (Android only): the same markers per lane. 37924102293 (both) lost the S26 between the plan and android jobs (a fresh adb server waited 90 s): fixed in 986751f (the adb server is started outside the job's tracking id, findPhone waits 180 s and nudges `adb connect` from `adb mdns services`).
- After each: no `v0.2.2` tag, no Release, `main` unchanged, the S26 still on 0.2.1 (3), the iPad on 0.2.1 (4), no event sent.

**Proof, Gruvato and Green In Between (strict dry runs, Android lane; their manifests declare no iPad lane yet, so preflight-ios logs `HUB_PREFLIGHT_IOS skipped`).**
- Gruvato 37925894185: `HUB_PLAN version=0.2.4 next=0.2.5 android_code=2005`, `HUB_PUSH_REHEARSED v0.2.5`, `APK_SIGNER_OK d09a011f...3a3c`, `HUB_S26_DRY_RUN would install 0.2.5 (2005) over 0.2.3 (2003)`, `HUB_EVENT_CHECKED`.
- Green In Between 37925894400: `HUB_PLAN version=0.0.19 next=0.0.20 android_code=20`, `HUB_PUSH_REHEARSED v0.0.20`, `APK_SIGNER_OK d9d0253a...222a`, `HUB_S26_DRY_RUN would install 0.0.20 (20) over preview-17 (17)`, `HUB_EVENT_CHECKED`.
- No `v0.2.5` or `v0.0.20` tag, `main` unchanged in both.

**Proof, the iPad lanes for Gruvato and Green In Between (strict dry runs, both devices, `@main`).**
- Green In Between 37929895970: `HUB_PREFLIGHT_IOS ok iPad=0.0.19(19)`, `GIB_BAKE_FETCHED f13a80a5d25abd38 from big-chungus`, `IPAD_ARCHIVED 0.0.20 (20)`, `HUB_IPA_OK ... 0.0.20 (20) signer=FA11A63D profile=iOS Team Provisioning Profile: *`, `HUB_IPAD_DRY_RUN would install 0.0.20 (20) over 0.0.19 (19)`, plus the Android markers above.
- Gruvato 37929418646: `HUB_PREFLIGHT_IOS ok iPad=absent`, `HUB_LOCK_WAIT mac-ios` (gib's run held it), `IPAD_ARCHIVED 0.2.5 (0.2.5)`, `HUB_IPA_OK sh.delo.gruvato 0.2.5 (0.2.5) signer=FA11A63D`, `HUB_IPAD_DRY_RUN would install 0.2.5 (0.2.5) over nothing`, plus the Android markers above.

**Proof, step 6 (strict dry runs at `v1.0.0`, `mise run deploy --dry-handoff true`, all three dispatched together).** Every receipt reads `hub_ref: v1.0.0`, and each app's iPad proof is recorded under `v1.0.0` in `~/.local/state/mobile-deploy-hub/ipad-proofs.json`. The `mac-ios` host lock serialized the three iPad builds (`HUB_LOCK_WAIT` in Tower's and Gruvato's).
- Tower 37931518291 (f3aadec): `HUB_PREFLIGHT_IOS ok iPad=0.2.1(4)`, `HUB_S26 SM-S948U serial=R5GL43A7PCH`, `HUB_PUSH_REHEARSED v0.2.2`, `HUB_PLAN version=0.2.1 next=0.2.2 android_code=4`, `HUB_BUMP_APPLIED`, `IPAD_EXPORTED`, `HUB_HANDOFF_SENT`, `HUB_IOS_EXPORTED`, `APK_SIGNER_OK 2d4954...1a97`, `HUB_ANDROID_BUILT 0.2.2 (4)`, `HUB_S26_DRY_RUN would install 0.2.2 (4) over 0.2.1 (3)`, `HUB_HANDOFF_RECEIVED`, `IPAD_ARCHIVED 0.2.2 (4)`, `HUB_IPA_OK ... signer=FA11A63D`, `HUB_IPAD_DRY_RUN would install 0.2.2 (4) over 0.2.1 (4)`, `HUB_EVENT_CHECKED`.
- Green In Between 37931519842 (2e9b366): `HUB_PREFLIGHT_IOS ok iPad=0.0.19(19)`, `HUB_S26`, `HUB_PUSH_REHEARSED v0.0.20`, `HUB_PLAN version=0.0.19 next=0.0.20 android_code=20`, `HUB_BUMP_APPLIED`, `APK_SIGNER_OK d9d0253a...222a`, `HUB_ANDROID_BUILT 0.0.20 (20)`, `HUB_S26_DRY_RUN would install 0.0.20 (20) over preview-17 (17)`, `IPAD_ARCHIVED 0.0.20 (20)`, `HUB_IPA_OK ... signer=FA11A63D`, `HUB_IPAD_DRY_RUN would install 0.0.20 (20) over 0.0.19 (19)`, `HUB_EVENT_CHECKED`.
- Gruvato 37931523316 (137fb17): `HUB_PREFLIGHT_IOS ok iPad=absent`, `HUB_S26`, `HUB_PUSH_REHEARSED v0.2.5`, `HUB_PLAN version=0.2.4 next=0.2.5 android_code=2005`, `HUB_BUMP_APPLIED`, `APK_SIGNER_OK d09a011f...3a3c`, `HUB_ANDROID_BUILT 0.2.5 (2005)`, `HUB_S26_DRY_RUN would install 0.2.5 (2005) over 0.2.3 (2003)`, `IPAD_ARCHIVED 0.2.5 (0.2.5)`, `HUB_IPA_OK sh.delo.gruvato ... signer=FA11A63D`, `HUB_IPAD_DRY_RUN would install 0.2.5 (0.2.5) over nothing`, `HUB_EVENT_CHECKED`.
- After all three: no `v0.2.2`, `v0.0.20` or `v0.2.5` tag, no Release, each `main` unchanged; the S26 reads back Tower 0.2.1 (3), gib preview-17 (17), Gruvato 0.2.3 (2003); no event sent.

**Runners.** gib's `delonet-gib-r1` now starts through `runsvc-op.sh` (systemd drop-in `op.conf`, token checked present). Gruvato has `big-chungus-gruvato` (systemd, `runsvc-op.sh`, `.env` with `MISE_TRUSTED_CONFIG_PATHS`, `ANDROID_HOME`, `JAVA_HOME`) and `mommymac-gruvato` (LaunchAgent through the keychain `runsvc-op.sh`, SessionCreate removed, token present). Registration tokens went through the environment and ssh stdin, never argv.

**Keystores.** Backed up to DeLoSecrets as documents, each verified byte-identical on download and by keytool against its pin: Tower `mkvok3flnoqtvwdwe4yeyw65yq` (2d4954...1a97), Green In Between spike `zmyhzpejj5hgy4krilvwdqbsha` (d9d0253a...222a), Gruvato `66votsjmeurzmgu3brlk5552zi` (d09a011f...3a3c). gib's prepare hook fetches its keystore from there when the host has none.

**Mac token file.** `~/.config/op/service-account-token` on the Mac was byte-identical to big-chungus's copy and to the DeLoSecrets item "Service Account Auth Token: DeLoSecrets": the token every agent and every big-chungus runner uses. It is deleted from the Mac (nothing read it; the runners read the keychain item). It was not revoked: revoking it would cut off every agent and runner on big-chungus.

**Not done yet.**
- The first real deploy per app (Jarad's; see "Needs Jarad").
- Known limits the app docs record: gib's `ios-build.py` manual mode still manual-signs (exit 65 against the managed profile; the hub path is unaffected); a gib `--platform ios` run after a bake-input change waits on big-chungus's bake (the Mac waits up to 15 min); Gruvato keeps its Xcode 27 workaround until swift-rs fixes #79/#81; Gruvato's Xcode pre-build script does not yet run pnpm through mise (GUI builds only; the hub uses `mise exec`); a Gruvato iOS run leaves about 3.6 GB in the Mac runner's `_work` until the next checkout (24 GiB free on the Mac).
- Declined: retiring Gruvato's `emit-deploy-event.py` and `announce-deploy.sh` (they still announce the site, split-service and simulator deploys); a DeLoSecrets item for the spike keystore password (it is Android's public debug value, `android`).
