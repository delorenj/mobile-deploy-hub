# Epic 9 Context: The iPad and the Mac, from big-chungus

<!-- Generated from planning artifacts. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Make the Mac and its iPad visible and leasable from big-chungus without ssh by hand. This is the only cross-host work in v1b. The Mac's `ios-lane` (lock `mac-ios`) keeps its lock on the Mac's disk and the Mac renders its own state. Every cross-host action is a forward over ssh to that host's own loopback service, and the Mac pushes only changes, never a stream, because it is a laptop that sleeps. Deploy jobs and the iPad catch-up never depend on any of this.

## Stories

- Story 9.1: Cross-host calls go through one client
- Story 9.2: The Host Agent serves the Mac's own state
- Story 9.3: Forwarded actions reach the right host
- Story 9.4: `lease ipad` and `lease mac` take the `ios-lane`
- Story 9.5: The Host Agent pushes changes, and only changes
- Story 9.6: An asleep Mac reads `offline`, and fails fast
- Story 9.7: The Host Agent runs on the Mac as its own LaunchAgent
- Story 9.8: Ship the Mac Host Agent

## Requirements & Constraints

- An action on a Resource runs on that Resource's host; no host ever writes another host's lock dir. The Mac's lock dir and clock are authoritative for the `ios-lane`, so every Queue timestamp there comes from the Mac.
- `lease ipad` and `lease mac` both take the `ios-lane` with the 60 min deploy-target cap. `lease ipad` also needs iPad Reachability `reachable` (unless `--no-connect`); `lease mac` needs only the host. Exit codes and `HUB_DEVICE_*` lines stay as today.
- An unreachable Mac fails fast: `HUB_DEVICE_AWAY` (exit 75, reason `host-unreachable`) with the connect timeout in the message, never a hang and never a place in line.
- No new clock (NFR-3, NFR-8): services and the agent never poll or reap on a timer. The agent pushes only on a lock/event-dir write, a Reachability change, or its own start, within 250 ms, and a failed push is not retried on a timer. Readers derive `stale` from push age on their own clock.
- Services bind loopback only (NFR-6); the only cross-host path is ssh plus loopback.
- Hermetic tests only: inject `sshImpl`, `fetchImpl`, `devicectl`, `hostKey`, clock, `launchctl`; no port bound, no live host or bucket.
- New hub code is Node 24 ESM `.mjs`.

## Technical Decisions

