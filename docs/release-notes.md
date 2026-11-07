# Authored build notes (MOBI-9)

Each app may commit `tools/ci/release-notes.json` in its own repository. The hub reads that file at the build revision; it is **not** a new manifest key or deploy-policy knob, and existing apps without it keep deploying. Example:

```json
{
  "schema": 1,
  "releases": {
    "1.2.0": {
      "kind": "app",
      "whats_new": ["A clearer result screen"],
      "try": ["Finish a match and inspect the result"],
      "limitations": ["Offline results still wait for a connection"]
    },
    "1.2.1": {
      "kind": "maintenance",
      "whats_new": [],
      "try": [],
      "limitations": ["Only server-side maintenance; no player-visible changes"]
    }
  }
}
```

The keys are exact *planned* app versions, not hub versions. Author entries in advance of `mise run ship`; the deploy bump touches only the existing app version authority. Write product language, not commit subjects. `kind: app` is for app-visible work; `kind: maintenance` distinguishes backend/infrastructure-only work and cannot contain `whats_new` or `try`. All three lists are explicit arrays (empty is fine). There is no automatic claim that the authored entries describe every source change.

The plan captures entries strictly after the prior **published app version** and through this build's version, plus the previous published revision and this build revision. This includes changes skipped by earlier failed/unpublished runs. The plan receipt carries the snapshot to the private Release and delivery; the delivery writes `builds/<slug>/<version>/release-notes.json` once. Subsequent platforms and failed-job reruns reuse that record, rather than rewrite it from current main. The app page renders the newest notes beside install buttons and notes for retained APK history (older releases without a note object say so honestly); the notification's Builds button points to that same page. The notification's operational summary stays operational because its existing event contract caps it at 200 characters.

**Policy isolation:** MOBI-9 leaves `tools/ci/policy.json` byte-for-byte equal to deployed `v1` (`v1.2.25`). The optional completion contract is parsed and tested but not enabled: TestFlight remains caller opt-in, unavailable iOS lanes skip, absent devices may be pending, and ship does not require devices or automatically rerun. Requiring all lanes, TestFlight, or pre-bump lane refusal is a separate policy release, not a release-notes side effect.

**Migration:** add the tracked JSON to an app when ready, starting with its next planned version; no backfill or caller-template edit required. A missing file or all-missing range yields “No author-written release notes were supplied”, not generated prose or a failed routine deploy. If the range has earlier authored entries but no entry for the current build, those entries remain visible with an explicit warning that the current version has no author-written notes. A malformed present file fails early in plan rather than publishing misleading words. Old versions that lack the immutable object display an honest absence. Release from hub main only after review via the existing `mise run release` procedure, which moves `v1` after conformance and dry-run proofs. No release or S3 publication is part of this branch.

**Known scope:** the private Release carries the authored snapshot from plan; it can be created before S3 delivery completes, so its build-page link may become available later. Historical notes are shown for the retained APK history, not all purged versions. No retrospective notes are fabricated from git subjects. This change does not modify version ownership, gates, or the caller template.
