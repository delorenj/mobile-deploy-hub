# Input reconciliation: Hub Resource Registry PRD

Reviewed: `prd.md` and `addendum.md` (both dated 2026-11-21 20:01) against three inputs: the seed, `.memlog.md`, and the owner's verbatim words. Neither PRD file was edited.

## Verdict

The PRD captures the owner's explicit asks (registry, queue and sign-up, ETA, capacity, Holocene page, Node API, FCFS, all v1 resources, all claimants) and keeps the working leasing code. It narrows one qualitative complaint ("doesn't know what phones are available to deploy to") to agent-side discovery by deferring deploy targeting to v2 without an owner decision, and it adds a layer of research-driven mechanism (fencing, jeopardy, quarantine, alerts, retention) that nobody asked for.

## Input 1: the seed (`resource-registry-seed.md`)

### Captured
- All six slices are present: event log (FR-17..19), fair queue plus reservation (FR-7..9), registry (FR-1..6), Node API (FR-21..23), ETA and capacity (FR-15, FR-19), Holocene page (FR-24..28).
- Gaps 2, 3 and 4 map cleanly: starvation (FR-7..9, FR-12), no wait data (FR-17), no API or UI (FR-21, FR-24).
- "Keep it, wrap it" is honoured by NFR-1 and FR-13. Host-bound staleness is honoured by NFR-6 and the loopback-on-big-chungus decision. Compatibility with pinned runs is honoured by NFR-2.
- Belsky level-up is honoured: all Claimant kinds and all Resource kinds go through one Queue.

### Dropped or distorted
- **Seed slice 3, "Deploys target any registered, free, compatible device", is cut to v2** (prd §7.2). The seed lists it inside the Registry slice, and its gap 1 evidence (the four hard-coded S26 / `adb` sites) is about deploys. See Finding F1.
- **The seed's event-log-first sequencing is not in the PRD body.** It sits only in addendum B.10. The PRD lists the Event Log as one of six equal v1 bullets (§7.1). UJ-4 and SM-4/5 depend on accumulated history, so the PRD should say the Event Log ships first.
- **Open questions answered silently.** Per run vs per app (the PRD chose per run, with no memlog entry and no §9 question). Priority is answered by the owner. The registry store is delegated and answered. Bloodbank is deferred in §7.2 without an owner decision; the memlog's own g33 route line mentions bloodbank events.
- **Seed slice 4 says remote holders keep place via `updateLease` heartbeats.** The PRD sets numbers (30s/90s) as assumptions; that is fine.
- **Mac Agent is required for v1 (FR-12) but its mechanism is open** (§9 Q2, addendum B.6 option a or b). The seed flagged it as a need. It is the riskiest v1 dependency, and the PRD does not mark it as such.

## Input 2: `.memlog.md`

### Captured
- v1 resources, all-three claimants, pure FCFS, Holocene page, Node, registry store in lock dir with `devices.json` as seed. All five are faithfully realised (§3, FR-1, FR-3, FR-7, §4.6, NFR-4, §4.1 assumption).

### Dropped or distorted
- The memlog records no decision to defer deploy targeting, no decision to exclude other hosts, no decision on per-run vs per-app, and no decision on Bloodbank. Four scope shapers in the PRD have no memlog trace. §7.2 and §6 present them as settled.
- The memlog's last line says comparables research was "folded" into FR-8/9/10. That is the origin of the scope creep listed below.

## Input 3: the owner's words

