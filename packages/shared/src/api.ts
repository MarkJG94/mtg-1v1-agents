import { z } from 'zod';
import { banActions } from './bans.js';
import type { GameEvent } from './eventlog/events.js';
import { deckCauses, runStatuses } from './run.js';
import { agentLevels, runSettingsSchema, seedSchema } from './settings.js';

/**
 * The HTTP API's data (docs/07; roadmap 6.1): every request body, query and response as a
 * zod schema, shared by the server, which parses requests with them and whose contract
 * tests hold every response to them, and the web app, which reads with them. A response
 * type is the schema's output, so the two ends cannot disagree about a field without a
 * test noticing.
 */

// --- Shared pieces ---

const oracleId = z.string().min(1);
const agent = z.enum(['A', 'B']);
const byAgent = <T extends z.ZodType>(schema: T) => z.object({ A: schema, B: schema });
const rate = z.number().nullable();

export const deckSlotSchema = z.object({ oracleId, count: z.int().min(1) });
export const deck75Schema = z.object({
  main: z.array(deckSlotSchema),
  side: z.array(deckSlotSchema),
});

const deckChangeSlotSchema = z.object({
  oracleId,
  zone: z.enum(['main', 'side']),
  count: z.int().min(1),
});

export const deckChangeSchema = z.object({
  shape: z.enum(['replace', 'swap']),
  remove: deckChangeSlotSchema,
  add: deckChangeSlotSchema,
  reason: z.string(),
  evidence: z.object({
    diagnosis: z.string(),
    deck: z.object({
      games: z.number(),
      winRate: rate,
      screwRate: rate,
      floodRate: rate,
      colourScrewRate: rate,
    }),
    removed: z.object({
      oracleId,
      name: z.string(),
      zone: z.enum(['main', 'side']),
      count: z.number(),
      delta: z.number(),
      deadInHandRate: rate,
      castRate: rate,
      gamesDrawn: z.number(),
      score: z.number(),
    }),
    starvedColour: z.string().nullable(),
    candidates: z.array(
      z.object({
        oracleId,
        name: z.string(),
        staticScore: z.number(),
        supported: z.boolean().nullable(),
        score: z.number().nullable(),
        trial: z.object({ matches: z.number(), winRate: z.number() }).nullable(),
      }),
    ),
  }),
});

export const deckGenerationSchema = z.object({
  agent,
  generation: z.int().min(0),
  cycle: z.int().min(0),
  cause: z.enum(deckCauses),
  deck: deck75Schema,
  change: deckChangeSchema.nullable(),
});
export type DeckGenerationDto = z.infer<typeof deckGenerationSchema>;

export const banEventSchema = z.object({
  oracleId,
  action: z.enum(banActions),
  note: z.string(),
  by: z.string(),
  at: z.string(),
  appliedAfterGameId: z.string().nullable(),
});

export const banEntrySchema = z.object({
  oracleId,
  name: z.string().nullable(),
  status: z.enum(['banned', 'restricted']),
});

// --- Errors ---

/** docs/07: `{ error: { code, message, details? } }`, with a status code to match. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

// --- Health ---

export const healthSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  simWorkers: z.int(),
  runsPlaying: z.int(),
  runsWaiting: z.int(),
  /** The database file's size, WAL included; `null` before it exists. */
  databaseBytes: z.int().min(0).nullable(),
  /** The Scryfall data the card catalogue was loaded from; `null` if none was. */
  scryfallVersion: z.string().nullable(),
  uptimeSeconds: z.int(),
});
export type HealthResponse = z.infer<typeof healthSchema>;

// --- Runs ---

/** Settings as a request gives them: all but the seed default, and the seed is chosen if absent. */
export const runSettingsRequestSchema = runSettingsSchema.extend({ seed: seedSchema.optional() });

/** A ban in effect from a run's start (docs/08 "New run": an initial ban list). */
export const initialBanSchema = z.object({
  oracleId,
  status: z.enum(['banned', 'restricted']),
  note: z.string().max(1000).default(''),
});

