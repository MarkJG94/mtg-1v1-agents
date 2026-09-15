import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readScripts } from './files.js';
import { loadCardScript } from './load.js';
import { runScenarioTest } from './scenario-tests.js';
import { cardScriptSchema } from './schema.js';
import type { CardProjection } from './scryfall.js';

/**
 * Every bootstrap card's own scenario tests (docs/09 "Card tests").
 *
 * docs/09's definition of done for a hand script is that at least one scenario test
 * exists, so this also checks that every script has one: a card nobody has written a test
 * for is a card nobody has checked does what it says.
 */

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const fixture = JSON.parse(readFileSync(here('../fixtures/scryfall.json'), 'utf8')) as Record<
  string,
  CardProjection
>;
const scripts = readScripts(here('../scripts'));

const parsed = scripts.map((file) => ({
  path: file.path,
  script: cardScriptSchema.parse(file.content),
  definition: loadCardScript(file.content),
}));

describe('every card has a test of its own', () => {
  it.each(parsed.map((card) => [card.definition.name, card] as const))('%s', (_name, card) => {
    expect(
      card.script.tests.length,
      `${card.definition.name} has no scenario test; docs/09 asks for at least one`,
    ).toBeGreaterThan(0);
  });
});

describe('and it does what it says', () => {
  const cases = parsed.flatMap((card) =>
    card.script.tests.map((test) => [`${card.definition.name}: ${test.name}`, card, test] as const),
  );

  it.each(cases)('%s', (_name, card, test) => {
    expect(runScenarioTest(card.definition, test).join('; ')).toBe('');
  });
});

describe('the fixture', () => {
  it('has the printed card behind every script', () => {
    for (const card of parsed) {
      expect(fixture[card.script.oracleId], `${card.definition.name}`).toBeDefined();
    }
  });
});
