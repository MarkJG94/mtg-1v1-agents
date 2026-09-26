import type { CardProjection } from '@mtg/cards';
import {
  type AgentCounts,
  type CycleDetail,
  type CycleSummary,
  cardStats,
  type DeckGeneration,
  type DeckGenerationDto,
  deckStats,
  emptyAgentCounts,
  type GameEventLog,
  type PlayerId,
  type RunSettings,
  type RunStatus,
  rollUp,
  type StatsTable,
  type SupportStatus,
} from '@mtg/shared';
import { unpack } from './compress.js';
import type { OpenDatabase } from './open.js';
import type { SqliteRunStore } from './run-store.js';

/**
 * What the API reads (docs/07; roadmap 6.1), straight from docs/06's tables and shaped as
 * `@mtg/shared`'s DTOs. The run store answers what a run needs to play; this answers what
 * a person asks — lists, pages, one cycle, one match, a card — without loading a whole run
 * to do it. Nothing here writes.
 */

export interface RunRow {
  readonly id: string;
  readonly name: string;
  readonly status: RunStatus;
  readonly seed: string;
  readonly settings: RunSettings;
  readonly createdAt: string;
  readonly forkedFrom: { readonly run: string; readonly cycle: number } | null;
  readonly cycles: number;
  readonly currentCycle: number | null;
  /** A's win rate in each of the last cycles, oldest first. */
  readonly winRates: readonly number[];
  /** The newest change's reason, if a deck has changed. */
  readonly lastChange: string | null;
}

interface RunRecord {
  id: string;
  name: string;
  status: RunStatus;
  seed: string;
  settings: string;
  created_at: string;
  forked_from_run: string | null;
  forked_from_cycle: number | null;
  finished: number;
  running: number | null;
  last_change: string | null;
}

interface CycleRow {
  id: string;
  number: number;
  status: 'running' | 'finished';
  deck_gen_a: number | null;
  deck_gen_b: number | null;
  matches_done: number;
  win_rate_a: number | null;
  win_rate_b: number | null;
  tiebreak: number | null;
  loser: PlayerId | null;
  summary: string | null;
}

interface GameRow {
  id: string;
  match_id: string;
  number: number;
  seed: string;
  chooser: PlayerId;
  on_play: PlayerId;
  winner: PlayerId | null;
  reason: string | null;
  turns: number | null;
  decisions: number;
  has_log: number;
}

const RUNS = `
  SELECT r.*,
    (SELECT count(*) FROM cycles c WHERE c.run_id = r.id AND c.status = 'finished') AS finished,
    (SELECT max(c.number) FROM cycles c WHERE c.run_id = r.id AND c.status = 'running') AS running,
    (SELECT g.change FROM deck_generations g WHERE g.run_id = r.id AND g.cause = 'change'
      ORDER BY g.seq DESC LIMIT 1) AS last_change
  FROM runs r`;

/** How many cycles a run's sparkline shows. */
const SPARKLINE = 40;

const toRun = (row: RunRecord, winRates: readonly number[]): RunRow => ({
  id: row.id,
  name: row.name,
  status: row.status,
  seed: row.seed,
  settings: JSON.parse(row.settings) as RunSettings,
  createdAt: row.created_at,
  forkedFrom:
    row.forked_from_run === null
      ? null
      : { run: row.forked_from_run, cycle: row.forked_from_cycle ?? 0 },
  cycles: row.finished,
  currentCycle: row.running,
  winRates,
  lastChange:
    row.last_change === null ? null : (JSON.parse(row.last_change) as { reason: string }).reason,
});

const toGame = (row: GameRow) => ({
  id: row.id,
  number: row.number,
  seed: row.seed,
  chooser: row.chooser,
  onPlay: row.on_play,
  winner: row.winner,
  reason: row.reason,
  turns: row.turns,
  decisions: row.decisions,
  hasLog: row.has_log === 1,
});

const GAME_COLUMNS = `id, match_id, number, seed, chooser, on_play, winner, reason, turns,
  decisions, event_log IS NOT NULL AS has_log`;

export class Queries {
  constructor(
    private readonly database: OpenDatabase,
    private readonly store: SqliteRunStore,
  ) {}

  private get sqlite() {
    return this.database.sqlite;
  }

  // --- Runs ---

  runs(): RunRow[] {
    return (this.sqlite.prepare(`${RUNS} ORDER BY r.created_at, r.id`).all() as RunRecord[]).map(
      (row) => toRun(row, this.winRates(row.id)),
    );
  }