export const createRunRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
  settings: runSettingsRequestSchema.prefault({}),
  /** docs/05 `seedDeck: fixed`: a pasted 75 in place of the rolled one. */
  seedDeck: deck75Schema.optional(),
  bans: z.array(initialBanSchema).max(500).default([]),
});
export type CreateRunRequest = z.input<typeof createRunRequestSchema>;

export const startRunRequestSchema = z.object({
  /** Cycles to play before pausing; without it, until paused or stopped. */
  cycles: z.int().min(1).max(1_000_000).optional(),
});

export const forkRunRequestSchema = z.object({
  cycle: z.int().min(0),
  name: z.string().trim().min(1).max(200).optional(),
  seed: seedSchema.optional(),
});

export const runSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(runStatuses),
  seed: z.string(),
  agentLevel: z.enum(agentLevels),
  createdAt: z.string(),
  forkedFrom: z.object({ run: z.string(), cycle: z.int() }).nullable(),
  /** Cycles finished. */
  cycles: z.int().min(0),
  /** The cycle in progress, if one is. */
  currentCycle: z.int().nullable(),
  /** On a worker now. */
  playing: z.boolean(),
  /** A's win rate in each of the last cycles, oldest first, for a sparkline. */
  winRates: z.array(z.number()),
  /** The newest change's reason, if a deck has changed. */
  lastChange: z.string().nullable(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

export const runListSchema = z.object({ runs: z.array(runSummarySchema) });

export const runDetailSchema = runSummarySchema.extend({
  settings: runSettingsSchema,
  bans: z.array(banEntrySchema),
  /** The newest generation of each deck. */
  decks: byAgent(deckGenerationSchema),
  /** The newest finished cycle, if any. */
  lastCycle: z.lazy(() => cycleSummarySchema).nullable(),
});
export type RunDetail = z.infer<typeof runDetailSchema>;

// --- Cycles ---

export const paginationSchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export const cycleSummarySchema = z.object({
  number: z.int().min(1),
  generations: byAgent(z.int().min(0)),
  matches: z.int().min(0),
  tiebreakMatches: z.int().min(0),
  winRate: byAgent(z.number()),
  loser: agent,
  decidedBy: z.enum(['winRate', 'tiebreak', 'coinFlip']),
  /** The loser's change: the generation it made and why. `null` if nothing changed. */
  change: z
    .object({ agent, generation: z.int(), shape: z.enum(['replace', 'swap']), reason: z.string() })
    .nullable(),
  /** Why nothing changed, when nothing did (ADR 0017). */
  unchanged: z.string().nullable(),
});
export type CycleSummary = z.infer<typeof cycleSummarySchema>;

export const cyclePageSchema = z.object({
  total: z.int().min(0),
  offset: z.int().min(0),
  limit: z.int().min(1),
  cycles: z.array(cycleSummarySchema),
});

export const deckStatsSchema = z.object({
  games: z.number(),
  winRate: rate,
  winRateOnPlay: rate,
  winRateOnDraw: rate,
  averageTurns: rate,
  screwRate: rate,
  floodRate: rate,
  colourScrewRate: rate,
});

export const matchSummarySchema = z.object({
  id: z.string(),
  number: z.int().min(0),
  kind: z.enum(['cycle', 'tiebreak', 'trial']),
  winner: agent.nullable(),
  wins: byAgent(z.int().min(0)),
  games: z.int().min(0),
});

export const cycleDetailSchema = cycleSummarySchema.extend({
  status: z.enum(['running', 'finished']),
  /** The decks the cycle began with, and the change it made, with its evidence. */
  decks: byAgent(deckGenerationSchema),
  changed: deckGenerationSchema.nullable(),
  deckStats: byAgent(deckStatsSchema),
  playDraw: byAgent(
    z.object({
      play: z.object({ games: z.number(), wins: z.number() }),
      draw: z.object({ games: z.number(), wins: z.number() }),
    }),
  ),
  shown: byAgent(z.array(deckSlotSchema)),
  /** Candidates that were trialled, by oracle id. */
  trialled: z.array(oracleId),
  matchList: z.array(matchSummarySchema),
});
export type CycleDetail = z.infer<typeof cycleDetailSchema>;

export const lineageSchema = z.object({ agent, generations: z.array(deckGenerationSchema) });

// --- Statistics ---

export const statsQuerySchema = z.object({
  agent,
  /** One cycle's games; without it, every cycle rolled up with decay (docs/05). */
  cycle: z.coerce.number().int().min(1).optional(),
});

export const cardStatsRowSchema = z.object({
  oracleId,
  name: z.string().nullable(),
  games: z.number(),
  gamesDrawn: z.number(),
  gamesNotDrawn: z.number(),
  winRateDrawn: rate,
  winRateNotDrawn: rate,
  delta: z.number(),
  castRate: rate,
  deadInHandRate: rate,
  avgTurnCast: rate,
  impact: rate,
  mulliganBlame: rate,
});

export const statsTableSchema = z.object({
  agent,
  cycle: z.int().nullable(),
  deck: deckStatsSchema,
  cards: z.array(cardStatsRowSchema),
});
export type StatsTable = z.infer<typeof statsTableSchema>;

// --- Bans ---

export const banRequestSchema = z.object({
  status: z.enum(['banned', 'restricted']),
  note: z.string().max(1000).default(''),
  by: z.string().max(200).default('operator'),
});

export const unbanRequestSchema = z.object({
  note: z.string().max(1000).default(''),
  by: z.string().max(200).default('operator'),
});

export const banStateSchema = z.object({
  list: z.array(banEntrySchema),
  history: z.array(banEventSchema),
  /** Whether the run is on a worker, where an edit takes effect after the game in progress. */
  playing: z.boolean(),
});

// --- Export ---

export const exportQuerySchema = z.object({
  logs: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

/** An export bundle, as far as the API checks it; `importRun` checks the rest. */
export const runBundleSchema = z.object({
  format: z.literal('mtg-1v1-run'),
  version: z.literal(1),
  exportedAt: z.string(),
  snapshot: z.object({
    run: z.object({ id: z.string(), name: z.string() }).loose(),
    lineage: z.array(deckGenerationSchema),
    bans: z.array(banEventSchema),
    cycles: z.array(z.object({ number: z.int() }).loose()),
    current: z.object({ number: z.int(), matches: z.array(z.unknown()) }).nullable(),
  }),
  matches: z.array(z.object({ cycle: z.int(), index: z.int() }).loose()),
  decklists: z.record(z.string(), z.string()),
});

// --- Matches and games ---

export const gameSummarySchema = z.object({
  id: z.string(),
  number: z.int().min(0),
  seed: z.string(),
  chooser: agent,
  onPlay: agent,
  winner: agent.nullable(),
  reason: z.string().nullable(),
  turns: z.int().nullable(),
  decisions: z.int().min(0),
  hasLog: z.boolean(),
});

export const matchDetailSchema = z.object({
  id: z.string(),
  runId: z.string(),
  cycle: z.int().min(1),
  number: z.int().min(0),
  kind: z.enum(['cycle', 'tiebreak', 'trial']),
  winner: agent.nullable(),
  wins: byAgent(z.int().min(0)),
  games: z.array(gameSummarySchema),
  sideboarding: z.unknown(),
});

export const gameDetailSchema = gameSummarySchema.extend({
  matchId: z.string(),
  runId: z.string(),
  cycle: z.int().min(1),
});

/** A decoded event log (docs/06 "Event log format"); its events are checked by version. */
export const gameLogSchema = z
  .object({
    version: z.int(),
    gameId: z.string(),
    seed: z.string(),
    players: z.object({ A: z.unknown(), B: z.unknown() }),
    events: z.array(z.unknown()),
  })
  .loose();

// --- Cards ---

export const supportStatuses = ['supported', 'partial', 'unsupported', 'unscripted'] as const;
export type SupportStatus = (typeof supportStatuses)[number];

export const cardSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const cardSummarySchema = z.object({
  oracleId,
  name: z.string(),
  manaCost: z.string().nullable(),
  manaValue: z.number(),
  typeLine: z.string(),
  colorIdentity: z.array(z.string()),
  /** What the script cache says; `unscripted` if nothing has asked yet. */
  support: z.enum(supportStatuses),
});

export type CardSummary = z.infer<typeof cardSummarySchema>;

export const cardSearchSchema = z.object({ cards: z.array(cardSummarySchema) });

export const scriptStatusSchema = z.object({
  status: z.enum(['supported', 'partial', 'unsupported']),
  source: z.enum(['hand', 'auto']),
  reasons: z.array(z.object({ check: z.string(), message: z.string() })),
  updatedAt: z.string(),
});

export const cardDetailSchema = cardSummarySchema.extend({
  oracleText: z.string(),
  power: z.string().nullable(),
  toughness: z.string().nullable(),
  loyalty: z.string().nullable(),
  keywords: z.array(z.string()),
  script: scriptStatusSchema.nullable(),
  /** Its record in every run, every cycle, against every deck: counts added up. */
  stats: z.object({
    runs: z.int().min(0),
    games: z.number(),
    gamesDrawn: z.number(),
    winsDrawn: z.number(),
    gamesNotDrawn: z.number(),
    winsNotDrawn: z.number(),
  }),
  /** How often a run asked for it and could not have it. */
  unsupportedRequests: z.int().min(0),
});

export const scriptResultSchema = z.object({
  oracleId,
  status: z.enum(supportStatuses),
  source: z.enum(['hand', 'auto', 'cache', 'none']),
  reasons: z.array(z.object({ check: z.string(), message: z.string() })),
});

export const coverageSchema = z.object({
  cards: z.int().min(0),
  scripted: z.object({
    supported: z.int().min(0),
    partial: z.int().min(0),
    unsupported: z.int().min(0),
  }),
  mostRequested: z.array(
    z.object({
      oracleId,
      name: z.string().nullable(),
      requests: z.int().min(1),
      lastReason: z.string(),
    }),
  ),
});

// --- WebSocket (docs/07 "WebSocket `/ws`") ---

const subscription = z.discriminatedUnion('to', [
  z.object({ to: z.literal('runs') }),
  z.object({ to: z.literal('run'), runId: z.string().min(1) }),
  z.object({ to: z.literal('game'), runId: z.string().min(1) }),
]);

/**
 * What a client sends: `{ subscribe: 'runs' }`, `{ subscribe: 'run', runId }` or
 * `{ subscribe: 'game', runId }` (the run's live game), and the same with `unsubscribe`.
 */
export const wsClientMessageSchema = z
  .union([
    z.object({ subscribe: z.enum(['runs', 'run', 'game']), runId: z.string().min(1).optional() }),
    z.object({
      unsubscribe: z.enum(['runs', 'run', 'game']),
      runId: z.string().min(1).optional(),
    }),
  ])
  .transform((message, context) => {
    const subscribe = 'subscribe' in message;
    const to = subscribe ? message.subscribe : message.unsubscribe;
    const parsed = subscription.safeParse({ to, runId: message.runId });
    if (!parsed.success) {
      context.addIssue({ code: 'custom', message: `'${to}' needs a runId` });
      return z.NEVER;
    }
    return { subscribe, subscription: parsed.data };
  });
export type WsClientMessage = z.output<typeof wsClientMessageSchema>;
export type WsSubscription = z.infer<typeof subscription>;

/** A `GameEvent` as the wire carries it: checked for its envelope, typed as the engine's. */
const gameEventSchema = z.custom<GameEvent>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { seq?: unknown }).seq === 'number' &&
    typeof (value as { type?: unknown }).type === 'string',
  { message: 'a game event has a seq and a type' },
);

const deckDiffSlot = z.object({ oracleId, zone: z.enum(['main', 'side']), count: z.int().min(1) });

export const wsServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), version: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({
    type: z.literal('runStatus'),
    runId: z.string(),
    name: z.string(),
    status: z.enum(runStatuses),
    playing: z.boolean(),
    /** The cycle in progress, or the last finished. */
    cycle: z.int().nullable(),
    matchesDone: z.int().min(0),
    matchesPlanned: z.int().min(0),
    /** Over the last minute of this server's life; 0 when idle. */
    gamesPerSecond: z.number().min(0),
    /** Seconds until the cycle's planned matches are played, at that rate. */
    etaSeconds: z.number().min(0).nullable(),
  }),
  z.object({ type: z.literal('cycleFinished'), runId: z.string(), cycle: cycleSummarySchema }),
  z.object({
    type: z.literal('deckChanged'),
    runId: z.string(),
    agent,
    generation: z.int().min(0),
    cause: z.enum(deckCauses),
    reason: z.string().nullable(),
    diff: z.object({ removed: z.array(deckDiffSlot), added: z.array(deckDiffSlot) }),
  }),
  z.object({ type: z.literal('banApplied'), runId: z.string(), event: banEventSchema }),
  z.object({
    type: z.literal('gameStart'),
    runId: z.string(),
    seed: z.string(),
    cycle: z.int().nullable(),
    match: z.int().nullable(),
    game: z.int().min(1),
    /** Who chooses to play or draw; the choice itself is one of the game's events. */
    chosenBy: agent,
    decks: byAgent(z.array(deckSlotSchema)),
    generations: byAgent(z.int().min(0)),
    /** True when sent to a viewer joining mid-game, with the events so far to follow. */
    catchUp: z.boolean(),
  }),
  z.object({
    type: z.literal('gameEvents'),
    runId: z.string(),
    seed: z.string(),
    events: z.array(gameEventSchema),
  }),
  z.object({
    type: z.literal('gameEnd'),
    runId: z.string(),
    seed: z.string(),
    onPlay: agent,
    winner: agent.nullable(),
    reason: z.string().nullable(),
    turns: z.int().nullable(),
  }),
  z.object({
    type: z.literal('unsupportedCard'),
    runId: z.string().nullable(),
    oracleId,
    name: z.string().nullable(),
    reason: z.string(),
  }),
]);
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;

