import {
  banStateSchema,
  type CycleSummary,
  cycleDetailSchema,
  cycleSummarySchema,
  type GameEvent,
  type GameEventBody,
  gameDetailSchema,
  gameLogSchema,
  matchDetailSchema,
  runDetailSchema,
  runSettingsSchema,
  statsTableSchema,
} from '@mtg/shared';

/**
 * A small run as the API answers it, each response parsed with the schema the client
 * parses it with, so a fixture that drifts from the contract fails here, not as a
 * puzzling empty page.
 */

export const RUN = 'run-1';

export const cards = {
  bolt: {
    oracleId: 'bolt',
    name: 'Lightning Bolt',
    manaCost: '{R}',
    manaValue: 1,
    typeLine: 'Instant',
    oracleText: 'Lightning Bolt deals 3 damage to any target.',
    power: null,
    toughness: null,
  },
  shock: {
    oracleId: 'shock',
    name: 'Shock',
    manaCost: '{R}',
    manaValue: 1,
    typeLine: 'Instant',
    oracleText: 'Shock deals 2 damage to any target.',
    power: null,
    toughness: null,
  },
  chain: {
    oracleId: 'chain',
    name: 'Chain Lightning',
    manaCost: '{R}',
    manaValue: 1,
    typeLine: 'Sorcery',
    oracleText: 'Chain Lightning deals 3 damage to any target.',
    power: null,
    toughness: null,
  },
  goblin: {
    oracleId: 'goblin',
    name: 'Goblin Guide',
    manaCost: '{R}',
    manaValue: 1,
    typeLine: 'Creature — Goblin Scout',
    oracleText: 'Haste',
    power: '2',
    toughness: '2',
  },
  mountain: {
    oracleId: 'mountain',
    name: 'Mountain',
    manaCost: null,
    manaValue: 0,
    typeLine: 'Basic Land — Mountain',
    oracleText: '({T}: Add {R}.)',
    power: null,
    toughness: null,
  },
  pyro: {
    oracleId: 'pyro',
    name: 'Pyroblast',
    manaCost: '{R}',
    manaValue: 1,
    typeLine: 'Instant',
    oracleText:
      'Choose one — Counter target spell if it’s blue; or destroy target permanent if it’s blue.',
    power: null,
    toughness: null,
  },
  forest: {
    oracleId: 'forest',
    name: 'Forest',
    manaCost: null,
    manaValue: 0,
    typeLine: 'Basic Land — Forest',
    oracleText: '({T}: Add {G}.)',
    power: null,
    toughness: null,
  },
} as const;

export const summaryOf = (card: (typeof cards)[keyof typeof cards]) => ({
  oracleId: card.oracleId,
  name: card.name,
  manaCost: card.manaCost,
  manaValue: card.manaValue,
  typeLine: card.typeLine,
  colorIdentity: [] as string[],
  support: 'supported' as const,
});

/** What `POST /api/cards/lookup` says of a fixture card: its summary and its face. */
export const faceOf = (card: (typeof cards)[keyof typeof cards]) => ({
  ...summaryOf(card),
  oracleText: card.oracleText,
  power: card.power,
  toughness: card.toughness,
  loyalty: null,
});

const deckA = {
  main: [
    { oracleId: 'bolt', count: 4 },
    { oracleId: 'chain', count: 4 },
    { oracleId: 'goblin', count: 4 },
    { oracleId: 'mountain', count: 48 },
  ],
  side: [{ oracleId: 'pyro', count: 15 }],
};
const deckB = {
  main: [
    { oracleId: 'bolt', count: 1 },
    { oracleId: 'shock', count: 4 },
    { oracleId: 'goblin', count: 4 },
    { oracleId: 'mountain', count: 51 },
  ],
  side: [{ oracleId: 'pyro', count: 15 }],
};

const cycle = (number: number, a: number, change: CycleSummary['change'] = null): CycleSummary =>
  cycleSummarySchema.parse({
    number,
    generations: { A: number === 3 ? 0 : 1, B: 0 },
    matches: 10,
    tiebreakMatches: 0,
    winRate: { A: a, B: 1 - a },
    loser: a < 0.5 ? 'A' : 'B',
    decidedBy: 'winRate',
    change,
    unchanged: change === null ? 'nothing the engine can play replaces Shock (weakest)' : null,
  });

export const cycles: CycleSummary[] = [
  cycle(1, 0.6),
  cycle(2, 0.35, {
    agent: 'A',
    generation: 1,
    shape: 'replace',
    reason: 'Cut 4 Shock for 4 Chain Lightning — Shock was dead in hand',
  }),
  cycle(3, 0.55),
];

