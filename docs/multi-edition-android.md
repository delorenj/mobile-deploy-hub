# Multiple signed Android editions (MOBI-14)

One app can build and verify more than one signed Android edition in a single deploy, while exactly one edition, the **device edition**, is ever installed on the S26, dropped in Quickdrop or offered by the catch-up. A second edition (Earshot's `io.automaticai.earshot` beta, for example) can be published publicly as an anonymous APK plus checksum that Obtainium can discover, with no way to reach a phone.

Single-edition apps are untouched: no `android.editions` key means no new code path, no new file and no new message.

## Vocabulary

| Edition | What it is |
|---|---|
| device edition | the manifest's top-level `android` block (package, hook, artifact, receipt, signer). It keeps every pre-MOBI-14 path: S26 install, Quickdrop, `latest.json`, the app page, the catch-up, the private Release. |
| extra edition | one entry of `android.editions`, named by the app (`beta`, `rc`). Built, signature-verified and staged on every run. Never installed, never in Quickdrop, never in `latest.json`, never seen by the catch-up. |
| public edition | an extra edition that **both** the manifest (`public`) and the policy (`public: true`) opt in to. Published to its own anonymous folder. Any other edition stays private. |

## Manifest shape

```json
"android": {
  "package": "sh.delo.earshot",
  "export": "scripts/android/build.sh",
  "artifact": "build/hub/earshot.apk",
  "signer_sha256": "edcb667d...6eac",
  "editions": {
    "beta": {
      "package": "io.automaticai.earshot",
      "export": "scripts/android/build.sh --edition beta",
      "artifact": "build/hub/earshot-beta.apk",
      "receipt": "build/hub/earshot-beta.json",
      "signer_sha256": "edcb667d...6eac",
      "public": { "title": "Earshot beta" }
    }
  }
}
```

An edition takes the device edition's keys: `package`, `signer_sha256` (both required), a lane (`export`, or `godot`, with optional `prepare`), `artifact` and `receipt`. It cannot take `bundle` or `bundle_artifact` (the Play AAB is the device edition's) or a `device` flag. `public` is an object, `{title?}` (at most 80 characters, one line), and its presence is the app's half of the opt-in.

Hooks run like the device hooks, with two more variables: `HUB_EDITION` (the name) and `HUB_EDITION_PACKAGE` (the package the manifest pins). A hook that serves several editions should read them rather than hard-code a name.

### Refused before a version is spent

`parseManifest` runs in the gate and again in the plan before its bump, so each of these stops a run with nothing committed, tagged or published:

- `android.editions` that is not an object, is empty, or has more than 8 editions
- a name that is not lower-case words joined by `-` (at most 32 characters), or the reserved name `device`
- an unknown key, a `device` key, no signer pin, no lane, an artifact that is not an `.apk` or leaves the checkout
- a package equal to the device edition's or another edition's
- an `artifact`, `receipt` or `bundle_artifact` path two declarations would both write (the second would overwrite the first)
- an edition name declared twice in the JSON text (JSON would silently keep the last)

## Policy shape

The hub's `tools/ci/policy.json` pins each edition next to its device pins, so an app can never add a signer or package on its own:

```json
"delorenj/earshot": {
  "android": {
    "package": "sh.delo.earshot",
    "signer_sha256": "edcb667d...6eac",
    "editions": { "beta": { "package": "io.automaticai.earshot", "signer_sha256": "edcb667d...6eac" } }
  }
}
```

`public: true` on an edition pin allows public publication; it is absent for Earshot today. Changing it, like any policy change, is a hub release (`mise run release`) and needs explicit authorization. The gate and the plan refuse a manifest edition the policy does not pin, a package or signer that differs from the pin, and a `public` block when the pin does not allow it. A pin with no manifest edition is inert.

## What a run does

```
plan     manifest + pins checked, version bumped once (all editions share the one version and code)
android  device APK built, verified, staged            (as before)
         each edition: prepare/export hook -> APK copied to out/android/editions/<name>/
                       signer == pin, package == pin, version and code == the plan's
                       staged to <staging>/android/editions/<name>/<slug>-<name>-<v>-<code>.apk
                       receipt hub-receipt-android-edition-<name>.json
         S26 install + Quickdrop: device APK only        (never an edition)
release  GitHub Release: device APK and receipt as before, plus each edition's APK and receipt when GitHub says the
         repository is private (on a public repository only public editions ride along: HUB_RELEASE_EDITION_HELD)
deliver  device edition as before (pointer, pages, inflight.json, catch-up refresh), then each public edition (below);
         private editions write nothing, and the device's public receipt-android.json names no edition
```

A wrong signer or package, a missing artifact or a version mismatch in any edition fails the build stage (`edition <name>: ...`), before anything is installed or published.

Names that keep editions apart: `<slug>-<v>-<code>.apk` (device) versus `<slug>-<edition>-<v>-<code>.apk`; separate `editions/<name>/` folders in out and staging; receipt lanes `android` versus `android-edition-<name>`; release assets are checked for clashing names. Quickdrop's name pattern cannot match an edition name, `historyOf` and `pruneVersions` ignore the `editions` folder, and `latest.json` carries only the device block, so the catch-up cannot be pointed at an edition (it refuses a package that is not the policy's device pin).

