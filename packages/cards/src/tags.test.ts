import { fileURLToPath } from 'node:url';
import { type CardDefinition, parseManaCost } from '@mtg/engine';
import { asOracleId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { readScript } from './files.js';
import { loadCardScript } from './load.js';
import { cardsDrawn, cardTags } from './tags.js';

/**
 * Card tags (roadmap 4.6): what a card is and what it answers, read off its script. The
 * bootstrap cards are the ground truth — real scripts, written by hand, whose right
 * answers a Magic player can check at a glance.
 */

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const script = (path: string): CardDefinition =>
  loadCardScript(readScript(here(`../scripts/${path}.yaml`)).content);
const tags = (path: string) => cardTags(script(path));

describe('what a card is', () => {
  it('is its card types, and every nonland card is a spell', () => {
    expect(tags('g/grizzly-bears')).toEqual({ is: ['creature', 'spell'], vs: [] });
    expect(tags('f/forest')).toEqual({ is: ['land'], vs: [] });
  });

  it('is burn when its damage can go to a player', () => {
    expect(tags('l/lightning-bolt').is).toContain('burn');
    expect(tags('l/lava-axe').is).toContain('burn');
  });

  it('is not burn when its damage can only hit creatures', () => {
    expect(tags('p/pyroclasm').is).not.toContain('burn');
  });

  it('is a counterspell when it counters, and lifegain when it gains life', () => {
    expect(tags('c/counterspell').is).toContain('counterspell');
    expect(tags('a/angel-s-mercy').is).toContain('lifegain');
  });
});

describe('what a card answers', () => {
  it('answers creatures when it destroys a target creature', () => {
    expect(tags('d/doom-blade').vs).toEqual(['creature']);
    expect(tags('m/murder').vs).toEqual(['creature']);
  });

  it('answers creatures when it damages each of them', () => {
    expect(tags('p/pyroclasm').vs).toEqual(['creature']);
  });

  /** "Any target" is a creature, a planeswalker or a player (CR 115.4). */
  it('answers creatures and planeswalkers with damage to any target', () => {
    expect(tags('l/lightning-bolt').vs).toEqual(['creature', 'planeswalker']);
  });

  it('answers artifacts and enchantments by the types its filter names', () => {
    expect(tags('n/naturalize').vs).toEqual(['artifact', 'enchantment']);
    expect(tags('s/shatter').vs).toEqual(['artifact']);
    expect(tags('s/stone-rain').vs).toEqual(['land']);
  });

  it('answers the creature it fights, not the one it fights with', () => {
    expect(tags('p/prey-upon').vs).toEqual(['creature']);
  });

  it('answers spells when it counters them', () => {
    expect(tags('c/counterspell').vs).toEqual(['spell']);
    expect(tags('n/negate').vs).toEqual(['spell']);
  });

  it('answers burn when it gains life', () => {
    expect(tags('a/angel-s-mercy').vs).toEqual(['burn']);
  });

  it('answers nothing when it only helps its own side', () => {
    expect(tags('g/giant-growth').vs).toEqual([]);
    expect(tags('g/glorious-anthem').vs).toEqual([]);
  });
});

describe('what only a hand-built card shows', () => {
  const card = (over: Partial<CardDefinition>): CardDefinition => ({
    oracleId: asOracleId('tag-test'),
    name: 'Tag Test',
    manaCost: parseManaCost('{1}'),
    types: ['sorcery'],
    colours: [],
    abilities: [],
    ...over,
  });

  it('counts a draw wherever it sits: in a sequence, a loop or either branch of an if', () => {
    const draw = { op: 'draw', player: { kind: 'you' }, count: 1 } as const;
    const nested = card({
      abilities: [
        {
          kind: 'spell',
          effects: [
            { op: 'sequence', effects: [draw] },
            { op: 'forEach', of: { kind: 'creature' }, effects: [draw] },
            {
              op: 'if',
              condition: { kind: 'exists', filter: { kind: 'creature' } },
              thenDo: [draw],
              otherwise: [draw],
            },
          ],
        },
      ],
    });
    expect(cardsDrawn(nested)).toBe(4);
    // What varies counts as one; an opponent's draw is not the caster's card advantage.
    const variable = card({
      abilities: [
        {
          kind: 'spell',
          effects: [
            { op: 'draw', player: { kind: 'you' }, count: { kind: 'x' } },
            { op: 'draw', player: { kind: 'opponent' }, count: 3 },
          ],
        },
      ],
    });
    expect(cardsDrawn(variable)).toBe(1);
  });

  it('answers counterspells with split second (CR 702.61a)', () => {
    expect(cardTags(card({ splitSecond: true })).vs).toEqual(['counterspell']);
  });

  it('answers the graveyard when it exiles cards from one, and uses one when it returns them', () => {
    const graveyardCard = { kind: 'inZone', zone: 'B:graveyard' } as const;
    const exile = card({
      abilities: [
        {
          kind: 'spell',
          targets: [{ id: 't', filter: graveyardCard }],
          effects: [{ op: 'exile', object: { kind: 'target', id: 't' } }],
        },
      ],
    });
    expect(cardTags(exile).vs).toContain('graveyard');

    const raise = card({
      abilities: [
        {
          kind: 'spell',
          targets: [{ id: 't', filter: { kind: 'inZone', zone: 'A:graveyard' } }],
          effects: [
            {
              op: 'moveZone',
              object: { kind: 'target', id: 't' },
              to: { kind: 'hand' },
            },
          ],
        },
      ],
    });
    expect(cardTags(raise).is).toContain('graveyard');
  });

  it('answers creatures with a pump that takes toughness away, and not with one that adds it', () => {
    const shrink = (toughness: number) =>
      card({
        abilities: [
          {
            kind: 'spell',
            targets: [{ id: 't', filter: { kind: 'creature' } }],
            effects: [
              { op: 'pump', object: { kind: 'target', id: 't' }, power: toughness, toughness },
            ],
          },
        ],
      });
    expect(cardTags(shrink(-3)).vs).toEqual(['creature']);
    expect(cardTags(shrink(3)).vs).toEqual([]);
  });

  it('answers nothing of the opponent’s with a filter confined to its own side', () => {
    const own = card({
      abilities: [
        {
          kind: 'spell',
          targets: [
            {
              id: 't',
              filter: {
                kind: 'and',
                filters: [{ kind: 'creature' }, { kind: 'controlledBy', player: 'you' }],
              },
            },
          ],
          effects: [{ op: 'destroy', object: { kind: 'target', id: 't' } }],
        },
      ],
    });
    expect(cardTags(own).vs).toEqual([]);
  });

  it('answers everything but creatures with "destroy target noncreature permanent"', () => {
    const noncreature = card({
      abilities: [
        {
          kind: 'spell',
          targets: [
            {
              id: 't',
              filter: {
                kind: 'and',
                filters: [{ kind: 'permanent' }, { kind: 'not', filter: { kind: 'creature' } }],
              },
            },
          ],
          effects: [{ op: 'destroy', object: { kind: 'target', id: 't' } }],
        },
      ],
    });
    expect(cardTags(noncreature).vs).toEqual(['artifact', 'enchantment', 'planeswalker', 'land']);
  });
});

describe('cards drawn (the deck agent’s card-advantage term, roadmap 5.4)', () => {
  const drawn = (path: string) => cardsDrawn(script(path));

  it('counts what a spell or a trigger draws for its controller', () => {
    expect(drawn('d/divination')).toBe(2);
    expect(drawn('e/elvish-visionary')).toBe(1);
    expect(drawn('w/wall-of-omens')).toBe(1);
  });

  it('counts a target player drawing, which is nearly always the caster', () => {
    expect(drawn('s/sign-in-blood')).toBe(2);
  });

  it('does not count a draw everybody gets', () => {
    // Jace Beleren: +2 each player draws a card (not counted); −1 target player draws one.
    expect(drawn('j/jace-beleren')).toBe(1);
  });

  it('is nothing for a card that draws nothing', () => {
    expect(drawn('g/grizzly-bears')).toBe(0);
    expect(drawn('l/lightning-bolt')).toBe(0);
    expect(drawn('f/forest')).toBe(0);
  });
});
