import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The import boundary (docs/04, docs/09 "Agent tests", roadmap 4.1).
 *
 * The agent must not be able to see the opponent's hand. That cannot be checked by
 * playing games, because an agent that cheats does not fail — it wins, quietly, for as
 * long as nobody looks. So it is checked structurally: the package may import the view
 * and nothing else that could reach a `GameState`.
 *
 * Two halves, and both are needed.
 *
 * 1. **Nothing here imports `@mtg/engine`.** That entry point exports `GameState` and
 *    every function that reads one.
 * 2. **`@mtg/engine/view` cannot reach a `GameState` either**, or the first half would be
 *    a naming convention. The second test walks that entry point's real module graph —
 *    following value imports and skipping `import type`, which is erased — and asserts
 *    `state/game-state.ts` is not in it.
 */

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * What an agent may import.
 *
 * `@mtg/engine/view` is the view, the decision vocabulary and the RNG interface — the
 * three things an agent genuinely needs. `@mtg/shared` is ids, zones, colours, steps and
 * run settings: there is no game state in it and nothing that could read one, and an
 * agent needs `PlayerId` and `AgentLevel` from it.
 *
 * `@mtg/engine` is the one that matters, and it is not here.
 */
const allowed: ReadonlySet<string> = new Set(['@mtg/engine/view', '@mtg/shared']);

/** Packages a test file may reach for that production code may not. */
const allowedInTests: ReadonlySet<string> = new Set(['vitest', 'node:fs', 'node:path', 'node:url']);

const sourceFiles = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });

/**
 * Every module specifier a file imports from, type-only imports included.
 *
 * A type-only import of `GameState` cannot read anything at run time, but it is still a
 * reach across the boundary and the next edit is the one that drops the `type`. The rule
 * is about what the package is allowed to know about, so both count.
 */
const importsOf = (source: string): readonly string[] =>
  [
    ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((match) => match[1] ?? '');

const root = here('.');

describe('what the agents package is allowed to import', () => {
  const files = sourceFiles(root);

  it('finds the package, so the check is not vacuous', () => {
    expect(files.length).toBeGreaterThan(0);
    const specifiers = files.flatMap((file) => importsOf(readFileSync(file, 'utf8')));
    expect(specifiers).toContain('@mtg/engine/view');
  });

  it('never imports @mtg/engine, which is where a GameState lives', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const testing = file.endsWith('.test.ts');
      for (const specifier of importsOf(readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('.')) {
          // A relative import that climbs out of this package is the same escape by
          // another route: `../../engine/src/state/game-state.js` reaches everything.
          const target = resolve(file, '..', specifier);
          if (relative(root, target).startsWith('..')) {
            offenders.push(`${relative(root, file)} → ${specifier}`);
          }
          continue;
        }
        if (allowed.has(specifier)) continue;
        if (testing && allowedInTests.has(specifier)) continue;
        offenders.push(`${relative(root, file)} → ${specifier}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('what the view entry point can reach', () => {
  const engineSrc = here('../../engine/src');

  /** Modules reachable from `entry` by imports that survive to run time. */
  const runtimeGraph = (entry: string): ReadonlySet<string> => {
    const seen = new Set<string>();
    const queue = [entry];

    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || seen.has(file)) continue;
      seen.add(file);

      const source = readFileSync(file, 'utf8');
      // `import type { … } from` and `export type { … } from` are erased by the compiler,
      // so they cannot carry a capability. Everything else can.
      const runtime = source
        .split('\n')
        .filter((line) => !/^\s*(?:import|export)\s+type\b/.test(line))
        .join('\n');

      for (const specifier of importsOf(runtime)) {
        if (!specifier.startsWith('.')) continue;
        queue.push(resolve(file, '..', specifier.replace(/\.js$/, '.ts')));
      }
    }
    return seen;
  };

  it('cannot reach the game state at run time', () => {
    const graph = runtimeGraph(join(engineSrc, 'view/index.ts'));
    const reached = [...graph].map((file) => relative(engineSrc, file)).sort();

    expect(reached).not.toContain('state/game-state.ts');
    expect(reached).not.toContain('view/project.ts');
  });

  it('and the walker is not simply failing to find anything', () => {
    // The same walk from the engine's own entry point must reach the state, or the test
    // above would pass on a graph builder that returned nothing.
    const graph = runtimeGraph(join(engineSrc, 'index.ts'));
    const reached = [...graph].map((file) => relative(engineSrc, file));

    expect(reached).toContain('state/game-state.ts');
    expect(graph.size).toBeGreaterThan(10);
  });
});
