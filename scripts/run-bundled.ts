/**
 * Run a script on the code as it ships, not as `tsx` runs it (roadmap 4.8).
 *
 * `tsx` compiles with esbuild's `keepNames`, which wraps every function it defines in a
 * call that names it — once per module for a top-level function, but once per *call* for
 * a closure made inside a hot loop. The engine and the agents make a great many of those,
 * and under `tsx` they read about a fifth slower than the same code built by tsup, which
 * does not keep names. That fifth is not engine time, and it was in every number the
 * benchmarks reported until 4.8.
 *
 * So this bundles a script with esbuild as tsup would — no `keepNames`, everything inlined
 * — and runs the bundle with plain node, passing the rest of the arguments on. The
 * benchmarks run through it because they time the code; the ladder and the tuning harness
 * because they play thousands of games, and a fifth of that is minutes.
 *
 * Usage:
 *   tsx scripts/run-bundled.ts <script.ts> [its arguments]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const [entry, ...args] = process.argv.slice(2);
if (entry === undefined) {
  console.error('usage: tsx scripts/run-bundled.ts <script.ts> [arguments]');
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'node_modules', '.cache', 'bundled');
mkdirSync(outDir, { recursive: true });
const source = resolve(entry);
const outfile = join(
  outDir,
  `${basename(dirname(dirname(source)))}-${basename(source, '.ts')}.cjs`,
);

await build({
  entryPoints: [source],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  keepNames: false,
  logLevel: 'warning',
});

const run = spawnSync(process.execPath, [outfile, ...args], { stdio: 'inherit' });
process.exit(run.status ?? 1);
