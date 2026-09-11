import type { CardDefinition } from '@mtg/engine';
import { describe, expect, it } from 'vitest';
import { runScenarioTests } from '../src/scenarioTests.js';
import { loadHandScriptFiles } from '../src/scripts.js';
import { CardDatabase, type ScryfallCard } from '../src/scryfall.js';
import { validateScript } from '../src/validate.js';
import fixture from './fixtures/scryfall-subset.json' with { type: 'json' };

const db = new CardDatabase(fixture as ScryfallCard[]);
const files = loadHandScriptFiles();

/**
 * Every hand script must validate as `supported` against its Scryfall entry (schema, characteristic agreement,
 * full text coverage, executability), and its YAML `tests:` must pass with the whole bootstrap set available.
 */
describe('bootstrap hand scripts', () => {
  const results = files.map((f) => {
    const card = f.oracleId ? db.get(f.oracleId) : undefined;
    return { file: f, card, result: card ? validateScript(f.raw, card) : null };
  });
  const definitions: Record<string, CardDefinition> = {};
  for (const r of results)
    if (r.result?.definition) definitions[r.result.definition.id] = r.result.definition;

  it('has a Scryfall fixture entry for every script', () => {
    const missing = results.filter((r) => !r.card).map((r) => r.file.path);
    expect(missing).toEqual([]);
  });

  for (const r of results) {
    const name = r.file.name ?? r.file.path;
    describe(name, () => {
      it('is supported', () => {
        if (!r.result) return;
        const detail =
          r.result.status === 'supported'
            ? ''
            : `\n${r.result.reasons.join('\n')}\nsentences:\n${r.result.sentences.map((s, i) => `  ${i}: ${s}`).join('\n')}`;
        expect(`${r.result.status}${detail}`).toBe('supported');
      });
      const tests = r.result?.script?.tests ?? [];
      for (const t of tests) {
        it(t.name, () => {
          if (!r.result?.definition) return;
          const failures = runScenarioTests(r.result.definition, [t], definitions);
          expect(failures.map((f) => f.message)).toEqual([]);
        });
      }
    });
  }

  it('covers at least 80 cards', () => {
    expect(files.length).toBeGreaterThanOrEqual(80);
  });
});