export const runDetail = runDetailSchema.parse({
  id: RUN,
  name: 'Mono red mirror',
  status: 'paused',
  seed: '7',
  agentLevel: 'greedy',
  createdAt: '2026-01-01T00:00:00Z',
  forkedFrom: null,
  cycles: 3,
  currentCycle: null,
  playing: false,
  winRates: cycles.map((each) => each.winRate.A),
  lastChange: 'Cut 4 Shock for 4 Chain Lightning — Shock was dead in hand',
  settings: runSettingsSchema.parse({ seed: '7', agentLevel: 'greedy' }),
  bans: [{ oracleId: 'pyro', name: 'Pyroblast', status: 'restricted' }],
  decks: {
    A: { agent: 'A', generation: 1, cycle: 2, cause: 'change', deck: deckA, change: null },
    B: { agent: 'B', generation: 0, cycle: 0, cause: 'seed', deck: deckB, change: null },
  },
  lastCycle: cycles.at(-1),
});

const statsRow = (oracleId: string, name: string, delta: number) => ({
  oracleId,
  name,
  games: 30.4,
  gamesDrawn: 12.6,
  gamesNotDrawn: 17.8,
  winRateDrawn: 0.62,
  winRateNotDrawn: 0.48,
  delta,
  castRate: 0.9,
  deadInHandRate: 0.05,
  avgTurnCast: 2.4,
  impact: 1.25,
  mulliganBlame: 0.1,
});

const deckStats = {
  games: 30.4,
  winRate: 0.55,
  winRateOnPlay: 0.6,
  winRateOnDraw: 0.5,
  averageTurns: 9.1,
  screwRate: 0.1,
  floodRate: 0.05,
  colourScrewRate: 0,
};

export const stats = (agent: 'A' | 'B', cycleNumber: number | null = null) =>
  statsTableSchema.parse({
    agent,
    cycle: cycleNumber,
    deck: deckStats,
    cards: [
      statsRow('bolt', 'Lightning Bolt', agent === 'A' ? 0.042 : 0.01),
      statsRow('chain', 'Chain Lightning', -0.087),
      statsRow('goblin', 'Goblin Guide', 0.15),
      statsRow('mountain', 'Mountain', 0),
      statsRow('pyro', 'Pyroblast', -0.02),
    ],
  });

export const banState = (overrides: Partial<Parameters<typeof banStateSchema.parse>[0]> = {}) =>
  banStateSchema.parse({
    list: [{ oracleId: 'pyro', name: 'Pyroblast', status: 'restricted' }],
    history: [
      {
        oracleId: 'pyro',
        action: 'restrict',
        note: 'sideboard only',
        by: 'operator',
        at: '2026-01-01T00:00:00Z',
        appliedAfterGameId: '7:cycle-2:start',
      },
    ],
    playing: false,
    legalisations: [
      {
        agent: 'B',
        generation: 1,
        cycle: 2,
        removed: [{ oracleId: 'pyro', zone: 'side', count: 14 }],
        added: [{ oracleId: 'forest', zone: 'side', count: 14 }],
      },
    ],
    ...overrides,
  });

export const cycleDetail = (number: number) =>
  cycleDetailSchema.parse({
    ...cycles[number - 1],
    status: 'finished',
    decks: runDetail.decks,
    changed:
      number === 2
        ? {
            agent: 'A',
            generation: 1,
            cycle: 2,
            cause: 'change',
            deck: deckA,
            change: {
              shape: 'replace',
              remove: { oracleId: 'shock', zone: 'main', count: 4 },
              add: { oracleId: 'chain', zone: 'main', count: 4 },
              reason: 'Cut 4 Shock for 4 Chain Lightning — Shock was dead in hand',
              evidence: {
                diagnosis: 'weakest',
                deck: {
                  games: 20,
                  winRate: 0.35,
                  screwRate: 0.1,
                  floodRate: 0.1,
                  colourScrewRate: 0,
                },
                removed: {
                  oracleId: 'shock',
                  name: 'Shock',
                  zone: 'main',
                  count: 4,
                  delta: -0.12,
                  deadInHandRate: 0.4,
                  castRate: 0.5,
                  gamesDrawn: 9,
                  score: -1,
                },
                starvedColour: null,
                candidates: [
                  {
                    oracleId: 'chain',
                    name: 'Chain Lightning',
                    staticScore: 0.9,
                    supported: true,
                    score: 0.8,
                    trial: { matches: 4, winRate: 0.5 },
                  },
                  {
                    oracleId: 'pyro',
                    name: 'Pyroblast',
                    staticScore: 0.4,
                    supported: true,
                    score: null,
                    trial: null,
                  },
                ],
              },
            },
          }
        : null,
    deckStats: { A: deckStats, B: deckStats },
    playDraw: {
      A: { play: { games: 10, wins: 6 }, draw: { games: 10, wins: 5 } },
      B: { play: { games: 10, wins: 5 }, draw: { games: 10, wins: 4 } },
    },
    shown: { A: [], B: [] },
    trialled: number === 2 ? ['chain'] : [],
    matchList: [
      {
        id: `${RUN}:${number}:0`,
        number: 0,
        kind: 'cycle',
        winner: 'A',
        wins: { A: 2, B: 1 },
        games: 3,
      },
    ],
  });

