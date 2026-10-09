# Mobile Deploy Hub

Agent rules for this repo.

- Mobile app versions ship only through this hub: `mise run deploy` (dry run), then `mise run deploy --dry-run false`. Nothing out-of-hub bumps a version, mints a tag, runs `gh release create`, uploads to TestFlight or installs a release build on a device.
- The deploy policy lives in `tools/ci/policy.json`. It is parsed strictly, never taken from an input, env var, app manifest or hook, and every job logs its digest. See the README's "Deploy policy" section for what it pins.
- Changing a rule is a hub release: edit `policy.json`, update its test, then `mise run release` (conformance, tag `vX.Y.Z`, move `v1`, one strict dry run per app). Never special-case an app; apps inherit the policy through the `@v1` pin.
- Apps adopt the policy by copying `templates/deploy.yml` verbatim; the gate refuses any caller whose hash is not in `callers.accept`. Every command refuses a run another workflow started, and no app workflow but `deploy.yml` may name the hub (conformance, every gate and the global pre-commit guard check it).
- What a device may receive is pinned in `policy.json` (`apps.<repo>.android.package`, `.signer_sha256`, `.ios.bundle`); a new signing key is a hub release.
- Installs are always in place, with readback; the hub never uninstalls, clears data or downgrades.
- Design of record: `docs/design-hub-v1.1.md` (v1.0.0 history in `docs/design-hub-v3.md`).
