// The caller check (design v1.1, A3). Each app's .github/workflows/deploy.yml must be the hub's templates/deploy.yml:
// the gate normalizes the file the run was started from and looks its sha256 up in policy.callers.accept. That one
// check refuses strict: false, another manifest, other runner labels (hosted ones too), a run-name without REAL, a
// re-pin to @main or an old tag, narrowed permissions and `on: push`, because each changes the normalized text.
//
// Normalizing: LF line endings, comment lines, blank lines and trailing spaces removed, one space after each `:` that
// is followed by whitespace (`://` stays as it is). Comments are the only part an app may make its own.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const templateFile = fileURLToPath(new URL('../../../templates/deploy.yml', import.meta.url));

export function normalizeCaller(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .filter(line => line.trim() !== '' && !line.trimStart().startsWith('#'))
    .map(line => line.replace(/:[ \t]+/g, ': '))
    .join('\n') + '\n';
}

export const callerHash = text => createHash('sha256').update(normalizeCaller(text)).digest('hex');

export const refusal = (what, detail) => Object.assign(new Error(`HUB_GATE_REFUSED ${what}: ${detail}`), { refused: what });

// The first line where a caller departs from the current template, so the refusal says what to fix.
export function firstDifference(caller, template) {
  const a = normalizeCaller(caller).split('\n');
  const b = normalizeCaller(template).split('\n');
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return { line: index + 1, caller: a[index] ?? '(end of file)', template: b[index] ?? '(end of file)' };
  }
  return null;
}

// GITHUB_WORKFLOW_REF names the caller in a reusable workflow: <owner>/<repo>/<path>@<ref>.
export function checkCaller({ policy, env, read, template = () => readFileSync(templateFile, 'utf8') }) {
  const repo = env.GITHUB_REPOSITORY ?? '';
  const ref = env.GITHUB_WORKFLOW_REF ?? '';
  const expected = `${repo}/${policy.callers.workflow}@`;
  if (!repo || !ref.startsWith(expected)) throw refusal('caller', `this run was started by ${ref || 'an unknown workflow'}; only ${expected}<ref> may call the hub`);
  let text;
  try { text = read(policy.callers.workflow); } catch (error) { throw refusal('caller', `cannot read ${policy.callers.workflow} at the dispatched commit (${error.code ?? error.message})`); }
  const hash = callerHash(text);
  if (!policy.callers.accept.includes(hash)) {
    let hint = '';
    try {
      const diff = firstDifference(text, template());
      if (diff) hint = ` First difference from templates/deploy.yml (normalized line ${diff.line}): caller "${diff.caller.trim().slice(0, 120)}", template "${diff.template.trim().slice(0, 120)}".`;
    } catch { /* the hash is the verdict; the hint is a courtesy */ }
    throw refusal('caller', `${policy.callers.workflow} (sha256 ${hash.slice(0, 12)} normalized) is not an accepted copy of the hub's templates/deploy.yml: a caller pins @v1, passes strict, runners and the manifest unchanged, keeps REAL in its run-name and its permissions, and runs on workflow_dispatch only.${hint}`);
  }
  return { hash, ref: ref.slice(expected.length) };
}