  run(runId: string): RunRow | null {
    const row = this.sqlite.prepare(`${RUNS} WHERE r.id = ?`).get(runId) as RunRecord | undefined;
    return row === undefined ? null : toRun(row, this.winRates(runId));
  }

  /** A's win rate in each of a run's last cycles, oldest first. */
  private winRates(runId: string): number[] {
    return (
      this.sqlite
        .prepare(
          `SELECT win_rate_a AS rate FROM cycles WHERE run_id = ? AND status = 'finished'
           ORDER BY number DESC LIMIT ?`,
        )
        .all(runId, SPARKLINE) as { rate: number | null }[]
    )
      .map((row) => row.rate ?? 0.5)
      .reverse();
  }

  /** The newest cycle — in progress, or else the last finished — and its matches. */
  progress(runId: string): { cycle: number | null; done: number; planned: number } {
    const row = this.sqlite
      .prepare(
        `SELECT number, matches_done, matches_planned FROM cycles WHERE run_id = ?
         ORDER BY number DESC LIMIT 1`,
      )
      .get(runId) as { number: number; matches_done: number; matches_planned: number } | undefined;
    return row === undefined
      ? { cycle: null, done: 0, planned: 0 }
      : { cycle: row.number, done: row.matches_done, planned: row.matches_planned };
  }

  lineage(runId: string, agent?: PlayerId): DeckGeneration[] {
    const all = this.store.lineage(runId);
    return agent === undefined ? all : all.filter((entry) => entry.agent === agent);
  }

  /** The newest generation of each deck. */
  latest(runId: string): Record<PlayerId, DeckGeneration> | null {
    const newest: Partial<Record<PlayerId, DeckGeneration>> = {};
    for (const entry of this.store.lineage(runId)) {
      const held = newest[entry.agent];
      if (held === undefined || entry.generation > held.generation) newest[entry.agent] = entry;
    }
    return newest.A === undefined || newest.B === undefined ? null : { A: newest.A, B: newest.B };
  }

  bans(runId: string) {
    return this.store.trail(runId);
  }

  // --- Cycles ---

