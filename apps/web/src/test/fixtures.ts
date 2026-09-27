import {
  banStateSchema,
  type CycleSummary,
  cycleDetailSchema,
  cycleSummarySchema,
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
  },
  shock: { oracleId: 'shock', name: 'Shock', manaCost: '{R}', manaValue: 1, typeLine: 'Instant' },
  chain: {
    oracleId: 'chain',
    name: 'Chain Lightning',
    manaCost: '{R}',
    manaValue: 1,
    typeLine: 'Sorcery',
  },
  goblin: {
    oracleId: 'goblin',
    name: 'Goblin Guide',
    manaCost: '{R}',
    manaValue: 1,
    typeLine: 'Creature — Goblin Scout',
  },
  mountain: {
    oracleId: 'mountain',
    name: 'Mountain',
    manaCost: null,
    manaValue: 0,
    typeLine: 'Basic Land — Mountain',
  },
  pyro: { oracleId: 'pyro', name: 'Pyroblast', manaCost: '{R}', manaValue: 1, typeLine: 'Instant' },
  forest: {
    oracleId: 'forest',
    name: 'Forest',
    manaCost: null,
    manaValue: 0,
    typeLine: 'Basic Land — Forest',
  },
} as const;

export const summaryOf = (card: (typeof cards)[keyof typeof cards]) => ({
  ...card,
  colorIdentity: [] as string[],
  support: 'supported' as const,
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
        return card === undefined ? [] : [summaryOf(card)];
      }),
    },
  };
};
