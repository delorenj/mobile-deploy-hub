// Fallback exporter for an app with no export hook: headless import, then a release export of one preset.
// The engine comes from GODOT_BIN. A script error in the log fails the export even when Godot exits 0.
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export function godotEngine(env = process.env) {
  if (!env.GODOT_BIN) throw new Error('GODOT_BIN must name the Godot binary for an app with no export hook');
  return env.GODOT_BIN;
}

export function scriptErrors(log) {
  return /SCRIPT ERROR|Parse Error/.test(log);
}

export async function exportGodot({ project, preset, output, log, env = process.env }) {
  const engine = godotEngine(env);
  const target = resolve(output);
  const logFile = resolve(log ?? join(dirname(target), 'godot.log'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(logFile, '');
  for (const args of [['--headless', '--path', project, '--editor', '--import', '--quit'], ['--headless', '--path', project, '--export-release', preset, target]]) {
    const result = spawnSync(engine, args, { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    await appendFile(logFile, text);
    if (result.error || result.status !== 0) throw new Error(`godot ${args[3]} failed (${result.error?.message ?? `exit ${result.status}`}); log ${logFile}\n${text.slice(-4000)}`);
  }
  if (scriptErrors(await readFile(logFile, 'utf8'))) throw new Error(`Godot reported script errors; see ${logFile}`);
  return target;
}
