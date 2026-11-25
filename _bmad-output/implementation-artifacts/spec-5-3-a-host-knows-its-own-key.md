---
title: 'A host knows its own key'
type: 'feature'
created: '2026-11-25'
status: 'done'
baseline_revision: '0996a71cbce9d9d02ef23ec8067b5e43ac1731bb'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** Nothing tells a host which `devices.json` host block it is, so "is this action local?" has no single answer, and another Linux or Mac machine could believe it is big-chungus or the Mac (AD-47).

**Approach:** `hosts:install` writes each host's key (`linux` or `mac`) to `~/.config/mobile-deploy-hub/host-key` and reads it back; `claims.mjs` exports `hostKey()` (reads the file behind a seam, checks it against the frozen `{linux: 'linux', mac: 'darwin'}` map, else `HUB_HOST_UNKNOWN`, exit 1) and `isLocal(record)`, which is `record.host === hostKey()` and nothing else.

## Boundaries & Constraints

**Always:**
- One owner of the key vocabulary: `claims.mjs` exports the frozen `HOST_PLATFORMS` map and the file's home-relative path; `hosts.mjs` imports them, never repeats them.
- The key is chosen by which host block `hosts:install` is installing (big-chungus locally is `linux`, `devices.mac.host` over ssh is `mac`), never derived from `uname` or a hostname; the platform is only a check.
- `hostKey()` throws `HUB_HOST_UNKNOWN` on a missing or unreadable file, an empty or unknown key, or a key whose platform is not `process.platform`; the message names the file and `mise run hosts:install`. `EXIT_CODES` lists `HUB_HOST_UNKNOWN: 1`.
- `isLocal` propagates `HUB_HOST_UNKNOWN` (an unknown host never decides it is local); a record with no `host` is not local.
- Every `HOST_PLATFORMS` key is a host block of the committed `devices.json`.
- Node 24 ESM, built-ins only; tests hermetic (temp homes, injected seams; no real ssh, fetch, git, 1Password, systemd or launchd).

**Never:**
- No change to `devices.json`, `policy.json`, the deploy path (`tools/ci/commands/*`, `tools/catchup/*`, which must not import `claims.mjs`), `install.sh`, or any `hub-device` command, flag, exit code or `--json` shape.
- No existing `hosts:install` step changes what it does, logs or how it fails (it collects step failures and throws at the end); it has no dry-run today and gains none.
- No callers of `isLocal` beyond tests yet (Hub API, Host Agent, status are later stories); no Reachability, Registry or `hub-client` work.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Linux host | file `linux\n`, platform `linux` | `hostKey()` → `'linux'` | No error expected |
| Mac host | file `mac\n`, platform `darwin` | `'mac'` | No error expected |
| Missing file | no file | throws | `HUB_HOST_UNKNOWN`, message names the path and `hosts:install`; `exitCodeOf` → 1 |
| Wrong platform | file `mac`, platform `linux` | throws | `HUB_HOST_UNKNOWN` naming file, key, platform |
| Unknown / empty / unreadable | `windows`, `Linux`, empty, a directory | throws | `HUB_HOST_UNKNOWN` |
| Remote record | `{host: 'mac'}` with key `linux` | `isLocal` false | — |
| Local record | `{host: 'linux'}` with key `linux` | true | — |
| No host on record | `{}` | false | — |
| Unknown host | key seam throws | `isLocal` rethrows | `HUB_HOST_UNKNOWN` |
| Install | `hostsInstall` with fake runner | `<linuxHome>/.config/mobile-deploy-hub/host-key` = `linux\n`, `<macHome>/…` = `mac\n`, `HOSTS host key on …` lines | other steps' failures unaffected |
| Platform guard | key script for `mac` run where `uname -s` is `Linux` | nothing written | script exits non-zero; step logs `HOSTS_FAILED` |

</intent-contract>

## Code Map

