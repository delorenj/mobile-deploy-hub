# mobile-deploy-hub-ios-catchup (desk)

The clock of the iPad catch-up pass. Candybar on big-chungus fires `kick.mjs` every 5 minutes
(`*/5 * * * *`, America/New_York; policy `catch_up.ios_every_s` is 300). It kickstarts the Mac's LaunchAgent
`sh.delo.mobile-deploy-hub.catchup` over ssh (`hub-mac`), waits up to 20 minutes for the pass to finish, and reports
the job's `last exit code`. The LaunchAgent (`tools/catchup/units/sh.delo.mobile-deploy-hub.catchup.plist`) has no
`StartInterval` and no `RunAtLoad`: it is only the executor, because devicectl and the keychain work inside the
logged-in GUI session and never over plain ssh. This is the same shape as the Linux jobs: keep the unit, retire the
clock.

| situation | result in `candybar history` |
|---|---|
| pass ran, exit 0 | success, `iPad catch-up pass ok (run N)` |
| pass ran, nonzero exit or signal | **fail**, the exit code and the Mac log path |
| the job is already running (a slow install) | success, `HUB_MAC_BUSY`; never kicked or waited on twice |
| the Mac is away (hotspot, DERP, asleep: ssh exit 255, timeout) | success, `HUB_MAC_AWAY`; the next fire retries |
| LaunchAgent not loaded / kickstart refused | **fail**; run `mise run hosts:install` |

Away is deliberately not red (handoff.mjs treats the same trouble as retryable, not a failure); a real failure is.

Hand checks, no side effect: `node .candybars/mobile-deploy-hub-ios-catchup/kick.mjs --check` prints the job's
state, `runs` and `last exit code`. Do not `candybar run` it for a test: the pass can install a pending iPad build.

Register or change it from the hub: `candybar register --update` (the manifest's `enabled` is creation-time only;
`candybar pause|resume mobile-deploy-hub-ios-catchup` owns it). Proof is the Mac itself: `ssh hub-mac 'launchctl print
gui/$(id -u)/sh.delo.mobile-deploy-hub.catchup'` shows `runs` climbing and no `run interval`, and
`~/Library/Logs/mobile-deploy-hub/catchup.log` has a pass at each fire.

Rollback to the native clock (two clocks must never run together, so pause first):

```sh
candybar pause mobile-deploy-hub-ios-catchup
git revert <the commit that removed StartInterval/RunAtLoad>     # or restore them in the plist
mise run hosts:install                                           # re-renders and bootstraps the Mac's plist
```

The Mac record of this cutover lives in candybar's `deploy/migration/remote-natives.md` (the ledger cannot drive a
remote launchd job).
