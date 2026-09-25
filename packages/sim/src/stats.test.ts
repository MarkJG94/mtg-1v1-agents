import { defaultWeights, evaluate, greedyAgent } from '@mtg/agents';
import type { CardDefinition } from '@mtg/engine';
import {
  fuzzBurn,
  fuzzCreature,
  fuzzDeck,
  fuzzLand,
  fuzzRemoval,
  fuzzTrigger,
} from '@mtg/engine/testing';
import {
  asGameId,
  asObjectId,
  asOracleId,
  CURRENT_EVENT_LOG_VERSION,
  cardStats,
  type GameEvent,
  type GameEventBody,
  type GameEventLog,
  type OracleId,
  type PlayerId,
  playerIds,
  playerZone,
} from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { type Deck, deckBoard } from './deck.js';
import { eventLogOf } from './event-log.js';
import { playGame } from './game.js';
import { type CardFacts, cardFactsFor, countsOfGame, UnknownCardError } from './stats.js';

/**
 * The statistics aggregator (roadmap 5.2, docs/05 "Statistics").
 *
 * Two kinds of test. Real games, where the log replay is checked against the engine's own
 * final state — which cards ended in each hand — so a replay that loses track of a card
 * is caught whatever the card did. And hand-built logs, one per rule, where the right
 * answer can be worked out by reading the events.
 */

const slot = (card: CardDefinition, count: number) => ({ oracleId: card.oracleId, count });
const deck: Deck = {
  main: [
    slot(fuzzLand, 22),
    slot(fuzzCreature, 16),
    slot(fuzzTrigger, 4),
    slot(fuzzBurn, 14),
    slot(fuzzRemoval, 4),
  ],
  side: [],
};
const definitions = new Map(fuzzDeck.map((card) => [card.oracleId, card]));
const facts = new Map(fuzzDeck.map((card) => [card.oracleId, cardFactsFor(card)]));

const realGame = (seed: string) => {
  const played = playGame(
    deckBoard({ decks: { A: deck, B: deck }, definitions, seed, chooser: 'A', turnCap: 30 }),
    { A: greedyAgent(), B: greedyAgent() },
    seed,
    { score: (view) => evaluate(view, defaultWeights) },
  );
  const logged = { generation: 0, main: deck.main, side: deck.side };
  return {
    played,
    log: eventLogOf({ gameId: seed, seed, played, players: { A: logged, B: logged } }),
  };
};

