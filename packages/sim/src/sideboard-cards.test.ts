import { fileURLToPath } from 'node:url';
import { sideboard } from '@mtg/agents';
import { loadCardScript, readScript } from '@mtg/cards';
import type { CardDefinition } from '@mtg/engine';
import type { DeckSlot } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { sideboardCardFor, sideboardCardsFor } from './sideboard-cards.js';

/**
 * Sideboarding from real scripts (roadmap 4.6): the tags `@mtg/cards` reads off the
 * bootstrap cards, handed to the agent in `@mtg/agents`, choosing what a player would.
 */

const script = (path: string): CardDefinition =>
  loadCardScript(
    readScript(fileURLToPath(new URL(`../../cards/scripts/${path}.yaml`, import.meta.url))).content,
  );

const doomBlade = script('d/doom-blade');
const naturalize = script('n/naturalize');
const shatter = script('s/shatter');
const bears = script('g/grizzly-bears');
const forest = script('f/forest');
const mountain = script('m/mountain');
const swamp = script('s/swamp');
const icy = script('i/icy-manipulator');
const ornithopter = script('o/ornithopter');

const slot = (card: CardDefinition, count: number): DeckSlot => ({
  oracleId: card.oracleId,
  count,
});

describe('what the agent is told about a card', () => {
  it('reads a land’s colours from its mana ability', () => {
    expect(sideboardCardFor(forest)).toMatchObject({ land: true, produces: ['G'] });
  });

  it('reads a spell’s colours from its cost, and its answers from its script', () => {
    expect(sideboardCardFor(doomBlade)).toMatchObject({
      land: false,
      costColours: ['B'],
      tags: { vs: ['creature'] },
    });
  });
});

describe('sideboarding from real scripts', () => {
  const cards = sideboardCardsFor([
    doomBlade,
    naturalize,
    shatter,
    bears,
    forest,
    mountain,
    swamp,
    icy,
    ornithopter,
  ]);

  /**
   * Against a deck of artifacts — mostly Icy Manipulators, which no creature removal
   * touches — the removal that answers artifacts comes in for the removal that does not:
   * Naturalize, which the Forests can cast. Shatter answers them too, but it is red and
   * the deck makes no red, so it stays out.
   */
  it('brings in the artifact removal it can cast against a deck of artifacts', () => {
    const plan = sideboard({
      main: [slot(forest, 20), slot(swamp, 4), slot(bears, 32), slot(doomBlade, 4)],
      side: [slot(naturalize, 4), slot(shatter, 4), slot(mountain, 7)],
      cards,
      opponentSeen: [slot(icy, 6), slot(ornithopter, 2)],
      matchup: { games: 2, wins: 1 },
      records: new Map(),
      banned: new Set(),
    });
    expect(plan.swaps.map((swap) => swap.in)).not.toContain(shatter.oracleId);
    expect(plan.swaps.map((swap) => swap.in)).toContain(naturalize.oracleId);
    expect(new Set(plan.swaps.map((swap) => swap.out))).toEqual(new Set([doomBlade.oracleId]));
  });

  /** Ornithopter is an artifact creature: Doom Blade answers it as well as Naturalize does. */
  it('keeps its creature removal against artifact creatures, which it answers too', () => {
    const plan = sideboard({
      main: [slot(forest, 20), slot(swamp, 4), slot(bears, 32), slot(doomBlade, 4)],
      side: [slot(naturalize, 4), slot(shatter, 4), slot(mountain, 7)],
      cards,
      opponentSeen: [slot(ornithopter, 8)],
      matchup: { games: 2, wins: 1 },
      records: new Map(),
      banned: new Set(),
    });
    expect(plan.swaps).toEqual([]);
  });
});
