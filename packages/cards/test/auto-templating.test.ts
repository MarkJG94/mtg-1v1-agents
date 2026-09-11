import { describe, expect, it } from 'vitest';
import { scriptCard } from '../src/auto/index.js';
import { normalizeOracleText, replaceSelfReferences } from '../src/normalize.js';
import { parseTypeLine, type ScryfallCard } from '../src/scryfall.js';
import { validateScript } from '../src/validate.js';
import corpus from './fixtures/auto-corpus.json' with { type: 'json' };
import bootstrap from './fixtures/scryfall-subset.json' with { type: 'json' };

/** The noun Scryfall's current templating uses in place of a card's own name, by card type. */
function selfNoun(card: ScryfallCard): string {
  const { types } = parseTypeLine(card.type_line);
  if (types.includes('creature')) return 'this creature';
  if (types.includes('land')) return 'this land';
  if (types.includes('artifact')) return 'this artifact';
  if (types.includes('enchantment')) return 'this enchantment';
  return 'this spell';
}

/** Rewrites a fixture entry into the templating Scryfall now ships, leaving everything else alone. */
function modernise(card: ScryfallCard): ScryfallCard {
  if (!card.oracle_text) return card;
  const noun = selfNoun(card);
  const text = card.oracle_text
    .split(card.name)
    .join(noun)
    .replace(/^this /, noun.startsWith('this') ? 'This ' : 'this ');
  return {
    ...card,
    oracle_text: text.replace(/(^|\n|\. )this /g, (m) => m.replace('this ', 'This ')),
  };
}

describe('replaceSelfReferences', () => {
  it('folds every self noun to ~', () => {
    expect(replaceSelfReferences('When this creature enters, sacrifice this artifact.')).toBe(
      'When ~ enters, sacrifice ~.',
    );
  });

  it('leaves "this turn" and "this way" alone', () => {
    expect(
      replaceSelfReferences('Creatures gain haste until end of turn. Exile it this way.'),
    ).toBe('Creatures gain haste until end of turn. Exile it this way.');
  });

  it('makes the two spellings of a self reference normalise identically', () => {
    const byName = normalizeOracleText(
      'When Elvish Visionary enters, draw a card.',
      'Elvish Visionary',
    );
    const byNoun = normalizeOracleText(
      'When this creature enters, draw a card.',
      'Elvish Visionary',
    );
    expect(byNoun.sentences).toEqual(byName.sentences);
  });
});

/**
 * Scryfall's 2024 update replaced most self references with "this creature"/"this artifact"/… . Rewriting
 * every fixture card into that templating must not change what the auto-scripter emits — if it did, the
 * grammar would be reading the card's name rather than its rules text.
 */
describe('current Scryfall templating', () => {
  const cards = [...(corpus as ScryfallCard[]), ...(bootstrap as ScryfallCard[])].filter((c) =>
    c.oracle_text?.includes(c.name),
  );

  it('covers a meaningful slice of the fixtures', () => {
    expect(cards.length).toBeGreaterThanOrEqual(20);
  });

  for (const card of cards) {
    it(card.name, () => {
      const original = scriptCard(card);
      const modern = scriptCard(modernise(card));
      // Only `text` may differ: it is the verbatim Oracle text, which is what changed.
      const strip = (s: unknown): unknown =>
        s === null ? null : { ...(s as Record<string, unknown>), text: undefined };
      expect(strip(modern.script)).toEqual(strip(original.script));
      expect(modern.reasons).toEqual(original.reasons);
    });
  }
});

/**
 * The drift this fix repairs: a hand script written against the old templating still has to validate
 * against the entry Scryfall serves today.
 */
describe('hand scripts against modern Oracle text', () => {
  it('accepts a name-templated script for a "this creature" card', () => {
    const card = (bootstrap as ScryfallCard[]).find((c) => c.name === 'Elvish Visionary')!;
    const script = {
      oracleId: card.oracle_id,
      name: card.name,
      manaCost: card.mana_cost,
      types: ['creature'],
      subtypes: parseTypeLine(card.type_line).subtypes,
      power: 1,
      toughness: 1,
      text: 'When Elvish Visionary enters, draw a card.',
      abilities: [
        {
          kind: 'triggered',
          covers: [0],
          trigger: { on: 'etb' },
          effects: [{ op: 'draw', count: 1 }],
        },
      ],
    };
    const result = validateScript(script, modernise(card), { skipSmoke: true });
    expect(`${result.status}: ${result.reasons.join('; ')}`).toBe('supported: ');
  });
});
