import { describe, expect, it } from 'vitest';
import manifest from '../package.json' with { type: 'json' };

/**
 * The engine is meant to stay dependency-free and environment-free (docs/01): pure
 * TypeScript with no Node or DOM APIs, so it can run in a worker, in a browser, or in a
 * test with nothing else present. Two things protect that. The tsup build uses
 * `platform: 'neutral'`, which rejects Node builtins, and the package's `types: []`
 * means Node's globals are not even in scope — which is why this test reads the manifest
 * through a JSON import rather than `node:fs`.
 */
describe('the engine package', () => {
  it('depends only on other workspace packages', () => {
    const dependencies: Record<string, string> = manifest.dependencies ?? {};
    const offenders = Object.entries(dependencies)
      .filter(([name, range]) => !name.startsWith('@mtg/') || !range.startsWith('workspace:'))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it('has at least one dependency, so the check is not vacuous', () => {
    expect(Object.keys(manifest.dependencies ?? {}).length).toBeGreaterThan(0);
  });
});
