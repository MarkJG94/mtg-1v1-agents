import { blob, index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * docs/06's tables, as drizzle declares them (roadmap 5.6). `pnpm db:generate` turns a
 * change here into a migration under `drizzle/`, and `openDatabase` applies them; a test
 * checks the migrated database has exactly the columns declared here.
 *
 * Where these go beyond docs/06 it is to keep what a resume or an export needs:
 * `ban_events.by` (the audit trail's who), `deck_generations.seq` (the order generations
 * were made in), `matches.detail` (the whole match, so a resumed cycle carries on from
 * it), `games.chooser`, and `card_stats` columns for every count `CardCounts` keeps.
 * JSON columns hold `@mtg/shared` types as they are; blobs are compressed JSON, the
 * encoding beside them.
 */

export const cards = sqliteTable('cards', {
  oracleId: text('oracle_id').primaryKey(),
  name: text('name').notNull(),
  manaCost: text('mana_cost'),
  manaValue: real('mana_value').notNull(),
  colors: text('colors').notNull(),
  colorIdentity: text('color_identity').notNull(),
  typeLine: text('type_line').notNull(),
  oracleText: text('oracle_text').notNull(),
  power: text('power'),
  toughness: text('toughness'),
  loyalty: text('loyalty'),
  keywords: text('keywords').notNull(),
  layout: text('layout').notNull(),
  legalBase: integer('legal_base').notNull(),
  preferredPrintingId: text('preferred_printing_id'),
  imageUri: text('image_uri'),
  scryfallUpdatedAt: text('scryfall_updated_at'),
});

export const cardScripts = sqliteTable('card_scripts', {
  oracleId: text('oracle_id').primaryKey(),
  source: text('source', { enum: ['hand', 'auto'] }).notNull(),
  parserVersion: integer('parser_version').notNull(),
  status: text('status', { enum: ['supported', 'partial', 'unsupported'] }).notNull(),
  reasons: text('reasons').notNull(),
  script: text('script').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const unsupportedRequests = sqliteTable(
  'unsupported_requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    oracleId: text('oracle_id').notNull(),
    runId: text('run_id'),
    context: text('context'),
    reason: text('reason').notNull(),
    requestedAt: text('requested_at').notNull(),
  },
  (table) => [index('unsupported_requests_oracle_id').on(table.oracleId)],
);

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: text('status', { enum: ['created', 'running', 'paused', 'stopped'] }).notNull(),
  seed: text('seed').notNull(),
  settings: text('settings').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  forkedFromRun: text('forked_from_run'),
  forkedFromCycle: integer('forked_from_cycle'),
  currentCycle: integer('current_cycle'),
});

export const banList = sqliteTable(
  'ban_list',
  {
    runId: text('run_id').notNull(),
    oracleId: text('oracle_id').notNull(),
    status: text('status', { enum: ['banned', 'restricted'] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.oracleId] })],
);

export const banEvents = sqliteTable('ban_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id').notNull(),
  oracleId: text('oracle_id').notNull(),
  action: text('action', { enum: ['ban', 'restrict', 'unban'] }).notNull(),
  note: text('note').notNull(),
  by: text('by').notNull(),
  at: text('at').notNull(),
  appliedAfterGameId: text('applied_after_game_id'),
});

export const deckGenerations = sqliteTable(
  'deck_generations',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    seq: integer('seq').notNull(),
    agent: text('agent', { enum: ['A', 'B'] }).notNull(),
    generation: integer('generation').notNull(),
    cycle: integer('cycle').notNull(),
    cause: text('cause', { enum: ['seed', 'change', 'ban', 'manual'] }).notNull(),
    main: text('main').notNull(),
    side: text('side').notNull(),
    change: text('change'),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('deck_generations_run').on(table.runId, table.agent, table.generation)],
);

export const cycles = sqliteTable(
  'cycles',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    number: integer('number').notNull(),
    status: text('status', { enum: ['running', 'finished'] }).notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
    deckGenA: integer('deck_gen_a'),
    deckGenB: integer('deck_gen_b'),
    matchesPlanned: integer('matches_planned').notNull(),
    matchesDone: integer('matches_done').notNull(),
    winRateA: real('win_rate_a'),
    winRateB: real('win_rate_b'),
    tiebreak: integer('tiebreak'),
    loser: text('loser', { enum: ['A', 'B'] }),
    summary: text('summary'),
  },
  (table) => [index('cycles_run').on(table.runId, table.number)],
);

export const matches = sqliteTable(
  'matches',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    cycleId: text('cycle_id').notNull(),
    number: integer('number').notNull(),
    kind: text('kind', { enum: ['cycle', 'tiebreak', 'trial'] }).notNull(),
    trialCandidate: text('trial_candidate'),
    winner: text('winner', { enum: ['A', 'B'] }),
    gamesA: integer('games_a').notNull(),
    gamesB: integer('games_b').notNull(),
    sideboarding: text('sideboarding').notNull(),
    detail: blob('detail', { mode: 'buffer' }).notNull(),
    detailEncoding: text('detail_encoding').notNull(),
  },
  (table) => [index('matches_cycle').on(table.cycleId)],
);

export const games = sqliteTable(
  'games',
  {
    id: text('id').primaryKey(),
    matchId: text('match_id').notNull(),
    number: integer('number').notNull(),
    seed: text('seed').notNull(),
    chooser: text('chooser', { enum: ['A', 'B'] }).notNull(),
    onPlay: text('on_play', { enum: ['A', 'B'] }).notNull(),
    winner: text('winner', { enum: ['A', 'B'] }),
    reason: text('reason'),
    turns: integer('turns'),
    decisions: integer('decisions').notNull(),
    durationMs: integer('duration_ms'),
    eventLog: blob('event_log', { mode: 'buffer' }),
    logEncoding: text('log_encoding'),
  },
  (table) => [index('games_match').on(table.matchId)],
);

export const cardStats = sqliteTable(
  'card_stats',
  {
    runId: text('run_id').notNull(),
    cycleId: text('cycle_id').notNull(),
    agent: text('agent', { enum: ['A', 'B'] }).notNull(),
    oracleId: text('oracle_id').notNull(),
    zone: text('zone').notNull(),
    /** `*` for the card's record against every deck; a generation for one matchup. */
    opponentDeckGen: text('opponent_deck_gen').notNull(),
    games: integer('games').notNull(),
    gamesDrawn: integer('games_drawn').notNull(),
    winsDrawn: integer('wins_drawn').notNull(),
    gamesNotDrawn: integer('games_not_drawn').notNull(),
    winsNotDrawn: integer('wins_not_drawn').notNull(),
    castGames: integer('cast_games').notNull(),
    deadInHand: integer('dead_in_hand').notNull(),
    sumTurnCast: integer('sum_turn_cast').notNull(),
    firstCasts: integer('first_casts').notNull(),
    sumImpact: real('sum_impact').notNull(),
    impacts: integer('impacts').notNull(),
    mulliganBlame: integer('mulligan_blame').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.runId,
        table.cycleId,
        table.agent,
        table.oracleId,
        table.zone,
        table.opponentDeckGen,
      ],
    }),
    index('card_stats_run').on(table.runId, table.agent, table.oracleId),
  ],
);