| Owner intent | PRD treatment | Verdict |
|---|---|---|
| "Nothing wrong with what it's doing... codify it. I don't want to lose it." | NFR-1, FR-13 (CLI compat, works with API down), FR-3 (seed keeps lock names). | Honoured for the code. Partly eroded: see F3 (second source of truth) and the creep list (changes to reclaim/handoff behaviour: 15 s quarantine, grace holds, deploy wait caps). |
| "Expand it... put more resources in... register." | FR-1..4, UJ-3, no hub release. | Honoured. Emulator registration is thin: FR-1's identity (serial, UDID, host) does not fit an emulator profile or pool size, which §4.1 says become Registry entries. Low. |
| "Sometimes it doesn't know what phones are available to deploy to." | FR-4/5/6 give discovery, reachability, find-by-capability, a deploy-eligible flag. Deploys still hard-code S26 and the iPad (§7.2). | Partly honoured. See F1. |
| "Another project starved... how long does it have to wait?" | FR-15/16 ETA, position, `HUB_LOCK_WAIT` log line, FR-8. | Honoured. |
| "A formal way to sign up for the next run." | FR-9 Reservation, claimed in the install job. | Honoured for a run. "Sign up for the next run" could also mean a standing per-app sign-up; the PRD silently picks per run. Medium-low. |
| "No surface or interface other than my tasks." | Hub API plus Holocene page; CLI stays. | Honoured. |
| "A distributed set of resources." | Two hosts only (big-chungus and hub-mac); other hosts are a non-user (§2.2) and non-goal (§6). Authority is one Hub API on big-chungus. | Narrowed. See F2. |
| "Not a tray... its own page in Holocene, the canonical control surface." | §4.6, FR-24..28, NFR-6. | Honoured. JTBD says "wherever he is" but §7.2 defers phone-webview access, so that is an overclaim. Low. |
| "Register emulators and devices, check them out, queue up." | FR-1/7/10/12. | Honoured. |
| "How much time we could save if we added a resource." | FR-19, UJ-4, addendum B.9 (Allen-Cunneen, Erlang A, bootstrap). | Honoured. Output is a mean-wait delta, not a "time saved" total (for example hours per week); the PRD could state that translation. Low. |
| "Built on a proper API, Node not Python." | FR-21..23, NFR-4. | Honoured. |
| "Phones, emulators, iPad, Mac in v1; all three claimants; FCFS; you make the call on storage." | §3, FR-7, FR-12, §4.1. | Honoured. |

## "Phones available to deploy to" versus the v2 deferral

Short answer: only half honoured, and the half that is dropped is the half the seed's evidence points at.

- What v1 delivers: a human or agent can list phones, see Reachability, see who holds each, and find a free one by Capability (FR-4/5/6, FR-14). That answers "what phones exist and are free" for leasing.
- What v1 does not deliver: any deploy run choosing among phones. The seed's gap 1 lists deploys hard-coding the S26 and `adb` at `plan.mjs:230-232`, `android.mjs:94-102`, `gate.mjs:138-140` and `catchup.mjs:456-460` as the discovery gap. §7.2 defers exactly that.
- The `deploy-eligible` flag (FR-1, FR-2, UJ-3 "whether deploys may install on it") is accepted, stored and displayed, but nothing in v1 consumes it. UJ-3 tells Jarad he registered a phone "deploys may install on" when, in v1, no deploy will.
- The deferral trigger is circular: "revisit when a second deploy-eligible phone is registered" (§7.2), yet registering one yields no benefit until the deferred work is done.

## Findings

### F1 (high): deploy targeting deferred without an owner decision, and the rationale is inconsistent
- **Where:** prd §7.2 bullet 2; FR-1, FR-2, UJ-3 (deploy-eligible flag); §6; addendum A "Declarations".
- **Issue:** The owner's complaint is "doesn't know what phones are available to deploy to". The PRD removes the deploy path from v1, and the memlog has no decision for it. The stated reason ("touches delivery, receipts, catch-up and completion") is weakened by the PRD's own scope: FR-9 (Reservation across plan to android/iOS jobs), FR-10 (fencing tokens presented at install and readback) and FR-12 (iOS jobs queue) already modify `plan.mjs`, `android.mjs`, `ios.mjs` and the catch-up. The deploy-eligible flag is a dead field in v1.
- **Fix options:** (a) promote a minimal targeting slice into v1 (deploys resolve the deploy phone from the Registry by deploy-eligible, with a single eligible phone still the S26); (b) keep the deferral but get Jarad's explicit sign-off, add it to §9 and §10, and either hide the flag or label it "informational in v1"; and fix the circular revisit trigger.