## Public layout

```
builds/<slug>/editions/<edition>/<X.Y.Z>/<slug>-<edition>-<X.Y.Z>-<code>.apk
builds/<slug>/editions/<edition>/<X.Y.Z>/<slug>-<edition>-<X.Y.Z>-<code>.apk.sha256   sha256sum -c format
builds/<slug>/editions/<edition>/<X.Y.Z>/receipt.json
builds/<slug>/editions/<edition>/latest.json     the current version (no-cache), schema in tools/ci/lib/editions.mjs
builds/<slug>/editions/<edition>/index.html      one APK link, the checksum, the signer (no-cache)
```

This is the hub's `builds` bucket (https://s3.delo.sh/builds, MinIO, no 25 MiB page limit). Only `editions/<name>/*` of a public edition is anonymous; since MOBI-17 the device edition beside it (its APK, checksum, receipts, release notes and page) is private (its pointers name it and never grant it), so a buyer or Obtainium can never reach the paid-for build ([private-device-builds.md](private-device-builds.md)). Writes go under the same `s3-<slug>` lock as the device publish: APK and checksum first, then the receipt, then `latest.json`, then the page, so a reader never sees a pointer to missing bytes. The pointer moves forward only (greater version, then code; a rerun of the same release is allowed); an older build keeps the newer one and logs `HUB_EDITION_POINTER`. Retention keeps the newest `keep_apk` version folders and the pointer's, per edition, and touches nothing else. A dry run renders and checks everything and writes nothing (`HUB_EDITION_DRY_RUN`).

Deliver re-verifies the staged APK before publishing: the receipt is a success, the file name and sha match the receipt, the signer and package equal the policy pins, and the version and code equal the run's. If any check fails, nothing of that edition is published.

An edition never holds the device back. Its checks run per edition, and its publication runs after the device's `latest.json`, pages and `inflight.json` cleanup, so the S26's Install APK and catch-up get the new build whatever happens to an edition. A failed edition is logged (`::error::edition <name> ... was not published`), recorded in the deliver receipt (`editions[].pointer: "failed"` with its `reason`), and fails the deliver job only at its very end, once the device's delivery is written. Fix the cause and `gh run rerun <id> --failed`: the device publish repeats idempotently (same release, same run) and the edition is retried. No second bump.

## Obtainium

Add the app with source type HTML, URL `https://s3.delo.sh/builds/<slug>/editions/<edition>/index.html` (for Earshot beta: `https://s3.delo.sh/builds/earshot/editions/beta/index.html`). The page has exactly one APK link, whose file name carries the version, so a version regex such as `-(\d+\.\d+\.\d+)-\d+\.apk` extracts it. Verify the download with the `.sha256` file next to it.

## Failure modes

| Symptom | Meaning |
|---|---|
| `HUB_GATE_REFUSED pins: the manifest declares the Android edition ...; the policy pins no such edition` | add the pin in the hub (a hub release) |
| `... asks to publish the <edition> edition publicly; the policy does not allow it` | the policy pin lacks `public: true`; drop the manifest `public` block or release the policy change |
| `edition <name>: APK signer ... differs from the pinned` | the hook signed with the wrong key; nothing was installed or published |
| `... is declared twice` / `... already writes` | a copied block, a path shared by two editions; fixed before any bump |
| `HUB_EDITION_POINTER` | a build older than the published edition was kept out of the pointer |
| `the <name> edition was not published (...); the device's delivery stands` | deliver: the device is delivered; fix the edition's cause (staged bytes, receipt, a hand-edited edition `latest.json`) and rerun the failed job |
| `HUB_RELEASE_EDITION_HELD` | the repository is not private (or GitHub did not answer), so a private edition stayed off the Release |

## Earshot adoption

Earshot's Gradle build has the flavor dimension `edition` (`default` and `beta`; beta has `applicationId io.automaticai.earshot`) and both editions write `app/build/outputs/apk/release/app-release.apk`, so adoption is Earshot's work, not the hub's:

1. `scripts/android/build.sh` accepts `--edition <default|beta>` (or reads `HUB_EDITION`), assembles that flavor, and copies the APK to a distinct path, such as `build/hub/earshot.apk` and `build/hub/earshot-beta.apk`. The same keystore signs both, so both carry the pinned signer.
2. `mobile-deploy.json` gains the `android.editions.beta` block above, with its own artifact and receipt path. Add `public: {"title": "Earshot beta"}` only once public publication is authorized.
3. For public publication, a hub release adds `"public": true` to Earshot's beta pin in `tools/ci/policy.json`, and Earshot then pins that hub version.
4. Deploy through the hub only: `mise run deploy` (dry run, which builds and verifies both editions and publishes nothing), then `mise run deploy --dry-run false`. A failed run is resumed with `gh run rerun <id> --failed`, never a second bump.

The S26 stays on `sh.delo.earshot`: the beta is built and verified on every run but is never installed there.
