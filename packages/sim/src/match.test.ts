import { greedyAgent, type PlayAgent, type SideboardPlan } from '@mtg/agents';
import type { CardDefinition } from '@mtg/engine';
import {
  fuzzBurn,
  fuzzCreature,
  fuzzDeck,
  fuzzLand,
  fuzzRemoval,
  fuzzTrigger,
} from '@mtg/engine/testing';
import { asOracleId, opponentOf, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { cardCount, type Deck, deckBoard, MissingDefinitionError } from './deck.js';
import {
  IllegalSideboardError,
  type MatchOptions,
  playMatch,
  type SideboardContext,
} from './match.js';

/**
 * The best-of-three match (roadmap 5.1, docs/05 "The cycle"), on sixty-card decks of the
 * engine's fuzz cards — real enough to play, fast enough to play many.
 */

const slot = (card: CardDefinition, count: number) => ({ oracleId: card.oracleId, count });

/** Burn-heavy, so games end in a kill more often than at the turn cap. */
const deck: Deck = {
  main: [
    slot(fuzzLand, 22),
    slot(fuzzCreature, 16),
    slot(fuzzTrigger, 4),
    slot(fuzzBurn, 14),
    slot(fuzzRemoval, 4),
  ],
  side: [slot(fuzzBurn, 5), slot(fuzzRemoval, 5), slot(fuzzCreature, 5)],
};

const definitions = new Map(fuzzDeck.map((card) => [card.oracleId, card]));

const match = (over: Partial<MatchOptions> = {}) =>
  playMatch({
    players: { A: { deck, agent: greedyAgent() }, B: { deck, agent: greedyAgent() } },
    definitions,
    seed: 'match',
    firstChooser: 'A',
    turnCap: 30,
    ...over,
  });

/** Greedy's play, but always choosing to draw first. */
const drawer: PlayAgent = {
  level: 'greedy',
  decide: (view, decision, rng, simulator) =>
    decision.kind === 'playOrDraw'
      ? { kind: 'playOrDraw', choice: 'draw' }
      : greedyAgent().decide(view, decision, rng, simulator),
};

describe('a game from two decks', () => {
  it('puts each main deck in its owner’s library, and leaves the sideboards out', () => {
    const state = deckBoard({
      decks: { A: deck, B: deck },
      definitions,
      seed: 's',
      chooser: 'B',
      turnCap: 20,
    });
    expect(state.zones[playerZone('A', 'library')]).toHaveLength(60);
    expect(state.zones[playerZone('B', 'library')]).toHaveLength(60);
    expect(state.objects.size).toBe(120);
    expect(state.config.startingChooser).toBe('B');
  });

  it('refuses a deck holding a card nobody has scripted', () => {
    const unknown = {
      ...deck,
      main: [...deck.main, { oracleId: asOracleId('nothing'), count: 1 }],
    };
    expect(() =>
      deckBoard({
        decks: { A: unknown, B: deck },
        definitions,
        seed: 's',
        chooser: 'A',
        turnCap: 20,
      }),
    ).toThrow(MissingDefinitionError);
  });
});

describe('the match', () => {
  it('stops when a player has won two games, and never plays a fourth', () => {
    for (const seed of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) {
      const result = match({ seed });
      expect(result.games.length).toBeLessThanOrEqual(3);
      const counted = { A: 0, B: 0 };
      result.games.forEach((game, i) => {
        // Nothing is played once someone has two.
        expect(Math.max(counted.A, counted.B)).toBeLessThan(2);
        const winner = game.result?.winner ?? null;
        if (winner !== null) counted[winner] += 1;
        if (i === result.games.length - 1) expect(counted).toEqual(result.wins);
      });
      expect(result.winner).toBe(
        result.wins.A > result.wins.B ? 'A' : result.wins.B > result.wins.A ? 'B' : null,
      );
    }
  });

  /** CR 103.1: the loser of the previous game chooses who plays first. */
  it('lets the first chooser choose game 1, and the loser of each game choose the next', () => {
    for (const [seed, firstChooser] of [
      ['c1', 'A'],
      ['c2', 'B'],
      ['c3', 'A'],
      ['c4', 'B'],
    ] as const) {
      const result = match({ seed, firstChooser });
      expect(result.games[0]?.chooser).toBe(firstChooser);
      for (let i = 1; i < result.games.length; i += 1) {
        const previous = result.games[i - 1];
        const winner = previous?.result?.winner ?? null;
        expect(result.games[i]?.chooser).toBe(
          winner === null ? previous?.chooser : opponentOf(winner),
        );
      }
    }
  });

  /**
   * CR 103.1: after a drawn game, whoever chose in it chooses again. Two turns is too few
   * to win in, so every game here is a draw — and a drawn match, three games long.
   */
  it('keeps the same chooser after a drawn game, and calls level wins a drawn match', () => {
    const result = match({ turnCap: 2, firstChooser: 'B' });
    expect(result.games.map((game) => game.result?.winner ?? null)).toEqual([null, null, null]);
    expect(result.games.map((game) => game.chooser)).toEqual(['B', 'B', 'B']);
    expect(result.winner).toBeNull();
  });

  it('puts on the play whoever the chooser chooses', () => {
    const plays = match({
      players: { A: { deck, agent: drawer }, B: { deck, agent: greedyAgent() } },
    });
    for (const game of plays.games) {
      expect(game.onPlay).toBe(game.chooser === 'A' ? 'B' : 'A');
    }
  });

  it('is the same match from the same seed', () => {
    expect(match({ seed: 'again' })).toEqual(match({ seed: 'again' }));
  });
});

/** A seed whose match runs to exactly this many games, found by playing. */
const seedFor = (games: number): string => {
  for (let i = 0; i < 30; i += 1) {
    const seed = `length-${games}-${i}`;
    if (match({ seed }).games.length === games) return seed;
  }
  throw new Error(`no seed in thirty gives a ${games}-game match`);
};

describe('sideboarding between games 2 and 3 (docs/04)', () => {
  /** A match that goes to three games, so the hook has a game 3. */
  const threeGames = seedFor(3);

  /** Four triggers out, four removal in. */
  const boardIn: SideboardPlan = {
    swaps: [],
    main: [slot(fuzzLand, 22), slot(fuzzCreature, 16), slot(fuzzBurn, 14), slot(fuzzRemoval, 8)],
    side: [slot(fuzzBurn, 5), slot(fuzzRemoval, 1), slot(fuzzCreature, 5), slot(fuzzTrigger, 4)],
  };

  it('asks once, before game 3, and plays game 3 with what it answered', () => {
    const asked: SideboardContext[] = [];
    const result = match({
      seed: threeGames,
      players: {
        A: {
          deck,
          agent: greedyAgent(),
          sideboard: (context) => {
            asked.push(context);
            return boardIn;
          },
        },
        B: { deck, agent: greedyAgent() },
      },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.games).toHaveLength(2);
    expect(result.games[0]?.decks.A).toEqual(deck.main);
    expect(result.games[1]?.decks.A).toEqual(deck.main);
    expect(result.games[2]?.decks.A).toEqual(boardIn.main);
    expect(result.games[2]?.decks.B).toEqual(deck.main);
    expect(result.sideboarding).toEqual({ A: boardIn, B: null });
  });

  it('shows the hook what the opponent has shown, and only that', () => {
    let seen: SideboardContext['opponentSeen'] = [];
    const theirs: Deck = { main: [slot(fuzzLand, 30), slot(fuzzCreature, 30)], side: deck.side };
    match({
      seed: threeGames,
      players: {
        A: {
          deck,
          agent: greedyAgent(),
          sideboard: (context) => {
            seen = context.opponentSeen;
            return boardIn;
          },
        },
        B: { deck: theirs, agent: greedyAgent() },
      },
    });
    expect(cardCount(seen)).toBeGreaterThan(0);
    // Not their whole deck twice over: a library and a hand are not shown (CR 400.2).
    expect(cardCount(seen)).toBeLessThan(2 * 60);
    for (const entry of seen) {
      expect([fuzzLand.oracleId, fuzzCreature.oracleId]).toContain(entry.oracleId);
    }
  });

  it('is not asked in a match that ends in two games', () => {
    const twoGames = seedFor(2);
    let asked = 0;
    match({
      seed: twoGames,
      players: {
        A: {
          deck,
          agent: greedyAgent(),
          sideboard: () => {
            asked += 1;
            return boardIn;
          },
        },
        B: { deck, agent: greedyAgent() },
      },
    });
    expect(asked).toBe(0);
  });

  it('refuses a plan that changes the seventy-five or the sixty', () => {
    const extra: SideboardPlan = { ...boardIn, side: [...boardIn.side, slot(fuzzLand, 1)] };
    const short: SideboardPlan = {
      ...boardIn,
      main: boardIn.main.map((entry) =>
        entry.oracleId === fuzzLand.oracleId ? { ...entry, count: 21 } : entry,
      ),
      side: [...boardIn.side, slot(fuzzLand, 1)],
    };
    for (const plan of [extra, short]) {
      expect(() =>
        match({
          seed: threeGames,
          players: {
            A: { deck, agent: greedyAgent(), sideboard: () => plan },
            B: { deck, agent: greedyAgent() },
          },
        }),
      ).toThrow(IllegalSideboardError);
    }
  });
});
