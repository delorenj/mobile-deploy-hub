// `GET /utilisation`'s reader (Story 10.3, FR-18, AD-40, addendum B.7): how each Resource spent a window, folded from this host's Event Log and every
// peer host's replica. The pure half (the fold, the shares, the query check) is tools/registry/history.mjs; this file is the I/O and the cache.
//
// The cache is in memory only (never on disk, never a timer): one folded timeline per host source, with the `{month, offset}` its fold has reached.
// A request advances each host's timeline over only the bytes appended since that position (`openReader` from the stored position, so a chunk is
// 256 KiB and the event loop runs between two), and answers from the timelines. Only a position that vanished (the month file is gone or shorter:
// `bad-cursor`, `HUB_EVENT_OFFSET`) rebuilds that host from offset 0. Refreshes of one host are serialized, so two requests never fold the same
// bytes twice. Nothing here writes an event file or a replica: the only writes are the peer call's (the Story 9.6 mark) and the replica writer's.
import { eventDir } from '../ci/lib/events.mjs';
import { emulatorPool } from '../device/claims.mjs';
import { HOST_KEYS } from '../hub-client.mjs';
import { DEFAULT_MAX_AGE_S, createTimeline, foldEvent, lockToResource, mergeTimelines, parseUtilisationQuery, sharesOf } from '../registry/history.mjs';
import { abortError, coverPeers, openReader } from './history.mjs';
import { replicaDir } from './replica.mjs';

const oneLine = value => String(value?.message ?? value).replace(/\s+/g, ' ').trim();
const iso = ms => new Date(ms).toISOString();

// The state `/utilisation` keeps for as long as the service runs: `sources` maps a host key to `{position, timeline}` (the point the fold has reached,
// `{month, offset}` or null for a host with no log, and what it folded); `chains` maps a host key to the promise of its last refresh, which the next
// one waits for. Nothing of it is on disk.
export const createUtilisation = () => ({ sources: new Map(), chains: new Map() });

const vanished = error => error?.reason === 'bad-cursor' || error?.code === 'HUB_EVENT_OFFSET';

async function advance({ cache, host, root, env, hostId, log, chunkBytes }) {
  let source = cache.sources.get(host);
  for (;;) {
    const timeline = source === undefined ? createTimeline() : source.timeline;
    try {
      const reader = openReader({
        host, root, env, start: source?.position ?? null, accept: () => true, log,
        ...(hostId === undefined ? {} : { hostId }), ...(chunkBytes === undefined ? {} : { chunkBytes }),
      });
      for (let entry = await reader.peek(); entry !== null; entry = await reader.peek()) foldEvent(timeline, reader.take().event);
      const next = { position: reader.position(), timeline };
      cache.sources.set(host, next);
      return next;
    } catch (error) {
      // The stored position is gone (the file shrank or went away): fold that host again from the start. Anything else leaves a fold that is
      // part way through its bytes, which the stored position cannot describe, so the host is forgotten and the next request rebuilds it.
      cache.sources.delete(host);
      if (source !== undefined && vanished(error)) { source = undefined; continue; }
      throw error;
    }
  }
}

// One host's timeline, advanced to the end of its log as of now. Serialized per host: a refresh starts when the previous one is done.
export function refreshSource({ cache, host, root, env = process.env, hostId, log = () => {}, chunkBytes }) {
  const previous = cache.chains.get(host) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => advance({ cache, host, root, env, hostId, log, chunkBytes }));
  cache.chains.set(host, run);
  return run;
}

// The whole of `GET /utilisation`: the checked query (400 HUB_USAGE, nothing read), the peers' coverage (the same step `/history` takes: a sync for a
// peer whose replica may lack the window, `synced_through`, `partial`), each host's timeline advanced from its cached position, and the shares.
// `registry` is a function (read only for a query that passed the check); `poolSize` the emulator Pool's size on this host (a throw falls back to the
// slots the log shows, with one `HUB_API_UTILISATION_POOL` line). Answers `Utilisation`.
export async function queryUtilisation({
  query: params, own, env = process.env, registry, hostId, now = Date.now, signal, peers, replicas, history, transport, contact = () => {}, failure = () => {}, log = () => {},
  policy, cache, poolSize = () => emulatorPool(env, { service: true }),
}) {
  const at = now();
  const query = parseUtilisationQuery(params, { at });
  const { through, partial } = await coverPeers({ own, env, windowEnd: query.to, at, peers, replicas, history, transport, now, signal, contact, failure, log });
  if (signal?.aborted === true) throw abortError(signal);
  const records = registry();
  const sources = await Promise.all(HOST_KEYS.map(host => refreshSource({ cache, host, root: host === own ? eventDir(env) : replicaDir(env, host), env, hostId: host === own ? hostId : undefined, log })));
  if (signal?.aborted === true) throw abortError(signal);

  let size = 0;
  try { size = poolSize(); } catch (error) {
    try { log(`HUB_API_UTILISATION_POOL ${oneLine(error)}`); } catch { /* a broken log never changes an answer */ }
  }
  const slots = Array.from({ length: Number.isSafeInteger(size) && size > 0 ? size : 0 }, (_, index) => `emulator-${index + 1}`);
  const shares = sharesOf(mergeTimelines(sources.map(source => source.timeline)), records, lockToResource(records), { from: query.from, to: query.to }, {
    maxAgeS: policy?.registry?.reachability_max_age_s ?? DEFAULT_MAX_AGE_S, syncedThrough: through, slots,
  });
  return {
    format: 1,
    from: iso(query.from),
    to: iso(query.to),
    window_ms: shares.window_ms,
    resources: shares.resources,
    slots: shares.slots,
    partial,
    synced_through: Object.fromEntries(HOST_KEYS.map(host => [host, through[host] === null || through[host] === undefined ? null : iso(through[host])])),
    checked_at: iso(at),
  };
}