/** `POST /api/cards/lookup`, answered from the fixture cards. */
export const lookup = (body: unknown) => {
  const { oracleIds } = body as { oracleIds: string[] };
  const known = Object.values(cards) as (typeof cards)[keyof typeof cards][];
  return {
    body: {
      cards: oracleIds.flatMap((id) => {
        const card = known.find((each) => each.oracleId === id);
        return card === undefined ? [] : [faceOf(card)];
      }),
    },
  };
};

// --- A game, for the viewer ---

const GAME = 'game-1';

export { GAME };

/** Who each object of the fixture game is: A plays red, B a little blue-red. */
const objects = [
  [1, 'chain', 'A'],
  [2, 'mountain', 'A'],
  [3, 'mountain', 'A'],
  [4, 'goblin', 'A'],
  [5, 'bolt', 'A'],
  [6, 'mountain', 'A'],
  [11, 'forest', 'B'],
  [12, 'forest', 'B'],
  [13, 'shock', 'B'],
  [14, 'pyro', 'B'],
] as const;

/**
 * Three turns: A plays a land and a creature and attacks; B shocks the creature; A casts
 * Chain Lightning, which B counters, then Lightning Bolt, and B concedes. Each body is
 * stamped with the turn and step it happened in, as the engine's emitter does.
 */
const turns: [number, string, GameEventBody[]][] = [
  [
    0,
    'untap',
    [
      {
        type: 'gameStart',
        onPlay: 'A',
        chosenBy: 'B',
        startingLife: 20,
        decks: {
          A: { library: [1, 2, 3], hand: [4, 5, 6] },
          B: { library: [11, 12], hand: [13, 14] },
        } as never,
      },
      { type: 'keep', player: 'A', handSize: 3, bottomed: [] },
      { type: 'keep', player: 'B', handSize: 2, bottomed: [] },
    ],
  ],
  [1, 'untap', [{ type: 'turnStart', activePlayer: 'A' }]],
  [
    1,
    'precombatMain',
    [
      { type: 'stepStart' },
      { type: 'decision', player: 'A', kind: 'priority', chosen: {}, score: 2 },
      { type: 'playLand', player: 'A', object: 6 as never },
      { type: 'moveZone', object: 6 as never, from: 'A:hand', to: 'battlefield', cause: 'play' },
      { type: 'decision', player: 'A', kind: 'priority', chosen: {}, score: 3 },
      { type: 'activate', player: 'A', source: 6 as never, abilityIndex: 0, targets: [] },
      { type: 'tap', object: 6 as never },
      { type: 'cast', player: 'A', object: 4 as never, targets: [] },
      { type: 'putOnStack', object: 4 as never },
      { type: 'resolve', object: 4 as never },
      { type: 'moveZone', object: 4 as never, from: 'stack', to: 'battlefield', cause: 'resolve' },
    ],
  ],
  [
    1,
    'declareAttackers',
    [
      { type: 'stepStart' },
      { type: 'attack', attacker: 4 as never, defender: { kind: 'player', player: 'B' } },
    ],
  ],
  [
    1,
    'combatDamage',
    [
      { type: 'stepStart' },
      {
        type: 'damage',
        source: 4 as never,
        target: { kind: 'player', player: 'B' },
        amount: 2,
        combat: true,
      },
      { type: 'lifeChange', player: 'B', from: 20, to: 18, reason: 'damage' },
    ],
  ],
  [1, 'endCombat', [{ type: 'stepStart' }]],
  [
    2,
    'untap',
    [
      { type: 'turnStart', activePlayer: 'B' },
      { type: 'untap', object: 6 as never },
    ],
  ],
  [2, 'draw', [{ type: 'stepStart' }, { type: 'draw', player: 'B', object: 11 as never }]],
  [
    2,
    'precombatMain',
    [
      { type: 'stepStart' },
      { type: 'decision', player: 'B', kind: 'priority', chosen: {}, score: -1.5 },
      {
        type: 'cast',
        player: 'B',
        object: 13 as never,
        targets: [{ kind: 'object', object: 4 as never }],
      },
      { type: 'putOnStack', object: 13 as never },
      { type: 'resolve', object: 13 as never },
      {
        type: 'damage',
        source: 13 as never,
        target: { kind: 'object', object: 4 as never },
        amount: 2,
        combat: false,
      },
      { type: 'moveZone', object: 13 as never, from: 'stack', to: 'B:graveyard', cause: 'resolve' },
      { type: 'sba', kind: 'creatureLethalDamage', objects: [4 as never] },
      {
        type: 'moveZone',
        object: 4 as never,
        from: 'battlefield',
        to: 'A:graveyard',
        cause: 'stateBasedAction',
      },
    ],
  ],
  [3, 'untap', [{ type: 'turnStart', activePlayer: 'A' }]],
  [3, 'draw', [{ type: 'stepStart' }, { type: 'draw', player: 'A', object: 1 as never }]],
  [
    3,
    'precombatMain',
    [
      { type: 'stepStart' },
      {
        type: 'cast',
        player: 'A',
        object: 1 as never,
        targets: [{ kind: 'player', player: 'B' }],
      },
      { type: 'putOnStack', object: 1 as never },
      {
        type: 'cast',
        player: 'B',
        object: 14 as never,
        targets: [{ kind: 'object', object: 1 as never }],
      },
      { type: 'putOnStack', object: 14 as never },
      { type: 'resolve', object: 14 as never },
      { type: 'counter', object: 1 as never, by: 14 as never },
      { type: 'moveZone', object: 1 as never, from: 'stack', to: 'A:graveyard', cause: 'effect' },
      { type: 'moveZone', object: 14 as never, from: 'stack', to: 'B:graveyard', cause: 'resolve' },
      {
        type: 'cast',
        player: 'A',
        object: 5 as never,
        targets: [{ kind: 'player', player: 'B' }],
      },
      { type: 'putOnStack', object: 5 as never },
      { type: 'resolve', object: 5 as never },
      {
        type: 'damage',
        source: 5 as never,
        target: { kind: 'player', player: 'B' },
        amount: 3,
        combat: false,
      },
      { type: 'lifeChange', player: 'B', from: 18, to: 15, reason: 'damage' },
      { type: 'moveZone', object: 5 as never, from: 'stack', to: 'A:graveyard', cause: 'resolve' },
      { type: 'gameEnd', winner: 'A', reason: 'concede' },
    ],
  ],
];

