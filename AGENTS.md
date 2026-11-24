<!-- bmad:context -->
<!-- Verified 2026-11-21 against 4cdefdc. Managed by bmad-project-context; edits inside this block are replaced on refresh. Keep anything you want preserved outside the markers. -->

## mobile-deploy-hub

The shared deploy pipeline every mobile app calls: a reusable workflow (`.github/workflows/mobile-deploy.yml`), the `actions/hub` composite action, Node ESM tools under `tools/` and one policy file. Node 24 through mise; there is no `package.json`. Design of record: `docs/design-hub-v1.1.md` (v1.0.0 history in `docs/design-hub-v3.md`); feature map `docs/features.md`; tickets on Plane board MOBI.

## Policy

- Mobile app versions ship only through this hub: `mise run deploy` (dry run), then `mise run deploy --dry-run false`. Nothing out-of-hub bumps a version, mints a tag, runs `gh release create`, uploads to TestFlight or installs a release build on a device.
- The deploy policy lives in `tools/ci/policy.json`. It is parsed strictly, never taken from an input, env var, app manifest or hook, and every job logs its digest. See the README's "Deploy policy" section for what it pins.
- Changing a rule is a hub release: edit `policy.json`, update its test, then `mise run release -- X.Y.Z` (conformance, tag `vX.Y.Z`, move `v1`, one strict dry run per app). Never special-case an app; apps inherit the policy through the `@v1` pin.
- Apps adopt the policy by copying `templates/deploy.yml` verbatim; the gate refuses any caller whose hash is not in `callers.accept`. Every command refuses a run another workflow started, and no app workflow but `deploy.yml` may name the hub (conformance, every gate and the global pre-commit guard check it).
- What a device may receive is pinned in `policy.json` (`apps.<repo>.android.package`, `.signer_sha256`, `.ios.bundle`); a new signing key is a hub release.
- An app with an iPad device lane and a TestFlight lane pins `ios.store_bundle` different from `ios.bundle` (the device bundle takes the suffix); apps not yet migrated sit on `shared_bundle_allowlist` and warn (README, "Separate bundle ids").
- Installs are always in place, with readback; the hub never uninstalls, clears data or downgrades.
- Write new hub code (tools, services, the API) in Node 24 ESM `.mjs`, never Python; the only Python is the plist-decode subprocess in `tools/ci/lib/apple.mjs`.
- Never commit `~/.config/mobile-deploy-hub/qa-devices.json` or its contents; shared device declarations go in `tools/ci/devices.json`.

## Where things are

- Device and emulator checkout: `tools/ci/lib/lock.mjs` (locks, leases, FIFO queues), `tools/device/hub-device.mjs` (CLI), `tools/device/emulator.mjs` (pool). Extend these; never add a second lock, queue or device store. Leases and deploys exclude each other only because they share lock names in one lock dir (`adb` is the S26).
- Anything that serves locks over a network runs on big-chungus as the runner user with the same `HUB_LOCK_DIR`: `lock.mjs` deletes a queue ticket from another host as stale; an owner from another host is honoured until its Lease's `expires_at`, or for 4 hours for a job lock. The `mac-ios` lock lives on the Mac's disk.
- The hub's control surface is a page in Holocene (`~/code/33GOD/holocene`; the Candybar page and `apps/api/src/candybar.ts` are the template). The hub keeps authority over leases and queues; Holocene reads them and forwards narrow writes server-side.

## Running and verifying

- `mise run check` runs actionlint and the full suite (~2.5 min); iterate with `node --test <file>`. CI runs the same task on every push (`.github/workflows/check.yml`).
- Tests are hermetic: lane test files call `hermetic()` from `tools/ci/test-fixtures.mjs`, and code under test takes an injected `fetchImpl` or fake. Never let a test reach the live build bucket (127.0.0.1:9012) or host state; the suite went red on 2026-11-19 when the live bucket started answering 403.

## Known pitfalls

- Run `hub-device status --json` to learn which phones and emulators are reachable and free; `devices.json` says what is declared, not what is available.
- Since v1.2.46 deploy jobs and the catch-up wait in the same FIFO as Leases, and a Lease on `adb` (`s26`) or `mac-ios` is capped at 60 min and cannot be extended while anyone waits. For long holds, lease `s24` or an emulator. Runs on hub pins older than v1.2.46 still take `adb` with a bare `mkdir` and can jump the line until they age out.
- Recurring hub work is a project candybar in `.candybars/` (the iPad catch-up is `.candybars/mobile-deploy-hub-ios-catchup/`, which kickstarts the Mac's interval-free LaunchAgent over ssh); never add a `.timer` or a launchd `StartInterval`.
- Take a lease as `vars="$(hub-device lease …)" && eval "$vars"`; never `eval` its output unchecked: on exit 75 the output is a `HUB_DEVICE_AWAY` line, which would run as a command.

<!-- /bmad:context -->
