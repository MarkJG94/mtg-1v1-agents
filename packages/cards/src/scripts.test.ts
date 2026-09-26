import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readScripts } from './files.js';
import type { CardProjection } from './scryfall.js';
import { validateScript } from './validate.js';

/**
 * Every hand script, validated (docs/09 "Card tests").
 *
 * This is the test that keeps the bootstrap set honest: a script that stops agreeing with
 * its printed card, or stops being playable because the engine changed underneath it,
 * fails here rather than in a game a thousand cycles into a run.
 *
 * The printed cards come from a committed fixture rather than the network, because CI has
 * no network and the bulk file is 500 MB. `pnpm cards:new` writes both halves at once, so
 * a script and the card it was written against arrive together.
 */

// Resolved against this file rather than the working directory: the suite runs both from
// the package and from the repository root, and those are different places.
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const fixture = JSON.parse(readFileSync(here('../fixtures/scryfall.json'), 'utf8')) as Record<
  string,
  CardProjection
>;

const scripts = readScripts(here('../scripts'));

/**
 * Scripts that do less than the card says, on purpose, with the reason. These are
 * `partial`: they are never played, and they are here because leaving the card out
 * entirely would hide what the engine cannot do yet.
 */
const knownPartial: Readonly<Record<string, string>> = {
  'Wrath of God': '"They can\'t be regenerated" has no op yet',
  'Swords to Plowshares': "life equal to the exiled creature's power needs last known information",
  'Turn to Frog': 'the creature-type change needs a layer 4 the engine has not got',
};

describe('the bootstrap card scripts', () => {
  it('has scripts to validate', () => {
    expect(scripts.length).toBeGreaterThan(40);
  });

  it.each(scripts.map((script) => [script.path, script] as const))('%s', (_path, script) => {
    const oracleId = (script.content as { oracleId?: string }).oracleId ?? '';
    const card = fixture[oracleId];
    expect(card, `no printed card in the fixture for ${oracleId}`).toBeDefined();
    if (card === undefined) return;

    const result = validateScript(script.content, card);
    const expected = card.name in knownPartial ? 'partial' : 'supported';

    expect(
      result.status,
      `${card.name}: ${result.reasons.map((reason) => `[${reason.check}] ${reason.message}`).join('; ')}`,
    ).toBe(expected);
  });
});