  cyclePage(runId: string, offset: number, limit: number) {
    const { total } = this.sqlite
      .prepare("SELECT count(*) AS total FROM cycles WHERE run_id = ? AND status = 'finished'")
      .get(runId) as { total: number };
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM cycles WHERE run_id = ? AND status = 'finished'
         ORDER BY number LIMIT ? OFFSET ?`,
      )
      .all(runId, limit, offset) as CycleRow[];
    const changes = this.changes(runId);
    return { total, cycles: rows.map((row) => this.summaryOf(row, changes)) };
  }

  lastCycle(runId: string): CycleSummary | null {
    const row = this.sqlite
      .prepare(
        "SELECT * FROM cycles WHERE run_id = ? AND status = 'finished' ORDER BY number DESC LIMIT 1",
      )
      .get(runId) as CycleRow | undefined;
    return row === undefined ? null : this.summaryOf(row, this.changes(runId));
  }

  cycleDetail(runId: string, number: number): CycleDetail | null {
    const row = this.sqlite
      .prepare('SELECT * FROM cycles WHERE run_id = ? AND number = ?')
      .get(runId, number) as CycleRow | undefined;
    const record = this.store.cycle(runId, number);
    if (row === undefined || record === null) return null;
    const lineage = this.store.lineage(runId);
    const at = (agent: PlayerId, generation: number) =>
      lineage.find((entry) => entry.agent === agent && entry.generation === generation);
    const decks = { A: at('A', record.generations.A), B: at('B', record.generations.B) };
    if (decks.A === undefined || decks.B === undefined) return null;
    const changed =
      lineage.find((entry) => entry.cycle === number && entry.cause === 'change') ?? null;
    const summary = this.summaryOf(row, this.changes(runId));
    const matchList = (
      this.sqlite
        .prepare(
          `SELECT m.id, m.number, m.kind, m.winner, m.games_a, m.games_b,
             (SELECT count(*) FROM games g WHERE g.match_id = m.id) AS games
           FROM matches m WHERE m.cycle_id = ? ORDER BY m.number`,
        )
        .all(row.id) as {
        id: string;
        number: number;
        kind: 'cycle' | 'tiebreak' | 'trial';
        winner: PlayerId | null;
        games_a: number;
        games_b: number;
        games: number;
      }[]
    ).map((match) => ({
      id: match.id,
      number: match.number,
      kind: match.kind,
      winner: match.winner,
      wins: { A: match.games_a, B: match.games_b },
      games: match.games,
    }));
    return {
      ...summary,
      status: row.status,
      decks: { A: dto(decks.A), B: dto(decks.B) },
      changed: changed === null ? null : dto(changed),
      deckStats: { A: deckStats(record.stats.A.deck), B: deckStats(record.stats.B.deck) },
      playDraw: record.playDraw,
      shown: { A: [...record.shown.A], B: [...record.shown.B] },
      trialled: Object.keys(record.trials),
      matchList,
    };
  }

  /** The change each cycle made, by cycle number. */
  private changes(runId: string): Map<number, DeckGeneration> {
    const found = new Map<number, DeckGeneration>();
    for (const entry of this.store.lineage(runId)) {
      if (entry.cause === 'change') found.set(entry.cycle, entry);
    }
    return found;
  }

  private summaryOf(row: CycleRow, changes: ReadonlyMap<number, DeckGeneration>): CycleSummary {
    const summary = JSON.parse(row.summary ?? '{}') as {
      decidedBy?: CycleSummary['decidedBy'];
      unchanged?: string | null;
    };
    const change = changes.get(row.number);
    return {
      number: row.number,
      generations: { A: row.deck_gen_a ?? 0, B: row.deck_gen_b ?? 0 },
      matches: row.matches_done,
      tiebreakMatches: row.tiebreak ?? 0,
      winRate: { A: row.win_rate_a ?? 0, B: row.win_rate_b ?? 0 },
      loser: row.loser ?? 'A',
      decidedBy: summary.decidedBy ?? 'winRate',
      change:
        change?.change == null
          ? null
          : {
              agent: change.agent,
              generation: change.generation,
              shape: change.change.shape,
              reason: change.change.reason,
            },
      unchanged: summary.unchanged ?? null,
    };
  }

  // --- Statistics ---

  /**
   * One agent's card statistics: one cycle's games, or every cycle rolled up with docs/05's
   * decay, which is what the deck agent reads. `null` if the run has no such cycle.
   */
  stats(runId: string, agent: PlayerId, cycle?: number): StatsTable | null {
    let counts: AgentCounts;
    if (cycle === undefined) {
      counts = rollUp(this.store.cycleRecords(runId).map((record) => record.stats[agent]));
      if (counts.deck.games === 0) counts = emptyAgentCounts;
    } else {
      const record = this.store.cycle(runId, cycle);
      if (record === null) return null;
      counts = record.stats[agent];
    }
    const deck = deckStats(counts.deck);
    const names = this.names(Object.keys(counts.cards));
    const cards = Object.entries(counts.cards)
      .map(([oracleId, card]) => ({
        oracleId,
        name: names.get(oracleId) ?? null,
        ...cardStats(card, deck.winRate ?? 0.5),
      }))
      .sort((a, b) => a.delta - b.delta || a.oracleId.localeCompare(b.oracleId));
    return { agent, cycle: cycle ?? null, deck, cards };
  }

  // --- Matches and games ---

  match(matchId: string) {
    const row = this.sqlite
      .prepare(
        `SELECT m.*, c.number AS cycle FROM matches m JOIN cycles c ON c.id = m.cycle_id
         WHERE m.id = ?`,
      )
      .get(matchId) as
      | {
          id: string;
          run_id: string;
          cycle: number;
          number: number;
          kind: 'cycle' | 'tiebreak' | 'trial';
          winner: PlayerId | null;
          games_a: number;
          games_b: number;
          sideboarding: string;
        }
      | undefined;
    if (row === undefined) return null;
    const games = (
      this.sqlite
        .prepare(`SELECT ${GAME_COLUMNS} FROM games WHERE match_id = ? ORDER BY number`)
        .all(matchId) as GameRow[]
    ).map(toGame);
    return {
      id: row.id,
      runId: row.run_id,
      cycle: row.cycle,
      number: row.number,
      kind: row.kind,
      winner: row.winner,
      wins: { A: row.games_a, B: row.games_b },
      games,
      sideboarding: JSON.parse(row.sideboarding) as unknown,
    };
  }

  game(gameId: string) {
    const row = this.sqlite
      .prepare(
        `SELECT g.id, g.match_id, g.number, g.seed, g.chooser, g.on_play, g.winner, g.reason,
           g.turns, g.decisions, g.event_log IS NOT NULL AS has_log, m.run_id, c.number AS cycle
         FROM games g JOIN matches m ON m.id = g.match_id JOIN cycles c ON c.id = m.cycle_id
         WHERE g.id = ?`,
      )
      .get(gameId) as (GameRow & { run_id: string; cycle: number }) | undefined;
    if (row === undefined) return null;
    return { ...toGame(row), matchId: row.match_id, runId: row.run_id, cycle: row.cycle };
  }

  /** A game's event log, decoded; `null` if there is no such game or it kept no log. */
  gameLog(gameId: string): GameEventLog | null {
    const row = this.sqlite
      .prepare('SELECT event_log, log_encoding FROM games WHERE id = ?')
      .get(gameId) as { event_log: Buffer | null; log_encoding: string | null } | undefined;
    if (row?.event_log == null || row.log_encoding === null) return null;
    return unpack<GameEventLog>(row.event_log, row.log_encoding);
  }

  // --- Cards ---

  /** The Scryfall data version the catalogue holds, if it holds any. */
  catalogueVersion(): string | null {
    const row = this.sqlite
      .prepare('SELECT scryfall_updated_at AS version FROM cards LIMIT 1')
      .get() as { version: string | null } | undefined;
    return row?.version ?? null;
  }

  /** Card names by oracle id, from the catalogue. */
  names(oracleIds: readonly string[]): Map<string, string> {
    const found = new Map<string, string>();
    const statement = this.sqlite.prepare('SELECT name FROM cards WHERE oracle_id = ?');
    for (const oracleId of new Set(oracleIds)) {
      const row = statement.get(oracleId) as { name: string } | undefined;
      if (row !== undefined) found.set(oracleId, row.name);
    }
    return found;
  }

  /**
   * Name, type line and rules text, each matched as written. The name that is the query
   * comes first, then names that start with it, then names that hold it, then the rest.
   */
  searchCards(q: string, limit: number) {
    const escaped = q.replaceAll(/[\\%_]/g, (c) => `\\${c}`);
    const pattern = `%${escaped}%`;
    const rows = this.sqlite
      .prepare(
        `SELECT c.*, s.status AS support FROM cards c
         LEFT JOIN card_scripts s ON s.oracle_id = c.oracle_id
         WHERE c.name LIKE @p ESCAPE '\\' OR c.type_line LIKE @p ESCAPE '\\'
            OR c.oracle_text LIKE @p ESCAPE '\\'
         ORDER BY (c.name = @q COLLATE NOCASE) DESC, (c.name LIKE @start ESCAPE '\\') DESC,
           (c.name LIKE @p ESCAPE '\\') DESC, c.name LIMIT @limit`,
      )
      .all({ q, start: `${escaped}%`, p: pattern, limit }) as CardRow[];
    return rows.map(summaryOfCard);
  }

  card(oracleId: string) {
    const row = this.sqlite
      .prepare(
        `SELECT c.*, s.status AS support FROM cards c
         LEFT JOIN card_scripts s ON s.oracle_id = c.oracle_id WHERE c.oracle_id = ?`,
      )
      .get(oracleId) as CardRow | undefined;
    if (row === undefined) return null;
    const stats = this.sqlite
      .prepare(
        `SELECT count(DISTINCT run_id) AS runs, coalesce(sum(games), 0) AS games,
           coalesce(sum(games_drawn), 0) AS gamesDrawn, coalesce(sum(wins_drawn), 0) AS winsDrawn,
           coalesce(sum(games_not_drawn), 0) AS gamesNotDrawn,
           coalesce(sum(wins_not_drawn), 0) AS winsNotDrawn
         FROM card_stats WHERE oracle_id = ? AND opponent_deck_gen = '*'`,
      )
      .get(oracleId) as {
      runs: number;
      games: number;
      gamesDrawn: number;
      winsDrawn: number;
      gamesNotDrawn: number;
      winsNotDrawn: number;
    };
    const { requests } = this.sqlite
      .prepare('SELECT count(*) AS requests FROM unsupported_requests WHERE oracle_id = ?')
      .get(oracleId) as { requests: number };
    const script = this.sqlite
      .prepare('SELECT status, source, reasons, updated_at FROM card_scripts WHERE oracle_id = ?')
      .get(oracleId) as
      | {
          status: 'supported' | 'partial' | 'unsupported';
          source: 'hand' | 'auto';
          reasons: string;
          updated_at: string;
        }
      | undefined;
    return {
      ...summaryOfCard(row),
      oracleText: row.oracle_text,
      power: row.power,
      toughness: row.toughness,
      loyalty: row.loyalty,
      keywords: JSON.parse(row.keywords) as string[],
      script:
        script === undefined
          ? null
          : {
              status: script.status,
              source: script.source,
              reasons: JSON.parse(script.reasons) as { check: string; message: string }[],
              updatedAt: script.updated_at,
            },
      stats,
      unsupportedRequests: requests,
    };
  }

  /**
   * A card by the name a person typed: its exact name, whatever the case, or — for a split,
   * adventure or double-faced card — the name of its front face.
   */
  findByName(name: string): { oracleId: string; name: string } | null {
    const exact = this.sqlite
      .prepare(
        'SELECT oracle_id AS oracleId, name FROM cards WHERE name = ? COLLATE NOCASE LIMIT 1',
      )
      .get(name) as { oracleId: string; name: string } | undefined;
    if (exact !== undefined) return exact;
    const face = this.sqlite
      .prepare(
        `SELECT oracle_id AS oracleId, name FROM cards WHERE name LIKE ? ESCAPE '\\'
         ORDER BY name LIMIT 1`,
      )
      .get(`${name.replaceAll(/[\\%_]/g, (c) => `\\${c}`)} // %`) as
      | { oracleId: string; name: string }
      | undefined;
    return face ?? null;
  }

