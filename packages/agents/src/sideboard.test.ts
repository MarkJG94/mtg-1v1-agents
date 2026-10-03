import { asOracleId, type CardKind, type DeckSlot, type OracleId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import {
  type MatchupRecord,
  type SideboardCard,
  type SideboardInput,
  sideboard,
} from './sideboard.js';

/**
 * The sideboarding agent (roadmap 4.6, docs/04). Every case is a match between games 2
 * and 3 whose right answer a player would give without thinking: bring in the artifact
 * removal against the artifact deck, leave the creatures alone when nothing says why.
 */

const id = (name: string): OracleId => asOracleId(name);

const spell = (vs: readonly CardKind[], costColours: SideboardCard['costColours'] = ['G']) => ({
  tags: { is: ['instant', 'spell'] as CardKind[], vs },
  land: false,
  costColours,
  produces: [],
});
const creatureCard = (
  is: readonly CardKind[] = ['creature', 'spell'],
  costColours: SideboardCard['costColours'] = ['G'],
): SideboardCard => ({
  tags: { is, vs: [] },
  land: false,
  costColours,
  produces: [],
});
const landCard = (produces: SideboardCard['produces']): SideboardCard => ({
  tags: { is: ['land'], vs: [] },
  land: true,
  costColours: [],
  produces,
});

const cards = new Map<OracleId, SideboardCard>([
  [id('doom'), spell(['creature'])],
  [id('naturalize'), spell(['artifact', 'enchantment'])],
  [id('fireball'), spell(['creature'], ['R'])],
  [id('bear'), creatureCard()],
  [id('red-bear'), creatureCard(['creature', 'spell'], ['R'])],
  [id('forest'), landCard(['G'])],
  [id('mountain'), landCard(['R'])],
  [id('their-trinket'), creatureCard(['artifact', 'spell'])],
  [id('their-bear'), creatureCard()],
]);

const slot = (name: string, count: number): DeckSlot => ({ oracleId: id(name), count });

const plan = (over: Partial<SideboardInput>) =>
  sideboard({
    main: [slot('forest', 24), slot('bear', 32), slot('doom', 4)],
    side: [slot('naturalize', 4), slot('fireball', 4), slot('mountain', 7)],
    cards,
    opponentSeen: [],
    matchup: { games: 2, wins: 1 },
    records: new Map(),
    banned: new Set(),
    ...over,
  });

const artifactDeck = [slot('their-trinket', 10)];
const creatureDeck = [slot('their-bear', 10)];

const count = (slots: readonly DeckSlot[]) => slots.reduce((sum, s) => sum + s.count, 0);

describe('with nothing to go on', () => {
  it('swaps nothing when it has seen nothing of the opponent', () => {
    expect(plan({}).swaps).toEqual([]);
  });
});

describe('the tag prior (docs/04)', () => {
  it('brings in artifact removal for creature removal against a deck of artifacts', () => {
    const result = plan({ opponentSeen: artifactDeck });
    expect(result.swaps.length).toBeGreaterThan(0);
    for (const swap of result.swaps) {
      expect(swap.in).toBe(id('naturalize'));
      expect(swap.out).toBe(id('doom'));
      expect(swap.inScore.basis).toBe('tags');
    }
  });

  it('leaves its creature removal in against a deck of creatures', () => {
    expect(plan({ opponentSeen: creatureDeck }).swaps).toEqual([]);
  });

  /** A card with no record and nothing to answer has no score, and is not swapped on a guess. */
  it('never takes out a card it has no reason to judge', () => {
    const result = plan({
      main: [slot('forest', 24), slot('bear', 36)],
      opponentSeen: artifactDeck,
    });
    expect(result.swaps).toEqual([]);
  });
});

describe('the matchup record (docs/05)', () => {
  const record = (drawn: [number, number], notDrawn: [number, number]): MatchupRecord => ({
    gamesDrawn: drawn[0],
    winsDrawn: drawn[1],
    gamesNotDrawn: notDrawn[0],
    winsNotDrawn: notDrawn[1],
  });

  it('takes out a card that loses when it is drawn', () => {
    const result = plan({
      opponentSeen: artifactDeck,
      matchup: { games: 60, wins: 30 },
      records: new Map([[id('bear'), record([30, 5], [30, 25])]]),
    });
    expect(result.swaps[0]).toMatchObject({ out: id('bear'), in: id('naturalize') });
    expect(result.swaps[0]?.outScore.basis).toBe('record');
  });

  /** Shrunk toward the deck's rate by twenty games: one bad draw is not a verdict. */
  it('does not act on a record of one game', () => {
    const result = plan({
      opponentSeen: creatureDeck,
      matchup: { games: 2, wins: 1 },
      records: new Map([[id('bear'), record([1, 0], [1, 1])]]),
    });
    expect(result.swaps.filter((swap) => swap.out === id('bear'))).toEqual([]);
  });

  it('prefers a sideboard card that has won in this matchup to its prior', () => {
    const result = plan({
      opponentSeen: creatureDeck,
      matchup: { games: 60, wins: 30 },
      records: new Map([
        [id('naturalize'), record([30, 25], [30, 5])],
        [id('doom'), record([30, 15], [30, 15])],
      ]),
    });
    expect(result.swaps[0]).toMatchObject({ in: id('naturalize'), out: id('doom') });
    expect(result.swaps[0]?.inScore.basis).toBe('record');
  });
});

describe('the limits on a swap (docs/04)', () => {
  it('swaps at most maxSwaps pairs, four by default', () => {
    const result = plan({
      main: [slot('forest', 24), slot('doom', 36)],
      side: [slot('naturalize', 15)],
      opponentSeen: artifactDeck,
    });
    expect(result.swaps).toHaveLength(4);
    expect(
      plan({ ...{ opponentSeen: artifactDeck }, settings: { maxSwaps: 1 } }).swaps,
    ).toHaveLength(1);
  });

  it('keeps sixty and fifteen, and moves the cards it says it moves', () => {
    const before = { main: [slot('forest', 24), slot('bear', 32), slot('doom', 4)] };
    const result = plan({ ...before, opponentSeen: artifactDeck });
    expect(count(result.main)).toBe(60);
    expect(count(result.side)).toBe(15);
    const naturalize = result.main.find((s) => s.oracleId === id('naturalize'))?.count ?? 0;
    expect(naturalize).toBe(result.swaps.length);
  });

  it('only swaps when the difference beats the margin', () => {
    const result = plan({ opponentSeen: artifactDeck, settings: { margin: 1 } });
    expect(result.swaps).toEqual([]);
  });

  it('never brings in a spell its lands cannot cast', () => {
    const result = plan({ opponentSeen: creatureDeck.concat(artifactDeck) });
    expect(result.swaps.some((swap) => swap.in === id('fireball'))).toBe(false);
  });

  it('brings in a spell of a colour the deck already makes', () => {
    const result = plan({
      main: [slot('forest', 20), slot('mountain', 4), slot('bear', 32), slot('naturalize', 4)],
      side: [slot('fireball', 4), slot('mountain', 11)],
      opponentSeen: creatureDeck,
    });
    expect(result.swaps.some((swap) => swap.in === id('fireball'))).toBe(true);
  });

  /**
   * A card the deck could not cast already is not this swap's doing. (A creature, so it has
   * no score of its own and stays in the deck while the swap is judged.)
   */
  it('still swaps when a card elsewhere in the deck was uncastable to begin with', () => {
    const result = plan({
      main: [slot('forest', 24), slot('red-bear', 1), slot('bear', 31), slot('doom', 4)],
      opponentSeen: artifactDeck,
    });
    expect(result.swaps.length).toBeGreaterThan(0);
  });

  it('never takes out a land that a spell in the deck needs', () => {
    const result = plan({
      main: [slot('forest', 23), slot('mountain', 1), slot('fireball', 4), slot('bear', 32)],
      side: [slot('forest', 15)],
      opponentSeen: artifactDeck,
      matchup: { games: 60, wins: 30 },
      records: new Map([
        [id('mountain'), { gamesDrawn: 30, winsDrawn: 1, gamesNotDrawn: 30, winsNotDrawn: 29 }],
        [id('forest'), { gamesDrawn: 30, winsDrawn: 29, gamesNotDrawn: 30, winsNotDrawn: 1 }],
      ]),
    });
    expect(result.swaps.some((swap) => swap.out === id('mountain'))).toBe(false);
  });

  it('never brings in a banned card', () => {
    const result = plan({ opponentSeen: artifactDeck, banned: new Set([id('naturalize')]) });
    expect(result.swaps.some((swap) => swap.in === id('naturalize'))).toBe(false);
  });

  /** A land only for a land, so the land count holds. */
  it('never swaps a land for a spell', () => {
    const result = plan({
      opponentSeen: artifactDeck,
      matchup: { games: 60, wins: 30 },
      records: new Map([
        [id('mountain'), { gamesDrawn: 30, winsDrawn: 29, gamesNotDrawn: 30, winsNotDrawn: 1 }],
        [id('doom'), { gamesDrawn: 30, winsDrawn: 1, gamesNotDrawn: 30, winsNotDrawn: 29 }],
      ]),
    });
    expect(result.swaps.some((swap) => swap.in === id('mountain'))).toBe(false);
  });
});
