import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Reading scripts off disk (docs/03 "Sources of truth").
 *
 * Hand scripts live in `packages/cards/scripts/<first letter>/<slug>.yaml`, one card per
 * file, because that is what a person maintains: a diff on one card is a diff on one
 * file, and the letter directories keep a few hundred of them navigable.
 *
 * Parsing stops at YAML here. Everything after — the schema, the loader's checks, the
 * validator — works on plain objects, so nothing else in the system knows or cares that
 * scripts are YAML rather than JSON.
 */

export const SCRIPTS_DIRECTORY = 'packages/cards/scripts';

export interface ScriptFile {
  /** Path as written, so an error message points at something a person can open. */
  readonly path: string;
  readonly content: unknown;
}

export const parseScript = (yaml: string): unknown => parse(yaml);

export const readScript = (path: string): ScriptFile => ({
  path,
  content: parseScript(readFileSync(path, 'utf8')),
});

/**
 * Every script under a directory, in a stable order, so a test that walks them reports
 * the same thing twice in a row.
 */
export const readScripts = (directory = SCRIPTS_DIRECTORY): readonly ScriptFile[] => {
  const files: string[] = [];

  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.yaml')) files.push(path);
    }
  };

  walk(directory);
  return files.map(readScript);
};