// --- The new-run form (docs/08 "New run") ---

/** Roll the seed deck a run with these settings would get, without making the run. */
export const seedDeckRequestSchema = z.object({
  settings: runSettingsRequestSchema.prefault({}),
  bans: z.array(initialBanSchema).max(500).default([]),
});

export const previewCardSchema = z.object({
  oracleId,
  name: z.string(),
  count: z.int().min(1),
  typeLine: z.string(),
  manaValue: z.number(),
  support: z.enum(supportStatuses),
});

export const seedDeckPreviewSchema = z.object({
  /** The seed the deck was rolled from: a run made with it gets this deck. */
  seed: z.string(),
  colours: z.array(z.string()),
  lands: z.int().min(0),
  nonbasicLands: z.int().min(0),
  main: z.array(previewCardSchema),
  side: z.array(previewCardSchema),
  /** Cards drawn and put back because the engine cannot play them. */
  rerolled: z.array(
    z.object({ oracleId, name: z.string(), status: z.string(), section: z.string() }),
  ),
});
export type SeedDeckPreview = z.infer<typeof seedDeckPreviewSchema>;

export const resolveCardsRequestSchema = z.object({
  names: z.array(z.string().trim().min(1).max(200)).min(1).max(250),
  /** Script each card found, so its support is known rather than guessed. */
  script: z.boolean().default(true),
});

export const resolvedCardSchema = z.object({
  /** The name as asked. */
  query: z.string(),
  oracleId: oracleId.nullable(),
  /** The catalogue's name, which may differ in case or be a split card's whole name. */
  name: z.string().nullable(),
  support: z.enum(supportStatuses).nullable(),
});
export type ResolvedCard = z.infer<typeof resolvedCardSchema>;

export const resolveCardsSchema = z.object({ cards: z.array(resolvedCardSchema) });
