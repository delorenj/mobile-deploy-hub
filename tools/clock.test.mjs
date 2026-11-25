// Story 6.4 (AD-19, the no-new-clock rule): recurring work belongs to a candybar, not to a timer in the hub's code. Three checks over the
// non-test .mjs files under tools/:
//   1. `setInterval` appears only in CLOCK_FILES (today the lock heartbeat; the stream's keepalive and the hub client's wait are the
//      other two files the rule names, not yet written).
//   2. `setTimeout` appears in tools/hub-api/, tools/host-agent/ and tools/hub-client.mjs only in CLOCK_FILES.
//   3. No function reschedules itself with `setTimeout` (a named function whose own body passes itself to it): that is a hand-made
//      interval. This one applies to every file, CLOCK_FILES included.
// The detectors are exported and proven on synthetic samples below, so a regex that stops matching fails here and not silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLOCK_FILES = Object.freeze(['tools/ci/lib/lock.mjs', 'tools/hub-api/stream.mjs', 'tools/hub-client.mjs']);
export const SERVICE_SCOPES = Object.freeze(['tools/hub-api/', 'tools/host-agent/', 'tools/hub-client.mjs']);

const root = fileURLToPath(new URL('../', import.meta.url));

// The source with comments and the contents of string and template literals blanked (same length), so a word in a comment or a message
// is never a hit and braces inside a string never unbalance a body. A `${...}` inside a template is blanked with the rest of it.
export function strip(source) {
  let out = '';
  for (let index = 0; index < source.length;) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') { out += ' '; index += 1; }
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(index, stop).replace(/[^\n]/g, ' ');
      index = stop;
    } else if (char === '"' || char === "'" || char === '`') {
      out += char;
      index += 1;
      while (index < source.length && source[index] !== char) {
        if (source[index] === '\\') { out += ' '; index += 1; }
        out += source[index] === '\n' ? '\n' : ' ';
        index += 1;
      }
      out += char;
      index += 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

const uses = (source, name) => new RegExp(`\\b${name}\\b`).test(strip(source));
export const usesSetInterval = source => uses(source, 'setInterval');
export const usesSetTimeout = source => uses(source, 'setTimeout');

// Index just past the balanced group that opens at `open` (a `(`, `{` or `[`), in already-stripped source.
function closeOf(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if ('({['.includes(text[index])) depth += 1;
    else if (')}]'.includes(text[index])) { depth -= 1; if (depth === 0) return index + 1; }
  }
  return text.length;
}

// The end of an arrow function's expression body that starts at `from`: the first `;` or newline-after-complete-expression at depth 0.
function expressionEnd(text, from) {
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if ('({['.includes(char)) depth += 1;
    else if (')}]'.includes(char)) { if (depth === 0) return index; depth -= 1; }
    else if (depth === 0 && (char === ';' || char === ',')) return index;
  }
  return text.length;
}

