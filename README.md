# Mobile Deploy Hub

A library of one reusable workflow and one small Node tool for deploying Godot mobile apps. The app repo is the caller, and the jobs run on the app's own repo-scoped self-hosted runners. The hub has no runners, no secrets and no CI of its own. Design and review notes: [docs/design-hub-v2.md](docs/design-hub-v2.md).

## Use it from an app

1. Allow private callers once: `gh api -X PUT repos/delorenj/mobile-deploy-hub/actions/permissions/access -f access_level=user` (already set; read it back with a GET).
2. Register a `Linux` runner (labels `linux`, `godot`) and a `macOS` runner (`ios-signing`) to the app repo.
3. Write the app's manifest (below) and a thin caller:

```yaml
on:
  workflow_dispatch:
    inputs:
      dry_run: { type: boolean, default: true }
permissions:
  contents: write   # checkout of the private app repo, plus the sideload Release
  id-token: write   # keyless Play auth
jobs:
  deploy:
    uses: delorenj/mobile-deploy-hub/.github/workflows/mobile-deploy.yml@main
    with:
      manifest: tools/ci/mobile-deploy.json
      dry_run: ${{ inputs.dry_run }}
      wif_provider: ${{ vars.GCP_WIF_PROVIDER }}
      play_sa: ${{ vars.PLAY_SA_EMAIL }}
```

The caller's ref and the `uses: delorenj/mobile-deploy-hub/actions/hub@main` refs inside the workflow must match. Every input is in the workflow's `on.workflow_call.inputs`.

## What a run does

| Job | Runs on | Does |
|---|---|---|
| `plan` | Linux | reads the manifest and the `version` hook, validates inputs, checks a `vX.Y.Z` tag against the version |
| `android` | Linux | `prepare`, `export` (or `bundle` for Play), checks the APK signer, writes receipts; on a real run publishes a private GitHub Release (sideload) or uploads to Play |
| `ios-export` | Linux | the app's export hook; checks the archive against the app's receipt |
| `ios-upload` | Mac | verifies the handoff, Xcode, the signing identity and the secret references; on a real run runs the app's `upload` and `assign` hooks |

`dry_run` is the default everywhere. A dry run builds and verifies; it never releases, uploads, assigns or contacts Play. `tools/ci/hub.mjs` refuses `play` and `release` on a dry run even if the workflow were miswired.

## The manifest

`mobile-deploy.json` in the app, read from the committed file at the built ref. Hooks are shell commands run from the app root with `HUB_OUT`, `HUB_BUILD`, `HUB_DRY_RUN` and `HUB_CHANNEL` set; store and GitHub tokens are stripped.

| Key | Meaning |
|---|---|
| `schema` | `1` |
| `version` | hook printing one line of JSON: `{"version":"X.Y.Z","android_code":N}` |
| `android.package`, `prepare`, `export`, `artifact`, `receipt`, `signer_sha256` | Android sideload lane. `artifact` is the APK; the signer pin is mandatory |
| `android.godot` | `{path, preset}` instead of `export`: the hub's fallback exporter (`GODOT_BIN`) |
| `android.bundle`, `bundle_artifact` | hook and path for the Play AAB |
| `ios.bundle`, `prepare`, `export`, `archive`, `receipt`, `upload`, `assign` | iOS lanes. The export hook writes `archive` and `receipt` into `$HUB_OUT/ios` |
| `ios.signer_sha1`, `ios.secrets` | the codesigning identity that must be in the Mac keychain, and `op://` references that must resolve |

Unknown keys, non-string hooks and paths outside the checkout are rejected.

## Where builds go

- **Android sideload:** a signer-checked, debug-signed APK in a private Release `vX.Y.Z` on the app repo. Install: `gh release download vX.Y.Z -p '*.apk' -D artifacts --clobber`, then the app's install task.
- **iOS:** the app's `assign` hook decides the TestFlight group. Tower assigns Owner Testing only (the developer account); the family group is a separate step.
- **Play:** blocked until an app declares an `android.bundle` hook and the Play launch spec lands. Keyless: `google-github-actions/auth` exchanges the GitHub OIDC token through Workload Identity Federation. See the design doc for the provider recipe.

## Checks

```sh
mise run check   # actionlint on the workflow, then node --test tools/ci/*.test.mjs
```
