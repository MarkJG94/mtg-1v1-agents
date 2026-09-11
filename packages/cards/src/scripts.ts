import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export interface HandScriptFile {
  path: string;
  raw: unknown;
  oracleId: string | null;
  name: string | null;
}

/** Directory of the bootstrap hand scripts (`packages/cards/scripts/<letter>/<slug>.yaml`). */
export const HAND_SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.yaml') || entry.endsWith('.yml')) out.push(full);
  }
}

/** Reads every YAML hand script under `dir` without validating it. */
export function loadHandScriptFiles(dir = HAND_SCRIPTS_DIR): HandScriptFile[] {
  const files: string[] = [];
  walk(dir, files);
  files.sort();
  return files.map((path) => {
    const raw = parseYaml(readFileSync(path, 'utf8')) as unknown;
    const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    return {
      path,
      raw,
      oracleId: typeof rec.oracleId === 'string' ? rec.oracleId : null,
      name: typeof rec.name === 'string' ? rec.name : null,
    };
  });
}

/** Hand scripts keyed by oracle id, as the resolver expects. Duplicate ids are an error. */
export function handScriptsByOracleId(
  files: HandScriptFile[] = loadHandScriptFiles(),
): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const f of files) {
    if (!f.oracleId) throw new Error(`${f.path}: missing oracleId`);
    if (out.has(f.oracleId)) throw new Error(`${f.path}: duplicate oracleId ${f.oracleId}`);
    out.set(f.oracleId, f.raw);
  }
  return out;
}