describe('read from real games, checked against the engine', () => {
  const games = ['r1', 'r2', 'r3', 'r4', 'r5'].map(realGame);

  it('knows exactly which cards ended the game in each hand', () => {
    for (const { played, log } of games) {
      const counts = countsOfGame(log, facts);
      for (const player of playerIds) {
        const inHand = new Set(
          played.state.zones[playerZone(player, 'hand')].map(
            (id) => played.state.objects.get(id)?.definitionId,
          ),
        );
        const dead = Object.entries(counts[player].cards)
          .filter(([, card]) => card.deadInHand === 1)
          .map(([oracleId]) => oracleId);
        expect(new Set(dead)).toEqual(inHand);
      }
    }
  });

  it('counts every card in the deck once a game, drawn or not', () => {
    for (const { log } of games) {
      const counts = countsOfGame(log, facts);
      for (const player of playerIds) {
        for (const card of Object.values(counts[player].cards)) {
          expect(card.games).toBe(1);
          expect(card.drawn.games + card.notDrawn.games).toBe(1);
        }
      }
    }
  });

  it('records the result and who was on the play', () => {
    for (const { played, log } of games) {
      const counts = countsOfGame(log, facts);
      for (const player of playerIds) {
        const { deck: counted } = counts[player];
        expect(counted.wins).toBe(played.result?.winner === player ? 1 : 0);
        expect(counted.turns).toBe(played.result?.turn);
        const onPlay = played.state.config.playerOnPlay === player;
        expect(counted.onPlay.games).toBe(onPlay ? 1 : 0);
        expect(counted.onDraw.games).toBe(onPlay ? 0 : 1);
      }
    }
  });

  it('scores resolutions, since the games were played with scores', () => {
    const impacts = games.flatMap(({ log }) =>
      playerIds.flatMap((player) =>
        Object.values(countsOfGame(log, facts)[player].cards).map((card) => card.impacts),
      ),
    );
    expect(impacts.reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
  });
});

// --- Hand-built logs ---

const land = asOracleId('t-land');
const bear = asOracleId('t-bear');
const bolt = asOracleId('t-bolt');
const red = asOracleId('t-red');
const handFacts = new Map<OracleId, CardFacts>([
  [land, { land: true, manaValue: 0, costColours: [], produces: ['G'] }],
  [bear, { land: false, manaValue: 2, costColours: ['G'], produces: [] }],
  [bolt, { land: false, manaValue: 1, costColours: ['R'], produces: [] }],
  [red, { land: false, manaValue: 1, costColours: ['R'], produces: [] }],
]);

/**
 * A log from a script of events. Objects 1–20 are A's and 21–40 B's; `cards` says what
 * each is (anything not named is a land).
 */
const handLog = (
  events: readonly GameEventBody[],
  cards: Readonly<Record<number, OracleId>> = {},
  over: Partial<GameEventLog> = {},
): GameEventLog => {
  let turn = 0;
  const stamped = events.map((body, seq) => {
    if (body.type === 'turnStart') turn += 1;
    return { seq, turn, step: 'precombatMain', ...body } as GameEvent;
  });
  const main = [
    { oracleId: land, count: 10 },
    { oracleId: bear, count: 4 },
    { oracleId: bolt, count: 4 },
  ];
  return {
    version: CURRENT_EVENT_LOG_VERSION,
    gameId: asGameId('hand'),
    seed: 'hand',
    players: {
      A: { deckGeneration: 3, main, side: [] },
      B: { deckGeneration: 7, main, side: [] },
    },
    objects: Array.from({ length: 40 }, (_, i) => {
      const id = i + 1;
      return {
        id: asObjectId(id),
        oracleId: cards[id] ?? land,
        owner: (id <= 20 ? 'A' : 'B') as PlayerId,
      };
    }),
    events: stamped,
    result: { winner: 'A', reason: 'life', turns: turn },
    ...over,
  };
};

const o = asObjectId;
const start = (aHand: number[], bHand: number[] = []): GameEventBody => ({
  type: 'gameStart',
  onPlay: 'A',
  chosenBy: 'A',
  startingLife: 20,
  decks: { A: { library: [], hand: aHand.map(o) }, B: { library: [], hand: bHand.map(o) } },
});
const keep = (player: PlayerId, bottomed: number[] = []): GameEventBody => ({
  type: 'keep',
  player,
  handSize: 7,
  bottomed: bottomed.map(o),
});
const turn = (player: PlayerId): GameEventBody => ({ type: 'turnStart', activePlayer: player });
const draw = (player: PlayerId, id: number): GameEventBody => ({
  type: 'draw',
  player,
  object: o(id),
});
const playLand = (player: PlayerId, id: number): GameEventBody[] => [
  { type: 'playLand', player, object: o(id) },
  {
    type: 'moveZone',
    object: o(id),
    from: playerZone(player, 'hand'),
    to: 'battlefield',
    cause: 'resolve',
  },
];
const cast = (player: PlayerId, id: number): GameEventBody => ({
  type: 'cast',
  player,
  object: o(id),
  targets: [],
});
const decide = (player: PlayerId, score: number): GameEventBody => ({
  type: 'decision',
  player,
  kind: 'priority',
  chosen: null,
  score,
});
const end: GameEventBody = { type: 'gameEnd', winner: 'A', reason: 'life' };

const countsA = (log: GameEventLog) => countsOfGame(log, handFacts).A;

describe('what counts as drawn (docs/05)', () => {
  it('counts the kept hand and later draws, and not what was never in hand', () => {
    const counts = countsA(
      handLog([start([1, 2], []), keep('A'), turn('A'), draw('A', 3), end], { 2: bear, 3: bolt }),
    );
    expect(counts.cards[bear]?.drawn.games).toBe(1);
    expect(counts.cards[bolt]?.drawn.games).toBe(1);
    const nothing = countsA(handLog([start([1], []), keep('A'), end]));
    expect(nothing.cards[bear]?.notDrawn.games).toBe(1);
  });

  /** The first deal is in `gameStart`; the draws that dealt it are not draws in the game. */
  it('ignores the draws that dealt the opening hand', () => {
    const counts = countsA(handLog([draw('A', 5), start([1]), keep('A'), end], { 5: bolt }));
    expect(counts.cards[bolt]?.drawn.games).toBe(0);
  });

  /** London mulligan (CR 103.4): the hand mulliganed away is blamed, the new one drawn. */
  it('blames a mulliganed hand, counts the redealt one, and not what went to the bottom', () => {
    const counts = countsA(
      handLog(
        [
          start([2]),
          draw('A', 3),
          draw('A', 4),
          { type: 'mulligan', player: 'A', toHandSize: 6 },
          keep('A', [4]),
          end,
        ],
        { 2: bear, 3: bolt, 4: red },
      ),
    );
    expect(counts.cards[bear]).toMatchObject({ mulliganed: 1, drawn: { games: 0, wins: 0 } });
    expect(counts.cards[bolt]?.drawn.games).toBe(1);
    expect(counts.cards[red]).toBeUndefined(); // not in the main deck at all
  });

  it('counts a card returned to hand as drawn', () => {
    const counts = countsA(
      handLog(
        [
          start([]),
          keep('A'),
          { type: 'moveZone', object: o(2), from: 'battlefield', to: 'A:hand', cause: 'return' },
          end,
        ],
        { 2: bear },
      ),
    );
    expect(counts.cards[bear]?.drawn.games).toBe(1);
  });
});

describe('casting, dead cards and impact', () => {
  it('counts a cast, and its turn in the player’s own turns', () => {
    const counts = countsA(
      handLog(
        [start([2]), keep('A'), turn('B'), turn('A'), turn('B'), turn('A'), cast('A', 2), end],
        { 2: bear },
      ),
    );
    expect(counts.cards[bear]).toMatchObject({ cast: 1, firstCasts: 1, firstCastTurns: 2 });
  });

  it('keeps the turn of the first cast, not a later one', () => {
    const counts = countsA(
      handLog(
        [
          start([2, 3]),
          keep('A'),
          turn('A'),
          cast('A', 2),
          turn('B'),
          turn('A'),
          cast('A', 3),
          end,
        ],
        { 2: bear, 3: bear },
      ),
    );
    expect(counts.cards[bear]).toMatchObject({ firstCasts: 1, firstCastTurns: 1 });
  });

  it('counts a land played as a land used', () => {
    const counts = countsA(handLog([start([1]), keep('A'), turn('A'), ...playLand('A', 1), end]));
    expect(counts.cards[land]?.cast).toBe(1);
  });

  it('calls a card still in hand at the end dead, and one cast not', () => {
    const counts = countsA(
      handLog([start([2, 3]), keep('A'), cast('A', 3), end], { 2: bear, 3: bolt }),
    );
    expect(counts.cards[bear]?.deadInHand).toBe(1);
    expect(counts.cards[bolt]?.deadInHand).toBe(0);
  });

  /** From the caster's last score before casting to its first after the spell resolved. */
  it('measures impact as the caster’s evaluator swing across the resolution', () => {
    const counts = countsA(
      handLog(
        [
          start([3]),
          keep('A'),
          decide('A', 1),
          decide('A', 2),
          cast('A', 3),
          decide('B', 50),
          { type: 'resolve', object: o(3) },
          decide('B', 60),
          decide('A', 7),
          decide('A', 9),
          end,
        ],
        { 3: bolt },
      ),
    );
    expect(counts.cards[bolt]).toMatchObject({ impact: 5, impacts: 1 });
  });
});

describe('the deck as a whole', () => {
  const turns = (n: number, landsPerTurn: (k: number) => number) => {
    const events: GameEventBody[] = [start([]), keep('A'), keep('B')];
    let next = 1;
    for (let k = 1; k <= n; k += 1) {
      events.push(turn('A'));
      for (let i = 0; i < landsPerTurn(k); i += 1) {
        events.push(draw('A', next), ...playLand('A', next));
        next += 1;
      }
      events.push(turn('B'));
    }
    return [...events, end];
  };

  it('is screwed with fewer than three lands after its fourth turn', () => {
    expect(countsA(handLog(turns(4, (k) => (k <= 2 ? 1 : 0)))).deck).toMatchObject({
      screwed: 1,
      screwChances: 1,
    });
    expect(countsA(handLog(turns(4, (k) => (k <= 3 ? 1 : 0)))).deck).toMatchObject({
      screwed: 0,
      screwChances: 1,
    });
    // A game that never reached turn 4 says nothing either way.
    expect(countsA(handLog(turns(3, () => 0))).deck).toMatchObject({ screwed: 0, screwChances: 0 });
  });

  /** Three lands played, one destroyed in the fourth turn: two left, and screwed. */
  it('stops counting a land that left the battlefield', () => {
    const played = (id: number) => [turn('A'), draw('A', id), ...playLand('A', id), turn('B')];
    const events: GameEventBody[] = [
      start([]),
      keep('A'),
      keep('B'),
      ...played(1),
      ...played(2),
      ...played(3),
      turn('A'),
      { type: 'moveZone', object: o(1), from: 'battlefield', to: 'A:graveyard', cause: 'destroy' },
      turn('B'),
      end,
    ];
    expect(countsA(handLog(events)).deck).toMatchObject({ screwed: 1, screwChances: 1 });
  });

  /** A game that ends during the fourth turn still shows how that turn ended. */
  it('reads the lands of a turn the game ended in', () => {
    const events = turns(4, () => 0);
    // Drop the opponent's turn that followed A's fourth, so the game ends inside it.
    events.splice(events.length - 2, 1);
    expect(countsA(handLog(events)).deck).toMatchObject({ screwed: 1, screwChances: 1 });
  });

  it('is flooded with more than seven lands after its eighth turn', () => {
    expect(countsA(handLog(turns(8, (k) => (k <= 4 ? 2 : 0)))).deck).toMatchObject({
      flooded: 1,
      floodChances: 1,
    });
    expect(countsA(handLog(turns(8, (k) => (k <= 7 ? 1 : 0)))).deck).toMatchObject({
      flooded: 0,
      floodChances: 1,
    });
  });

  /** A red spell and a green land that could pay for it but not in red. */
  it('is colour-screwed holding a spell it has the lands for but not the colours', () => {
    const screwed = countsA(
      handLog([start([2, 3]), keep('A'), turn('A'), ...playLand('A', 2), turn('B'), end], {
        3: bolt,
      }),
    );
    expect(screwed.deck.colourScrewed).toBe(1);
    // Without the land it could not have paid either way: short of mana, not of colour.
    const short = countsA(handLog([start([3]), keep('A'), turn('A'), turn('B'), end], { 3: bolt }));
    expect(short.deck.colourScrewed).toBe(0);
  });
});

describe('keyed by the opponent (docs/05 matchupWinRate)', () => {
  it('files each card’s record under the opponent’s deck generation', () => {
    const counts = countsOfGame(
      handLog([start([2], [22]), keep('A'), keep('B'), end], { 2: bear, 22: bear }),
      handFacts,
    );
    expect(Object.keys(counts.A.matchups)).toEqual(['7']);
    expect(Object.keys(counts.B.matchups)).toEqual(['3']);
    expect(counts.A.matchups[7]?.[bear]?.drawn).toEqual({ games: 1, wins: 1 });
    expect(counts.B.matchups[3]?.[bear]?.drawn).toEqual({ games: 1, wins: 0 });
  });

  it('refuses a card it was not told about', () => {
    const log = handLog(
      [start([]), end],
      {},
      {
        players: {
          A: { deckGeneration: 0, main: [{ oracleId: asOracleId('mystery'), count: 1 }], side: [] },
          B: { deckGeneration: 0, main: [], side: [] },
        },
      },
    );
    expect(() => countsOfGame(log, handFacts)).toThrow(UnknownCardError);
  });
});

describe('read off the counts (shared)', () => {
  it('turns a real game’s counts into rates', () => {
    const { log } = realGame('rates');
    const counts = countsOfGame(log, facts).A;
    for (const card of Object.values(counts.cards)) {
      const stats = cardStats(card, 0.5);
      expect(stats.gamesDrawn + stats.gamesNotDrawn).toBe(1);
    }
  });
});
