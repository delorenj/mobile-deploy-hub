// Source scanning shared by the conformance tests (tools/clock.test.mjs, tools/hub-api/event-loop.test.mjs). Not a test file: importing it registers nothing.

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