- `tools/device/claims.mjs` -- the Claims library (AD-24). `EXIT_CODES` L28-40 (add `HUB_HOST_UNKNOWN: 1`); `failure(code, message)` L44 builds coded errors; imports L9-19 (`node:fs` has only `statSync`, add `readFileSync`; add `homedir` from `node:os`). Add a `---- the host key (AD-47) ----` section exporting `HOST_PLATFORMS`, `HOST_KEY_FILE` (`.config/mobile-deploy-hub/host-key`), `hostKeyPath(home)`, `hostKey({ env, home, platform, readFile })`, `isLocal(record, { hostKey })`.
- `tools/hosts.mjs` -- `mise run hosts:install` (mise.toml L159-162), run on big-chungus. `sh()` L23 is the one process runner and `releaseName()` L28 uses it; `hostsInstall({ log })` L59 runs named `step`s that log `HOSTS <name>: <result>` / `HOSTS_FAILED <name>: …` and throws `hosts:install: <names> failed` at the end; `host = devices.mac.host` (`hub-mac`); global `fetch` in the build-directory step; the Mac is reached as `sh('ssh', [...ssh, host, '<cmd>'], { input })` (pattern of the handoff-cache step). Has no seams and no tests today.
- `tools/ci/devices.json` -- host blocks `linux` (`host: big-chungus`) and `mac` (`host: hub-mac`); read-only here.
- `tools/deploy-path.test.mjs` -- `FORBIDDEN` includes `tools/device/claims.mjs`; `hosts.mjs` is not on `DEPLOY_PATH`, so it may import claims. Must stay green.
- `tools/device/claims.test.mjs` L52-64 -- pins the export list and the exact `EXIT_CODES` object; the `EXIT_CODES` deepEqual is an intended named change (add the new code).
- `tools/device/hub-device.test.mjs` L1262 -- the pattern for driving a shell script hermetically: temp `HOME`, PATH shims for `uname`/`systemctl`/`launchctl`.
- `tools/device/hub-device.test.mjs` L421-431 -- scans `tools/hosts.mjs` for `android_extra`; keep that word out of hosts.mjs.

## Tasks & Acceptance