  /** Name, type line and mana value of cards, by oracle id, from the catalogue. */
  facts(
    oracleIds: readonly string[],
  ): Map<string, { name: string; typeLine: string; manaValue: number }> {
    const found = new Map<string, { name: string; typeLine: string; manaValue: number }>();
    const statement = this.sqlite.prepare(
      'SELECT name, type_line AS typeLine, mana_value AS manaValue FROM cards WHERE oracle_id = ?',
    );
    for (const oracleId of new Set(oracleIds)) {
      const row = statement.get(oracleId) as
        | { name: string; typeLine: string; manaValue: number }
        | undefined;
      if (row !== undefined) found.set(oracleId, row);
    }
    return found;
  }

  /** The printing whose image stands for the card, if the catalogue has it. */
  printing(oracleId: string): string | null {
    const row = this.sqlite
      .prepare('SELECT preferred_printing_id AS printing FROM cards WHERE oracle_id = ?')
      .get(oracleId) as { printing: string | null } | undefined;
    return row?.printing ?? null;
  }

  /** The whole Scryfall projection, for scripting a card on request. */
  projection(oracleId: string): CardProjection | null {
    const row = this.sqlite
      .prepare('SELECT projection FROM cards WHERE oracle_id = ?')
      .get(oracleId) as { projection: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.projection) as CardProjection);
  }

  coverage(mostRequested = 25) {
    const { cards } = this.sqlite.prepare('SELECT count(*) AS cards FROM cards').get() as {
      cards: number;
    };
    const counts = this.sqlite
      .prepare('SELECT status, count(*) AS n FROM card_scripts GROUP BY status')
      .all() as { status: 'supported' | 'partial' | 'unsupported'; n: number }[];
    const scripted = { supported: 0, partial: 0, unsupported: 0 };
    for (const { status, n } of counts) scripted[status] = n;
    const requested = this.sqlite
      .prepare(
        `SELECT r.oracle_id AS oracleId, c.name AS name, count(*) AS requests,
           (SELECT reason FROM unsupported_requests l WHERE l.oracle_id = r.oracle_id
            ORDER BY l.id DESC LIMIT 1) AS lastReason
         FROM unsupported_requests r LEFT JOIN cards c ON c.oracle_id = r.oracle_id
         GROUP BY r.oracle_id ORDER BY requests DESC, r.oracle_id LIMIT ?`,
      )
      .all(mostRequested) as {
      oracleId: string;
      name: string | null;
      requests: number;
      lastReason: string;
    }[];
    return { cards, scripted, mostRequested: requested };
  }
}

interface CardRow {
  oracle_id: string;
  name: string;
  mana_cost: string | null;
  mana_value: number;
  color_identity: string;
  type_line: string;
  oracle_text: string;
  power: string | null;
  toughness: string | null;
  loyalty: string | null;
  keywords: string;
  support: 'supported' | 'partial' | 'unsupported' | null;
}

const summaryOfCard = (row: CardRow) => ({
  oracleId: row.oracle_id,
  name: row.name,
  manaCost: row.mana_cost,
  manaValue: row.mana_value,
  typeLine: row.type_line,
  colorIdentity: JSON.parse(row.color_identity) as string[],
  support: (row.support ?? 'unscripted') as SupportStatus,
});

/**
 * A generation as the API sends it: the same data, a copy, without the readonly markers.
 * Not parsed here — the contract tests hold what the routes send to the schema, and a
 * parse on the way out would make them hold the schema to itself.
 */
export const dto = (entry: DeckGeneration): DeckGenerationDto =>
  structuredClone(entry) as unknown as DeckGenerationDto;
