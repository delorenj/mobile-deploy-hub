// What the Host Agent knows of the Registry (Story 9.2, AD-32, AD-41): only the Hub API on big-chungus reads `registry.json`, so an agent
// keeps the last answer the Hub API gave it (`GET /resources`), or else the in-memory seed of devices.json (the QA file included), and
// answers its status' `qa_ids`, its fleet and its host gate from that. It never reads the Registry file.
//
// The seed is always the source of the Pools and of every Resource's `words` (the served record has no `words`), so a word like `ipad`
// resolves with the Hub API down. `refresh` is one request, made by the server once after its bind: a failure is one line on stderr and
// the seed keeps answering. Nothing here schedules anything: no retry, no poll.
import { loadDevices } from '../ci/lib/devices.mjs';
import { dedicatedQaIds, loadQaDevices, seed } from '../registry/seed.mjs';

const oneLine = value => String(value?.message ?? value).replace(/\s+/g, ' ').trim();

// `createKnown({env, devices, qaDevices, log})` -> `{note, current, qaIds, refresh}`.
//   note(answer)        keeps a Hub API `GET /resources` answer (`{rev, source, resources}`); anything else is ignored.
//   current()           `{resources, pools, words}`: the noted answer's Resources, else the seed's; `pools` (the seed's, by name) and
//                       `words` (`[{id, words}]` of the seed's Resources that have any) always from the seed.
//   qaIds()             the ids of the current Resources marked `dedicated_qa`.
//   refresh({request})  one `GET /resources` through `request({host: 'linux', method, path})` (tools/hub-client.mjs `request`); resolves
//                       true when an answer was noted. It never rejects: a failure is one `HUB_AGENT_REGISTRY_FAILED <message>` line.
export function createKnown({ env = process.env, devices, qaDevices, log = {} } = {}) {
  let seeded = null;
  let answer = null;
  const say = line => { try { log.err?.(line); } catch { /* a broken log seam never changes an answer */ } };
  const seedOf = () => {
    if (seeded !== null) return seeded;
    const given = devices ?? loadDevices(env);
    try {
      seeded = seed(given, { qaDevices: qaDevices ?? (() => loadQaDevices({ env })) });
    } catch (error) {
      // A broken QA file is the seed's, not the host's: the agent still answers, with no dedicated phone marked.
      say(`HUB_AGENT_REGISTRY_FAILED the QA devices could not be read: ${oneLine(error)}`);
      seeded = seed(given, { qaDevices: () => [] });
    }
    return seeded;
  };
  const known = {
    note(given) {
      if (given !== null && typeof given === 'object' && Array.isArray(given.resources)) answer = given;
    },
    current() {
      const base = seedOf();
      return {
        resources: answer?.resources ?? base.resources,
        pools: base.pools,
        words: base.resources.filter(resource => Array.isArray(resource.words) && resource.words.length > 0).map(resource => ({ id: resource.id, words: [...resource.words] })),
      };
    },
    qaIds: () => dedicatedQaIds(known.current().resources),
    async refresh({ request } = {}) {
      try {
        const response = await request({ host: 'linux', method: 'GET', path: '/resources' });
        if (!response?.ok) throw new Error(`the Hub API answered ${response?.status ?? 'nothing'}`);
        const body = await response.json();
        if (!Array.isArray(body?.resources)) throw new Error('the Hub API answer has no resources');
        known.note(body);
        return true;
      } catch (error) {
        say(`HUB_AGENT_REGISTRY_FAILED ${oneLine(error)}`);
        return false;
      }
    },
  };
  return known;
}