### F2 (high): "distributed set of resources" is narrowed to two hosts with no recorded decision
- **Where:** prd §2.2 bullet 2, §6 bullet 5, NFR-6, §4.5 intro; memlog (no entry).
- **Issue:** The owner's phrase is open-ended. The PRD hard-limits to big-chungus and `hub-mac` and makes the Hub API a loopback-only single authority. That follows the seed's technical constraint (host-bound staleness), but it was a constraint, not an owner decision. The PRD should say whether a resource on a third host (another Mac, a Linux box with a USB phone) is a v1 non-goal because of the staleness model, and record Jarad's sign-off. Registry entries already carry a host identity (FR-1), which invites exactly that expectation.

### F3 (medium): two sources of truth for devices; "codify" risks forking behaviour
- **Where:** prd §4.1 description and FR-3; addendum B.5; FR-2.
- **Issue:** `devices.json` "stays as the record of the deploy baseline" while `registry.json` becomes authoritative for leases. Deploys keep reading `devices.json` (F1). Retiring or editing the S26 in the Registry therefore does not affect deploys, which contradicts NFR-1's "one implementation" spirit and "don't lose what works". State which file wins for deploys and how drift is shown.

### F4 (medium): Reservation grace may not close the failure the owner is describing
- **Where:** FR-9 (grace = 10 minutes), SM-1 (target 0 failures), seed gap 2 (starved android job fails after version bump).
- **Issue:** A Reservation at the head of the queue holds the Resource only for the 10-minute grace window. If the build between plan and install takes longer, or the holder ahead holds a 48 h Lease, the run can still lose its place or time out after the version bump. The PRD does not say whether the plan job blocks until the Reservation is secured before bumping, nor what happens to the bumped version on a lost Reservation. SM-1's absolute target of 0 is not supportable against 48 h Leases. State the version-bump ordering, or relax SM-1.

### F5 (medium): scope creep from the comparables research
No input asked for these. Each should be justified by a real failure or cut.
- Fencing tokens checked at install/readback (FR-10): changes deploy steps.
- "In jeopardy" state and 15 s quarantine after lapse (FR-10): changes today's immediate dead-pid reclaim feel.
- Self-deadlock detection (FR-9); deploy wait capped below job timeout (FR-8). The cap is justified by the seed's 20-minute collision, but is a workflow change.
- Starvation signal and away/absent alerts (FR-20, FR-28, §9 Q4).
- 90-day retention with compaction to daily aggregates (FR-18) and a recurring Candybar compaction job (NFR-3).
- Per-Resource utilisation history (FR-18, FR-27) beyond ETA and capacity.
- Force-release with audit (FR-11) and "lease from the page" (FR-26). Reasonable control-surface features, but not requested by the owner.
- Counter-metrics SM-C1..C3 and five success metrics for a one-operator tool.

### F6 (low): minor distortions and omissions
- JTBD "from Holocene, wherever he is" versus §7.2 deferring phone-webview access.
- Per-run sign-up chosen silently (see table). Not in §9.
- FR-8's third consequence is garbled: "while it is first in line and the Resource is held only by Claimants behind it" (a holder is by definition ahead).
- Emulator registration (identity and pool size) has no FR-level consequence.
- The Holocene page lives in another repo; the PRD folds FR-24..28 into hub v1 scope with no cross-repo dependency or owner note.

## Scope-creep summary (adds nothing asked for)
Fencing tokens, jeopardy and quarantine, self-deadlock detection, starvation and away alerts, 90-day retention and compaction, utilisation history, force-release audit, Allen-Cunneen/Erlang A/bootstrap method detail (belongs in the addendum only), counter-metrics. Everything else traces to the owner's words or the seed.
