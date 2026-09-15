import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { grantableKeywords } from '@mtg/engine';
import { describe, expect, it } from 'vitest';
import { keywordFromPrinted, printedKeyword } from '../keyword-names.js';
import { linesOf, sentencesOf } from '../oracle-text.js';
import type { CardProjection } from '../scryfall.js';
import { keywordsOnLine, normaliseCard, normaliseText } from './normalise.js';

/**
 * The normaliser (docs/03, auto-scripter step 1).
 *
 * Each case here is a rule the later steps are written against: if the normaliser stops
 * doing one of them, the grammar in 3.3 sees text it was never written for and fails on
 * cards it used to read. The fixture run at the end is the same rules against 60 real
 * cards, which is the only way to find out what oracle text actually looks like.
 */

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const fixture = JSON.parse(readFileSync(here('../../fixtures/scryfall.json'), 'utf8')) as Record<
  string,
  CardProjection
>;
const card = (name: string): CardProjection => {
  const found = Object.values(fixture).find((each) => each.name === name);
  if (found === undefined) throw new Error(`no ${name} in the fixture`);
  return found;
};

describe('the card talking about itself', () => {
  it('replaces the printed name with ~', () => {
    expect(normaliseText('Shock deals 2 damage to any target.', 'Shock', 'Instant')).toBe(
      '~ deals 2 damage to any target.',
    );
  });

  it('replaces every occurrence, including a possessive', () => {
    expect(normaliseText("Sacrifice Bob. Bob's controller draws.", 'Bob', 'Creature — Human')).toBe(
      "Sacrifice ~. ~'s controller draws.",
    );
  });

  it('leaves a longer word that merely starts with the name alone', () => {
    expect(normaliseText('Shock and Shockwave.', 'Shock', 'Instant')).toBe('~ and Shockwave.');
  });

  it('replaces a legendary card’s short name', () => {
    expect(
      normaliseText(
        '+1: Chandra deals 1 damage.',
        'Chandra, Torch of Defiance',
        'Legendary Planeswalker — Chandra',
      ),
    ).toBe('+1: ~ deals 1 damage.');
  });

  it('does not take a nonlegendary card’s first word for a short name', () => {
    expect(normaliseText('Giant creatures are big.', 'Giant Spider', 'Creature — Spider')).toBe(
      'Giant creatures are big.',
    );
  });

  it('replaces the whole name before the short one', () => {
    expect(
      normaliseText('Jace Beleren draws.', 'Jace Beleren', 'Legendary Planeswalker — Jace'),
    ).toBe('~ draws.');
  });

  it('resolves modern self-reference to the same ~', () => {
    expect(normaliseText('This creature enters tapped.', 'Whatever', 'Land')).toBe(
      '~ enters tapped.',
    );
    expect(normaliseText('Counter this spell unless.', 'Whatever', 'Instant')).toBe(
      'Counter ~ unless.',
    );
  });

  it('leaves "this" alone when it is not the card', () => {
    const text = 'Target player takes an extra turn after this one. Untap this turn.';
    expect(normaliseText(text, 'Time Warp', 'Sorcery')).toBe(text);
  });
});

describe('punctuation', () => {
  it('turns a loyalty cost’s minus sign into a hyphen', () => {
    expect(normaliseText('−1: Draw a card.', 'X', 'Legendary Planeswalker — X')).toBe(
      '-1: Draw a card.',
    );
  });

  it('turns typographic quotes and spaces into plain ones', () => {
    expect(normaliseText('“destroy” it’s', 'X', 'Instant')).toBe('"destroy" it\'s');
  });

  it('spells both dashes the same way', () => {
    expect(normaliseText('Choose one –', 'X', 'Instant')).toBe('Choose one —');
  });
});