export const gameEvents: GameEvent[] = turns
  .flatMap(([turn, step, bodies]) => bodies.map((body) => ({ turn, step, ...body }) as GameEvent))
  .map((event, seq) => ({ ...event, seq }));

export const gameObjects = objects.map(([id, oracleId, owner]) => ({
  id: id as never,
  oracleId: oracleId as never,
  owner,
}));

const slots = (player: 'A' | 'B') => {
  const counts = new Map<string, number>();
  for (const [, oracleId, owner] of objects) {
    if (owner === player) counts.set(oracleId, (counts.get(oracleId) ?? 0) + 1);
  }
  return [...counts].map(([oracleId, count]) => ({ oracleId, count }));
};

export const gameLog = gameLogSchema.parse({
  version: 1,
  gameId: GAME,
  seed: `${RUN}:cycle-2:match-0:game-1`,
  players: {
    A: { deckGeneration: 0, main: slots('A'), side: [] },
    B: { deckGeneration: 0, main: slots('B'), side: [] },
  },
  objects: gameObjects,
  events: gameEvents,
  result: { winner: 'A', reason: 'concede', turns: 3 },
});

export const gameDetail = gameDetailSchema.parse({
  id: GAME,
  number: 0,
  seed: gameLog.seed,
  chooser: 'B',
  onPlay: 'A',
  winner: 'A',
  reason: 'concede',
  turns: 3,
  decisions: 4,
  hasLog: true,
  matchId: `${RUN}:2:0`,
  runId: RUN,
  cycle: 2,
});

export const matchDetail = matchDetailSchema.parse({
  id: `${RUN}:2:0`,
  runId: RUN,
  cycle: 2,
  number: 0,
  kind: 'cycle',
  winner: 'A',
  wins: { A: 2, B: 1 },
  games: [gameDetail, { ...gameDetail, id: 'game-2', number: 1, winner: 'B', hasLog: false }].map(
    ({ matchId: _m, runId: _r, cycle: _c, ...game }) => game,
  ),
  sideboarding: null,
});