- Deploy path isolation (AD-25): `tools/ci/commands/*` and `tools/catchup/*` never import `claims.mjs`, `tools/registry/*`, `tools/hub-api/*`, `tools/host-agent/*` or `hub-client.mjs`, and never call a service; a conformance test asserts it.
- `hub-client.mjs` is the only cross-host transport (AD-26): `ssh -T -o BatchMode=yes -o ConnectTimeout=<api.peer_connect_timeout_s> -o ControlMaster=no -o ControlPath=none -o ServerAliveInterval=15 -o ServerAliveCountMax=2 <alias> <remote command>` through an `sshImpl` seam. The alias comes from the host key (`mac.host` from big-chungus, `linux.host` from the Mac). The remote command is `hub-client.mjs relay <method> <path>` from the peer's installed release with an absolute node path, every word single-quoted (the `catchup.mjs` escaping; both login shells are zsh). Never bare curl.
- Relay protocol: the JSON body is the first stdin line; `hub-client` then writes a newline every `api.stream_keepalive_s`; the relay aborts its loopback request on stdin EOF or 3 intervals with no byte, and writes status, headers and body back, parsed as a `fetch` response. ssh is killed at the call's bound plus 10 s. Same-host calls use `fetch` to loopback. A forwarded wait is one chain end to end: if the ssh leg dies, the far end sees a client disconnect and `lock.mjs` records `cancel`.
- `hub-client` call bound: the request's wait plus any provision budget plus 30 s, or 30 s otherwise (AD-48). The only timers allowed outside `lock.mjs` and `stream.mjs` are in `hub-client.mjs` (one stdin heartbeat per forwarded call, cleared with it); a conformance test finds no other `setInterval`.
- Host keys (AD-47): a Resource's `host` is `linux` or `mac`. `claims.mjs` `hostKey()` reads `~/.config/mobile-deploy-hub/host-key` behind a seam and checks it against `{linux: 'linux', mac: 'darwin'}`; a missing file or mismatch is `HUB_HOST_UNKNOWN`. "Local" means `record.host === hostKey()` and nothing else.
- Forwarding contract (AD-48): a forward is the public route plus header `X-Hub-Forwarded: <door>` and body key `resource: {id, lock, host, rev, retired_at}`. Both services serve the same Hold write routes. On big-chungus the receiver ignores the carried record and re-resolves `id` against `registry.json`. The Host Agent acts on carried `lock` and `host` and applies the retired check to the carried `retired_at`; `rev: 0` (seed fallback) is accepted only for a seeded Resource. Release, cancel and extend carry `resource`; a Pool cancel carries `pool` and the host key. `POST /leases` with a wait needs a client-minted id (`newLeaseId`); a repeat of the same `id` and `holder` never takes a second Lease (an already-held one returns the existing state with 200; a still-waiting one takes over, old connection gets `409 HUB_LEASE_SUPERSEDED`).
- Resolution off big-chungus (AD-32): only big-chungus reads `registry.json`. Elsewhere `hub-device` and the agent ask the Hub API through `hub-client`, and when it is unreachable resolve from the in-memory seed only (forward carries `rev: 0`). With the Hub API down, `hub-device` on big-chungus forwards to the Mac directly. The Mac's own `hub-device` acts in-process.
- Host Agent (AD-25, AD-35, AD-41): `tools/host-agent/server.mjs` binds `127.0.0.1:8795` only; `GET /health` returns `{ok, service, contract, hub_version, ports}` with no `registry`; `GET /status` is `statusView('mac', {audience: 'service', qa_ids})` rendered by the Mac; it serves `/leases...`, `/requests/<id>/cancel`, `/reservations/...` and `GET /leases/<id>` for its host only; `/registry/*` is 404. `qa_ids` come from its last Hub API answer or the in-memory seed. iPad Reachability uses `devicectl.mjs` and `pickIpad` only (read-only), on request only, mapped per the one Reachability enum (`reachable | unauthorized | offline | absent | unknown`; a disconnected tunnel is normal idle, not unreachable).
- Push (AD-49): exactly one message, `POST /agent/push`, body `{format: 1, host, host_id, boot, seq, sent_at, status, readings, events}`; in this epic `events` is `null` (the replica is filled by Epic 10). `seq` rises per `boot` and the Hub API ignores an already-applied `seq`. On apply, `/status.hosts.mac` is that status, Reachability readings update the cache, and a stream frame is scheduled within 2 s. The agent calls the Hub API only through `hub-client.mjs`; a conformance test finds no timer, `setInterval` or poll in the agent.
- Unreachable host (AD-35): a failed call (refused, timeout, ssh error) marks the host `unreachable` with `since`, every Resource on it reads `offline`, one `host-reachability` event `{host, from, to, reason}` is appended, and actions fail at once. No refresh is tried until a push arrives, a request must act on that host, or 5 x `registry.reachability_max_age_s` since failure, judged at request time, never by a timer. A successful push or call restores it with one event. `/status.hosts.mac` then shows the last view marked stale with `since`.
- Lifecycle (AD-45): the singleton is the port bind; `EADDRINUSE` exits `HUB_API_ALREADY_RUNNING`, exit 0 under launchd so `KeepAlive` does not respawn. LaunchAgent `sh.delo.mobile-deploy-hub.host-agent`: `KeepAlive: {SuccessfulExit: false}`, `RunAtLoad`, `LimitLoadToSessionType Aqua`, no `StartInterval`, logs at `~/Library/Logs/mobile-deploy-hub/host-agent.{out,err}.log`, runs from `releases/<ref>` with the install-time Node path, requires Node >= 24.15. `units/install.sh <ref>` Darwin branch renders it beside the untouched catch-up label and plist. `hosts:install` reads `/health` back from both services and fails on differing `contract` or `hub_version`, never deletes the release dir a running service uses, and services switch only at install.
- Policy (AD-46): `api: {hub_api_port: 8794, host_agent_port: 8795, stream_keepalive_s: 15, peer_connect_timeout_s: 5}` and `registry.reachability_max_age_s: 60`, parsed strictly; `stream_keepalive_s` above 30 is refused. Modules take `policy` as a seam; never read ports or limits from env.
- New error codes in play: `HUB_HOST_UNKNOWN` (exit 1), `HUB_API_ALREADY_RUNNING`, `HUB_LEASE_SUPERSEDED` (409, exit 1); away is 503 exit 75, busy 409 exit 76.

## Cross-Story Dependencies

- 9.1 (`hub-client.mjs`) is the foundation: 9.3, 9.4, 9.5 and 9.6 all call peers through it.
- 9.2 (Host Agent server) must exist before 9.3 can forward to it, 9.4 can lease through it, and 9.5 can push from it. 9.2's iPad mapping follows Story 5.4.
- 9.3 forwarding rules underpin 9.4 and rely on Story 7.2's repeat-request rules and the v1a Lease id format.
- 9.5 pushes feed 9.6 (restore on push) and Story 6.10's Reachability cache shape and Story 8.5's stream frames; `events: null` here is filled by Epic 10.
- 9.7 packages 9.2 and 9.5 as the LaunchAgent; 9.8 ships all of it (release, `hosts:install` on both hosts, live lease check, sleeping-Mac check).
- Unchanged systems: iOS deploy jobs and the iPad catch-up (v1a AD-22) must behave as before, including `HUB_MAC_BUSY` reported as success.