describe('keyword lines', () => {
  it('reads a line of several keywords', () => {
    expect(keywordsOnLine('Flying, first strike')).toEqual(['flying', 'firstStrike']);
  });

  it('reads them however they are joined', () => {
    expect(keywordsOnLine('Flying and trample.')).toEqual(['flying', 'trample']);
  });

  it('refuses a line with anything else in it', () => {
    expect(keywordsOnLine('Flying, protection from red')).toBeNull();
    expect(keywordsOnLine('When this creature enters, draw a card.')).toBeNull();
    expect(keywordsOnLine('Equip {2}')).toBeNull();
  });

  it('keeps a keyword line out of the abilities', () => {
    const normalised = normaliseCard(card('Vampire Nighthawk'));
    expect(normalised.keywords).toEqual(['flying', 'deathtouch', 'lifelink']);
    expect(normalised.abilities).toEqual([]);
    expect(normalised.keywordLines).toHaveLength(3);
  });

  it('separates the keyword line from the ability below it', () => {
    const normalised = normaliseCard(card('Wall of Omens'));
    expect(normalised.keywords).toEqual(['defender']);
    expect(normalised.abilities.map((line) => line.text)).toEqual(['When ~ enters, draw a card.']);
  });

  it('says so when a keyword line names something Scryfall does not list', () => {
    const invented: CardProjection = {
      ...card('Grizzly Bears'),
      oracleText: 'Flying',
      keywords: [],
    };
    expect(normaliseCard(invented).notes.join(' ')).toContain('Scryfall does not list it');
  });

  it('lists a Scryfall keyword the engine cannot grant without calling it a verdict', () => {
    // Scryfall's keywords array mixes keyword abilities with action words: Jace Beleren
    // lists "Mill", which the engine has an op for.
    expect(normaliseCard(card('Jace Beleren')).otherKeywords).toEqual(['Mill']);
  });

  it('has a printed name for every keyword the engine can grant', () => {
    for (const keyword of grantableKeywords) {
      expect(keywordFromPrinted(printedKeyword(keyword))).toBe(keyword);
    }
  });
});

describe('numbering', () => {
  it('gives each line the sentence numbers covers: would use', () => {
    const text = 'Flying\nDraw a card. Then discard a card.';
    expect(linesOf(text).map((line) => line.sentences.map((sentence) => sentence.index))).toEqual([
      [0],
      [1, 2],
    ]);
  });

  it('numbers the same sentences sentencesOf does', () => {
    for (const each of Object.values(fixture)) {
      const flattened = linesOf(each.oracleText).flatMap((line) =>
        line.sentences.map((sentence) => sentence.text),
      );
      expect(flattened).toEqual([...sentencesOf(each.oracleText)]);
    }
  });

  it('keeps the numbering when the text is normalised', () => {
    const each = card('Wall of Omens');
    const normalised = normaliseCard(each);
    expect(normalised.abilities[0]?.sentences.map((sentence) => sentence.index)).toEqual([1]);
    expect(sentencesOf(each.oracleText)).toHaveLength(2);
  });
});

describe('faces', () => {
  it('reads the front face when the text lives there, and says the rest were not', () => {
    const transform: CardProjection = {
      ...card('Grizzly Bears'),
      oracleText: '',
      faces: [
        {
          name: 'Front',
          manaCost: '{G}',
          typeLine: 'Creature — Bear',
          oracleText: 'Front deals 1 damage.',
          power: '2',
          toughness: '2',
          loyalty: null,
        },
        {
          name: 'Back',
          manaCost: null,
          typeLine: 'Creature — Bear',
          oracleText: 'Back is big.',
          power: '4',
          toughness: '4',
          loyalty: null,
        },
      ],
    };
    const normalised = normaliseCard(transform);
    expect(normalised.abilities.map((line) => line.text)).toEqual(['~ deals 1 damage.']);
    expect(normalised.notes.join(' ')).toContain('"Back" was not');
  });
});

describe('over the bootstrap set', () => {
  const cards = Object.values(fixture);

  it('reads every card without a note it cannot explain', () => {
    for (const each of cards) {
      expect(normaliseCard(each).notes, `${each.name}`).toEqual([]);
    }
  });

  it('leaves no card name behind in the text it produces', () => {
    for (const each of cards) {
      const text = normaliseCard(each)
        .abilities.map((line) => line.text)
        .join('\n');
      expect(text, `${each.name}`).not.toContain(each.name);
    }
  });

  it('finds the keywords the cards actually have', () => {
    expect(normaliseCard(card('Serra Angel')).keywords).toEqual(['flying', 'vigilance']);
    expect(normaliseCard(card('Youthful Knight')).keywords).toEqual(['firstStrike']);
    expect(normaliseCard(card('Lightning Bolt')).keywords).toEqual([]);
  });
});