**Execution:**
- `tools/device/claims.mjs` -- add the host-key section: frozen `HOST_PLATFORMS = {linux: 'linux', mac: 'darwin'}`; `HOST_KEY_FILE`; `hostKeyPath(home)`; `hostKey({ env = process.env, home = env.HOME || homedir(), platform = process.platform, readFile = readFileSync } = {})` reading and trimming the file and throwing `HUB_HOST_UNKNOWN` per the matrix; `isLocal(record, { hostKey: keyOf = hostKey } = {})` returning `record?.host === keyOf()`; `HUB_HOST_UNKNOWN: 1` in `EXIT_CODES`; mention the host key in the header comment. -- AD-47's reader and the one locality test.
- `tools/hosts.mjs` -- export `hostKeyScript(key)` (refuses a key not in `HOST_PLATFORMS`; a POSIX `sh` script that refuses when `uname -s` lowercased is not the key's platform, writes `$HOME/<HOST_KEY_FILE>` atomically via a `.part` rename, and prints the file back); thread a `run` seam (default the existing `sh`) and a `fetchImpl` seam (default global `fetch`) through `hostsInstall` and `releaseName`; add steps `host key on big-chungus` (`run('sh', ['-s'], { input: hostKeyScript('linux') })`) and `host key on the Mac` (`run('ssh', [...ssh, host, 'sh -s'], { input: hostKeyScript('mac') })`) after `hub-mac`, each failing unless the readback equals the key; update the header comment. -- the writer, with readback.
- `tools/device/claims.test.mjs` -- add `HUB_HOST_UNKNOWN: 1` to the pinned `EXIT_CODES`; add `hostKey`, `isLocal`, `hostKeyPath` to the export list. -- named intended change.
- `tools/hostkey.test.mjs` -- NEW: the I/O matrix for `hostKey` (temp home and `readFile`/`platform` seams) and `isLocal`; `HOST_PLATFORMS` frozen and every key a host block of the committed `devices.json`; `hostKeyScript` run by real `sh` under a temp `HOME` with a `uname` shim for each host block (writes `<key>\n`, prints it, leaves no `.part`; refuses the wrong platform and an unknown key); `hostsInstall` with a fake `run` (real `sh` for the two host-key scripts, one temp home per host, `ok` for every other command) and a failing `fetchImpl` writes both files, logs both `HOSTS host key …` lines and rejects naming only the build-directory step; a source check that `claims.mjs` decides locality only in `isLocal`. -- one test per AD rule.

**Acceptance Criteria:**
- Given `claims.mjs`, when `hostKey()` runs with a valid key file for the current platform, then it returns that key; when the file is missing or the key disagrees with `{linux: 'linux', mac: 'darwin'}`, then it throws `HUB_HOST_UNKNOWN` naming the file and `hosts:install`, and `exitCodeOf` gives 1.
- Given `hosts:install` (`hostsInstall`), when it runs for both host blocks, then big-chungus's home holds `host-key` = `linux` and the Mac's holds `mac`, each read back, with every pre-existing step unchanged, and the test writes only under temp homes.
- Given a record with `host: 'mac'`, when `claims.isLocal(record)` runs on a `linux` host key, then it is false, and `isLocal` is `record.host === hostKey()` alone.
- Given this story's diff, when `git diff --stat` is read, then `tools/ci/devices.json` is not in it.

## Spec Change Log

## Review Triage Log

### 2026-11-25 — Review pass
- verdicts: 27 findings — high 0, medium 3, low 12, false 12, maybe-false 0
- findings:
  - `[medium]` `[patch]` (blind) the host-key readback compares the whole merged stdout+stderr of `sh()` to the key, so an ssh stderr notice fails a correct write — `hostKeyScript` now prints a `HOST_KEY=<key>` sentinel and `writeKey` compares the last sentinel line; new hostsInstall case with ssh warnings around the sentinel passes.
  - `[low]` `[reject]` (blind) `hosts:install` run on a second Linux box would label it `linux` — `hosts:install` is documented to run on big-chungus only (hosts.mjs header, README); a machine never installed gets no key, which is what AD-47 relies on; a hostname guard adds a branch for a misuse no procedure leads to.
  - `[false]` `[reject]` (blind) `hosts.mjs` importing `claims.mjs` for two constants adds cycle and side-effect risk — `claims.mjs` does not import `hosts.mjs` (no cycle), its imports have no top-level side effects (the hermetic hostkey test imports both), and the spec makes claims the one owner of the vocabulary.
  - `[false]` `[reject]` (blind) nothing consumes `isLocal` and the one-place check covers only `claims.mjs` — no current front door decides locality (lock owner `host` is a hostname for staleness, not a Resource's host); the epic assigns callers to 5.7-5.9 and Epics 6-9.
  - `[low]` `[patch]` (blind) tests brittle or mislabelled: exact-text regex, a HOME test titled as covering the `homedir()` fallback it never runs, no `releaseName` assertion — the HOME test is renamed to what it covers; the source regex and `releaseName` are left (the regex pins AD-47's literal rule; `releaseName` is unchanged behaviour behind a default seam).
  - `[false]` `[reject]` (blind) `HUB_HOST_UNKNOWN` exits 1 like a generic failure — exit 1 is what the story's AC and AD-47 require.
  - `[low]` `[patch]` (blind) the new on-disk file is not documented — README's `hosts:install` line now names each host's key and its path.
  - `[low]` `[reject]` (blind) no memoisation of `hostKey()`, fixed `.part` name, no fsync — no caller loops over records yet, and `hosts:install` is a single operator run; concurrency guards add complexity for a case nobody meets.
  - `[medium]` `[patch]` (edge) readback fails on ssh stderr noise — same root cause and fix as the blind readback row.
  - `[low]` `[reject]` (edge) `$HOME` unset makes the script write `/.config/...` — ssh and the operator's shell always set HOME, and as a non-root user `mkdir -p /.config` fails and the step fails loudly.
  - `[low]` `[reject]` (edge) a directory at the key path, a stray `.part`, or two concurrent installs — each makes `mv`/`cat` fail and the step report `HOSTS_FAILED`; concurrent `hosts:install` runs do not happen.
  - `[low]` `[reject]` (edge) a non-big-chungus Linux machine running `hosts:install` writes `linux` — same as the blind second-Linux-box row.
  - `[false]` `[reject]` (edge) runner-user services resolve a different `$HOME` — on big-chungus the runners and lock services run as the same user that runs `hosts:install` (`~/actions-runner/`), the same home install.sh already writes `catchup.json` into.
  - `[false]` `[reject]` (edge) records carrying `big-chungus`/`hub-mac` would be non-local — AD-47 fixes a Resource's `host` as a host key, never an alias or hostname; no record carries the alias.
  - `[low]` `[reject]` (edge) `hostKey()` re-reads the file on every `isLocal` — same as the blind memoisation row: no caller yet, the read is tiny.
  - `[low]` `[reject]` (edge) the source regex misses `['host']`/destructured forms and breaks on reformat — the regex pins the AD-47 rule as written in `claims.mjs`; a runtime test of `isLocal`'s default now also covers behaviour (verification-gap row).
  - `[low]` `[patch]` (verification-gap) `isLocal`'s default wiring to `hostKey()` was pinned only by a source regex — added a Linux-guarded runtime test with a temp `HOME`: true for `linux`, false for `mac`, `HUB_HOST_UNKNOWN` with no key file.
  - `[medium]` `[patch]` (verification-gap) readback fails on noisy stderr — same root cause and fix as the blind readback row.
  - `[false]` `[reject]` (verification-gap) "existing dry-run unchanged" is unverified — `hosts:install` has no dry-run before or after this change (Design Notes); there is nothing to change.
  - `[low]` `[reject]` (verification-gap) the hostsInstall test assumes every other step's fake returns `ok` — a new failing step would change that assertion by design; the fake is the hermetic boundary.
  - `[false]` `[reject]` (intent) no front door switched to `isLocal` — the epic plan puts callers in 5.7-5.9 and Epics 6-9, and no current front door makes a locality decision for the AC to replace.
  - `[false]` `[reject]` (intent) real records do not carry host keys yet — AD-47 defines the Registry's `host` as a host key; the Registry is Epic 6; the emulator record's `host` is a hostname for its own staleness check.
  - `[low]` `[reject]` (intent) tests drive `hostsInstall()` rather than the `node tools/hosts.mjs` entry — the entry is a one-line wrapper; running it would reach the network, ssh and 1Password, which the AC's hermetic requirement forbids.
  - `[false]` `[reject]` (intent) the writer (shell) and reader (JS) are separate implementations — they share `HOST_PLATFORMS`/`HOST_KEY_FILE`, and a test round-trips the writer's file through the reader.
  - `[false]` `[reject]` (intent) the seam is a parameter, not module-wide — the epic's seam list names `hostKey` as an injected seam, which is how `isLocal` takes it.
  - `[false]` `[reject]` (intent) the `run`/`fetchImpl` rewiring goes beyond writing the key — it is behaviour-preserving (defaults are the old `sh`/`fetch`) and required by the AC's hermetic test.
  - `[false]` `[reject]` (intent) operator actions may apply — every AC is code-level; writing the real files on both hosts is Story 5.10's release `hosts:install`, which agents run under standing approval.

## Design Notes

- The key is the host block, not the OS: `uname` only guards against writing `mac` onto a Linux box. This is what keeps a second Linux machine from claiming to be big-chungus (rubric H7): it never gets a key unless `hosts:install` names it.
- Writing via a shell script for both hosts gives one mechanism the test runs for real; locally it is `sh -s`, on the Mac `ssh hub-mac 'sh -s'`, both with the script on stdin, the handoff-cache pattern.
- "Existing dry-run and readback behaviour unchanged": `hosts:install` has no dry-run; existing steps are untouched, and the new steps carry their own readback.
- Shipping the file to the real hosts is the Story 5.10 release (`hosts:install` on both hosts), not this story.

## Verification

**Commands:**
- `node --test tools/hostkey.test.mjs tools/device/claims.test.mjs tools/deploy-path.test.mjs tools/device/hub-device.test.mjs` -- expected: all pass
- `git diff 0996a71cbce9d9d02ef23ec8067b5e43ac1731bb --stat -- tools/ci/devices.json` -- expected: empty
- `mise run check` -- expected: actionlint clean, full suite green

## Auto Run Result

Status: done

**Summary.** Each host can now know which `devices.json` host block it is (AD-47). `claims.mjs` owns the vocabulary: the frozen `HOST_PLATFORMS` map (`{linux: 'linux', mac: 'darwin'}`), `HOST_KEY_FILE` (`.config/mobile-deploy-hub/host-key`) and `hostKeyPath`. `hostKey()` reads the file behind `env`/`home`/`platform`/`readFile` seams and throws `HUB_HOST_UNKNOWN` (exit 1, now in `EXIT_CODES`) for a missing or unreadable file, an empty or unknown key, or a key whose platform is not this one; every message names the file and `mise run hosts:install`. `isLocal(record)` is `record?.host === hostKey()` and nothing else, and an unknown host rethrows rather than deciding. `hosts:install` gains two steps after `hub-mac`: `host key on big-chungus` (`sh -s`) and `host key on the Mac` (`ssh hub-mac 'sh -s'`). Both run one script that refuses the wrong `uname`, writes through a `.part` rename and prints a `HOST_KEY=<key>` readback that the step checks. `devices.json` is unchanged.

**Files changed.**
- `tools/device/claims.mjs`: the host-key section (`HOST_PLATFORMS`, `HOST_KEY_FILE`, `hostKeyPath`, `hostKey`, `isLocal`) and `HUB_HOST_UNKNOWN: 1`.
- `tools/hosts.mjs`: `hostKeyScript(key)`, the two host-key steps with readback, and `run`/`fetchImpl` seams on `hostsInstall` and `releaseName` (defaults are the old `sh` and `fetch`; no other step changed).
- `tools/hostkey.test.mjs`: new, 16 hermetic tests. They cover the I/O matrix for `hostKey`/`isLocal`, the vocabulary against `devices.json`, the script under a `uname` shim for each host block, `hostsInstall` with a fake runner and a temp home per host (write, readback mismatch, wrong platform, ssh noise around the sentinel), and `isLocal`'s default wiring at runtime.
- `tools/device/claims.test.mjs`: the pinned export list and `EXIT_CODES` include the new names (a named, intended change).
- `README.md`: the `hosts:install` line names each host's key and its path.

**Review findings.** There were 27: high 0, medium 3, low 12, false 12, maybe-false 0.
- **Patched (4 entries).** The readback now uses a `HOST_KEY=` sentinel, so ssh stderr notices cannot fail a correct write (medium; grouped from blind, edge and verification-gap). The mislabelled HOME test is renamed (low). The README documents the file (low). A runtime test now covers `isLocal`'s default wiring (low).
- **Deferred.** None.
- **Rejected.** Every rejection and its reason is in the Review Triage Log, 2026-11-25 pass. They are: a second Linux box running `hosts:install` (it runs on big-chungus only); the `claims.mjs` import (no cycle or side effect); no `isLocal` callers yet (Stories 5.7-5.9, Epics 6-9); exit 1 (required by the AC); memoisation, `.part` concurrency, unset HOME and directory-at-path (each fails loudly or never happens); runner-user homes (same user); alias-valued records (AD-47 forbids them); the source-regex brittleness; the fake-runner assumption; driving `hostsInstall()` instead of the script entry (hermetic requirement); the vacuous dry-run clause; and operator actions (all ACs are code-level).
- **Follow-up review recommended: false.** This pass patched 1 medium entry and 3 low entries, with no high.

**Verification.**
- `node --test tools/hostkey.test.mjs tools/device/claims.test.mjs tools/deploy-path.test.mjs` passes.
- `git diff 0996a71cbce9d9d02ef23ec8067b5e43ac1731bb --stat -- tools/ci/devices.json` is empty.
- `mise run check` exits 0, with 764 of 764 tests passing and actionlint clean. It ran after the review patches.
- The matrix audit passed: every I/O row has a covering test that ran.

**Residual risks.**
- The key-writing steps have not run over real ssh to the Mac. They are tested with a fake runner and a `uname` shim only. The first real run is Story 5.10's `hosts:install` on both hosts. Until it runs, any future `hostKey()`/`isLocal()` caller on those hosts gets `HUB_HOST_UNKNOWN`. Nothing calls them yet.
- `hosts:install` assumes it runs on big-chungus. Run elsewhere, it would label that Linux machine `linux`.