// The named functions of a source with their body text: `function NAME(...) {...}` and `const NAME = [async] function (...) {...}`,
// `(...) => {...}`, `x => {...}` or `x => expression`. A method in a class or object literal is not a named function here.
export function namedFunctions(source) {
  const text = strip(source);
  const found = [];
  for (const match of text.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const bodyStart = text.indexOf('{', closeOf(text, open));
    if (bodyStart !== -1) found.push({ name: match[1], body: text.slice(bodyStart, closeOf(text, bodyStart)) });
  }
  for (const match of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b[^({]*\([^)]*\)\s*(\{)|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(\{)?)/g)) {
    const start = match.index + match[0].length;
    if (match[2] || match[3]) found.push({ name: match[1], body: text.slice(start - 1, closeOf(text, start - 1)) });
    else found.push({ name: match[1], body: text.slice(start, expressionEnd(text, start)) });
  }
  return found;
}

// The names of the functions whose own body hands the function itself (by name, or a call to it inside a callback) to setTimeout.
export function selfRescheduling(source) {
  const hits = [];
  for (const { name, body } of namedFunctions(source)) {
    for (const call of body.matchAll(/\bsetTimeout\s*\(/g)) {
      const open = call.index + call[0].length - 1;
      const argument = body.slice(open, closeOf(body, open));
      if (new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}\\b`).test(argument.slice(1))) { hits.push(name); break; }
    }
  }
  return hits;
}

function files(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(path));
    else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) out.push(path);
  }
  return out;
}
const sources = files(join(root, 'tools')).map(path => ({ rel: relative(root, path).split('\\').join('/'), source: readFileSync(path, 'utf8') }));
const inScope = rel => SERVICE_SCOPES.some(scope => (scope.endsWith('/') ? rel.startsWith(scope) : rel === scope));

test('the scan sees the hub tools, and CLOCK_FILES is the named three', () => {
  assert.deepEqual([...CLOCK_FILES], ['tools/ci/lib/lock.mjs', 'tools/hub-api/stream.mjs', 'tools/hub-client.mjs']);
  assert.ok(sources.length > 20);
  assert.ok(sources.some(({ rel }) => rel === 'tools/hub-api/server.mjs'));
  assert.ok(sources.some(({ rel, source }) => rel === 'tools/ci/lib/lock.mjs' && usesSetInterval(source)), 'the heartbeat is still there, and still found');
});

test('no setInterval in a non-test tools/**/*.mjs outside CLOCK_FILES', () => {
  assert.deepEqual(sources.filter(({ rel, source }) => !CLOCK_FILES.includes(rel) && usesSetInterval(source)).map(({ rel }) => rel), []);
});

test('no setTimeout in tools/hub-api/, tools/host-agent/ or tools/hub-client.mjs outside CLOCK_FILES', () => {
  assert.deepEqual(sources.filter(({ rel, source }) => inScope(rel) && !CLOCK_FILES.includes(rel) && usesSetTimeout(source)).map(({ rel }) => rel), []);
});

test('no function under tools/ reschedules itself with setTimeout', () => {
  assert.deepEqual(sources.map(({ rel, source }) => [rel, selfRescheduling(source)]).filter(([, names]) => names.length > 0), []);
});

test('the setInterval and setTimeout detectors match real uses and ignore comments and strings', () => {
  assert.equal(usesSetInterval('const t = setInterval(tick, 1000);'), true);
  assert.equal(usesSetInterval('timer = timers.setInterval(touch, ALIVE_MS);'), true);
  assert.equal(usesSetInterval('timers = { setInterval, clearInterval },'), true);
  assert.equal(usesSetInterval('// no setInterval here\nconst a = 1;'), false);
  assert.equal(usesSetInterval('/* setInterval */ const a = "setInterval";'), false);
  assert.equal(usesSetInterval('const a = `setInterval ${1}`;'), false);
  assert.equal(usesSetTimeout('await new Promise(r => setTimeout(r, 5));'), true);
  assert.equal(usesSetTimeout('// setTimeout\n'), false);
  assert.equal(usesSetTimeout('const message = "setTimeout";'), false);
});

test('the self-rescheduling detector flags a hand-made interval and passes ordinary timers', () => {
  const positive = {
    'a function declaration': 'function tick() { work(); setTimeout(tick, 1000); }',
    'an async declaration': 'async function poll() { await work(); setTimeout(poll, 50); }',
    'a callback that calls it': 'function poll() { setTimeout(() => { poll(); }, 50); }',
    'an arrow in a const': 'const loop = () => { run(); setTimeout(loop, 10); };',
    'an async arrow in a const': 'const loop = async () => { await run(); setTimeout(() => loop(), 10); };',
    'an arrow expression body': 'const loop = () => setTimeout(loop, 10);',
    'a function expression': 'const again = function () { setTimeout(again, 10); };',
    'with a dollar name': 'function $tick() { setTimeout($tick, 10); }',
    'after other statements': 'const a = 1;\nfunction next() {\n  if (a) { return; }\n  setTimeout(next, 1);\n}\n',
  };
  for (const [name, source] of Object.entries(positive)) assert.deepEqual(selfRescheduling(source).length > 0, true, name);
  const negative = {
    'a sleep helper': 'const sleep = ms => new Promise(r => setTimeout(r, ms));',
    'a sleep function': 'function sleep(ms) { return new Promise(done => setTimeout(done, ms)); }',
    'a one-shot kill timer': 'function stop() { child.kill(); setTimeout(() => child.kill("SIGKILL"), 1000).unref(); }',
    'a timeout that calls another function': 'function a() { setTimeout(() => b(), 1); }\nfunction b() { a2(); }',
    'a name only in a comment': 'function tick() { /* setTimeout(tick, 1) */ work(); }',
    'a name only in a string': 'function tick() { log("setTimeout(tick, 1)"); }',
    'a longer name': 'function tick() { setTimeout(ticker, 1); }',
    'a property of the same name': 'function tick() { setTimeout(obj.tick, 1); }',
    'two functions': 'const a = () => { setTimeout(done, 1); };\nconst done = () => {};',
  };
  for (const [name, source] of Object.entries(negative)) assert.deepEqual(selfRescheduling(source), [], name);
});
