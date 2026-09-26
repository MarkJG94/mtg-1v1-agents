import {
  type AgentCounts,
  type BanEvent,
  banListOf,
  type CardCounts,
  type CycleRecord,
  type DeckChange,
  type DeckCounts,
  type DeckGeneration,
  type DeckSlot,
  type GameEventLog,
  type MatchupCounts,
  type OracleId,
  type PlayerId,
  playerIds,
  type RunInfo,
  type RunSettings,
  type RunStatus,
} from '@mtg/shared';
import {
  type MatchResult,
  RunError,
  type RunSnapshot,
  type RunStore,
  type StoredMatch,
} from '@mtg/sim';
import { and, asc, eq, sql } from 'drizzle-orm';
import { defaultEncoding, pack, unpack } from './compress.js';
import type { OpenDatabase } from './open.js';
import {
  banEvents,
  banList,
  cardStats,
  cycles,
  deckGenerations,
  games,
  matches,
  runs,
} from './schema.js';

/**
 * A run in SQLite (docs/06; roadmap 5.6): `RunStore` over docs/06's tables. Every write
 * the run driver makes is one transaction — a match with its games, logs, generations and
 * ban trail; a finished cycle with its record, statistics and change — so a crash leaves
 * the database at the last checkpoint and never between two.
 *
 * A cycle's statistics go into `card_stats`, a row per card against every deck (`*`) and
 * one per card per opponent generation for the matchup tallies, where the UI can query
 * them; the deck-level counts, play/draw records, what each deck showed and the trials'
 * statistics are the cycle's `summary`.
 */

/** What a cycle's `summary` holds besides the columns. */
interface CycleSummary {
  readonly decidedBy: CycleRecord['decidedBy'];
  readonly playDraw: CycleRecord['playDraw'];
  readonly shown: CycleRecord['shown'];
  readonly trials: CycleRecord['trials'];
  readonly unchanged?: string | null;
  readonly deck: Readonly<Record<PlayerId, DeckCounts>>;
}

const EVERY_OPPONENT = '*';

export class SqliteRunStore implements RunStore {
  constructor(
    private readonly database: OpenDatabase,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private get db() {
    return this.database.db;
  }

  private transaction(work: () => void): void {
    this.database.sqlite.transaction(work)();
  }

  // --- Writes ---

  async create(snapshot: RunSnapshot, stored: readonly StoredMatch[] = []): Promise<void> {
    const { run } = snapshot;
    if (this.db.select({ id: runs.id }).from(runs).where(eq(runs.id, run.id)).get()) {
      throw new RunError(`run ${run.id} exists`);
    }
    this.transaction(() => {
      this.db
        .insert(runs)
        .values({
          id: run.id,
          name: run.name,
          status: run.status,
          seed: run.seed,
          settings: JSON.stringify(run.settings),
          createdAt: run.createdAt,
          updatedAt: run.createdAt,
          forkedFromRun: run.forkedFrom?.run ?? null,
          forkedFromCycle: run.forkedFrom?.cycle ?? null,
          currentCycle: snapshot.current?.number ?? snapshot.cycles.at(-1)?.number ?? null,
        })
        .run();
      this.insertGenerations(run.id, snapshot.lineage);
      this.replaceBans(run.id, snapshot.bans);
      for (const record of snapshot.cycles) {
        this.insertCycle(run.id, record.number, run.settings, run.createdAt);
      }
      if (snapshot.current !== null) {
        this.insertCycle(run.id, snapshot.current.number, run.settings, run.createdAt);
      }
      // The matches before the records: a finished cycle's count is its record's, not
      // one more for every match written after it.
      for (const match of stored) this.insertMatch(run.id, match);
      for (const record of snapshot.cycles) this.writeFinished(run.id, record);
    });
  }

  async setStatus(runId: string, status: RunStatus): Promise<void> {
    this.db.update(runs).set({ status, updatedAt: this.now() }).where(eq(runs.id, runId)).run();
  }

  async saveBans(runId: string, bans: readonly BanEvent[]): Promise<void> {
    this.transaction(() => this.replaceBans(runId, bans));
  }

  async startCycle(runId: string, cycle: number): Promise<void> {
    this.transaction(() => {
      this.insertCycle(runId, cycle, this.settingsOf(runId), this.now());
      this.db
        .update(runs)
        .set({ currentCycle: cycle, updatedAt: this.now() })
        .where(eq(runs.id, runId))
        .run();
    });
  }

  async saveMatch(
    runId: string,
    match: StoredMatch,
    generations: readonly DeckGeneration[],
    bans: readonly BanEvent[],
  ): Promise<void> {
    this.transaction(() => {
      this.insertMatch(runId, match);
      this.insertGenerations(runId, generations);
      this.replaceBans(runId, bans);
    });
  }

  async saveGenerations(
    runId: string,
    generations: readonly DeckGeneration[],
    bans: readonly BanEvent[],
  ): Promise<void> {
    this.transaction(() => {
      this.insertGenerations(runId, generations);
      this.replaceBans(runId, bans);
    });
  }

  async finishCycle(
    runId: string,
    record: CycleRecord,
    generations: readonly DeckGeneration[],
    bans: readonly BanEvent[],
  ): Promise<void> {
    this.transaction(() => {
      this.writeFinished(runId, record);
      this.insertGenerations(runId, generations);
      this.replaceBans(runId, bans);
      this.db.update(runs).set({ updatedAt: this.now() }).where(eq(runs.id, runId)).run();
    });
  }

  // --- Reads ---

  async status(runId: string): Promise<RunStatus | null> {
    return (
      this.db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)).get()?.status ??
      null
    );
  }

  /** Every run, oldest first: what `GET /api/runs` lists and the server resumes at boot. */
  async list(): Promise<RunInfo[]> {
    return this.db
      .select()
      .from(runs)
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .all()
      .map(runInfoOf);
  }

  async load(runId: string): Promise<RunSnapshot | null> {
    const row = this.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (row === undefined) return null;
    const run = runInfoOf(row);
    const lineage = this.db
      .select()
      .from(deckGenerations)
      .where(eq(deckGenerations.runId, runId))
      .orderBy(asc(deckGenerations.seq))
      .all()
      .map(
        (entry): DeckGeneration => ({
          agent: entry.agent,
          generation: entry.generation,
          cycle: entry.cycle,
          cause: entry.cause,
          deck: {
            main: JSON.parse(entry.main) as DeckSlot[],
            side: JSON.parse(entry.side) as DeckSlot[],
          },
          change: entry.change === null ? null : (JSON.parse(entry.change) as DeckChange),
        }),
      );
    const cycleRows = this.db
      .select()
      .from(cycles)
      .where(eq(cycles.runId, runId))
      .orderBy(asc(cycles.number))
      .all();
    const finished = cycleRows
      .filter((cycle) => cycle.status === 'finished')
      .map((cycle) => this.recordOf(runId, cycle));
    const running = cycleRows.find((cycle) => cycle.status === 'running');
    return {
      run,
      lineage,
      bans: this.bansOf(runId),
      cycles: finished,
      current:
        running === undefined
          ? null
          : {
              number: running.number,
              matches: this.matchesOf(runId, true).filter((m) => m.cycle === running.number),
            },
    };
  }

  async matches(runId: string, withLogs: boolean): Promise<StoredMatch[]> {
    return this.matchesOf(runId, withLogs);
  }

  // --- Plumbing ---

  private settingsOf(runId: string): RunSettings {
    const row = this.db
      .select({ settings: runs.settings })
      .from(runs)
      .where(eq(runs.id, runId))
      .get();
    if (row === undefined) throw new Error(`no run ${runId}`);
    return JSON.parse(row.settings) as RunSettings;
  }

  private insertCycle(runId: string, number: number, settings: RunSettings, at: string): void {
    this.db
      .insert(cycles)
      .values({
        id: cycleId(runId, number),
        runId,
        number,
        status: 'running',
        startedAt: at,
        matchesPlanned: settings.matchesPerCycle,
        matchesDone: 0,
      })
      .run();
  }

  private writeFinished(runId: string, record: CycleRecord): void {
    const summary: CycleSummary = {
      decidedBy: record.decidedBy,
      playDraw: record.playDraw,
      shown: record.shown,
      trials: record.trials,
      unchanged: record.unchanged,
      deck: { A: record.stats.A.deck, B: record.stats.B.deck },
    };
    this.db
      .update(cycles)
      .set({
        status: 'finished',
        finishedAt: this.now(),
        deckGenA: record.generations.A,
        deckGenB: record.generations.B,
        matchesDone: record.matches,
        winRateA: record.winRate.A,
        winRateB: record.winRate.B,
        tiebreak: record.tiebreakMatches,
        loser: record.loser,
        summary: JSON.stringify(summary),
      })
      .where(eq(cycles.id, cycleId(runId, record.number)))
      .run();
    for (const agent of playerIds) {
      for (const row of statRows(
        runId,
        cycleId(runId, record.number),
        agent,
        record.stats[agent],
      )) {
        this.db.insert(cardStats).values(row).run();
      }
    }
  }

  private recordOf(runId: string, row: typeof cycles.$inferSelect): CycleRecord {
    const summary = JSON.parse(row.summary ?? '{}') as CycleSummary;
    const rows = this.db
      .select()
      .from(cardStats)
      .where(and(eq(cardStats.runId, runId), eq(cardStats.cycleId, row.id)))
      .all();
    const stats = (agent: PlayerId): AgentCounts => {
      const cards: Record<OracleId, CardCounts> = {};
      const matchups: Record<number, Record<OracleId, MatchupCounts>> = {};
      for (const stat of rows) {
        if (stat.agent !== agent) continue;
        const oracleId = stat.oracleId as OracleId;
        const drawn = { games: stat.gamesDrawn, wins: stat.winsDrawn };
        const notDrawn = { games: stat.gamesNotDrawn, wins: stat.winsNotDrawn };
        if (stat.opponentDeckGen === EVERY_OPPONENT) {
          cards[oracleId] = {
            games: stat.games,
            drawn,
            notDrawn,
            cast: stat.castGames,
            deadInHand: stat.deadInHand,
            firstCastTurns: stat.sumTurnCast,
            firstCasts: stat.firstCasts,
            impact: stat.sumImpact,
            impacts: stat.impacts,
            mulliganed: stat.mulliganBlame,
          };
        } else {
          const generation = Number(stat.opponentDeckGen);
          matchups[generation] = {
            ...(matchups[generation] ?? {}),
            [oracleId]: { drawn, notDrawn },
          };
        }
      }
      return { deck: summary.deck[agent], cards, matchups };
    };
    return {
      number: row.number,
      generations: { A: row.deckGenA ?? 0, B: row.deckGenB ?? 0 },
      matches: row.matchesDone,
      tiebreakMatches: row.tiebreak ?? 0,
      winRate: { A: row.winRateA ?? 0, B: row.winRateB ?? 0 },
      loser: row.loser ?? 'A',
      decidedBy: summary.decidedBy,
      playDraw: summary.playDraw,
      stats: { A: stats('A'), B: stats('B') },
      shown: summary.shown,
      trials: summary.trials,
      unchanged: summary.unchanged ?? null,
    };
  }

  private insertGenerations(runId: string, generations: readonly DeckGeneration[]): void {
    const last = this.db
      .select({ seq: sql<number | null>`max(${deckGenerations.seq})` })
      .from(deckGenerations)
      .where(eq(deckGenerations.runId, runId))
      .get();
    let seq = (last?.seq ?? -1) + 1;
    for (const entry of generations) {
      this.db
        .insert(deckGenerations)
        .values({
          id: `${runId}:${entry.agent}:${entry.generation}`,
          runId,
          seq,
          agent: entry.agent,
          generation: entry.generation,
          cycle: entry.cycle,
          cause: entry.cause,
          main: JSON.stringify(entry.deck.main),
          side: JSON.stringify(entry.deck.side),
          change: entry.change === null ? null : JSON.stringify(entry.change),
          createdAt: this.now(),
        })
        .run();
      seq += 1;
    }
  }

  private replaceBans(runId: string, bans: readonly BanEvent[]): void {
    this.db.delete(banEvents).where(eq(banEvents.runId, runId)).run();
    for (const event of bans) {
      this.db
        .insert(banEvents)
        .values({
          runId,
          oracleId: event.oracleId,
          action: event.action,
          note: event.note,
          by: event.by,
          at: event.at,
          appliedAfterGameId: event.appliedAfterGameId,
        })
        .run();
    }
    this.db.delete(banList).where(eq(banList.runId, runId)).run();
    for (const [oracleId, status] of banListOf(bans)) {
      this.db.insert(banList).values({ runId, oracleId, status }).run();
    }
  }

  private bansOf(runId: string): BanEvent[] {
    return this.db
      .select()
      .from(banEvents)
      .where(eq(banEvents.runId, runId))
      .orderBy(asc(banEvents.id))
      .all()
      .map((row) => ({
        oracleId: row.oracleId as OracleId,
        action: row.action,
        note: row.note,
        by: row.by,
        at: row.at,
        appliedAfterGameId: row.appliedAfterGameId,
      }));
  }

  private insertMatch(runId: string, stored: StoredMatch): void {
    const id = `${cycleId(runId, stored.cycle)}:${stored.index}`;
    const { match } = stored;
    this.db
      .insert(matches)
      .values({
        id,
        runId,
        cycleId: cycleId(runId, stored.cycle),
        number: stored.index,
        kind: stored.kind,
        trialCandidate: null,
        winner: match.winner,
        gamesA: match.wins.A,
        gamesB: match.wins.B,
        sideboarding: JSON.stringify(match.sideboarding),
        detail: pack(match),
        detailEncoding: defaultEncoding,
      })
      .run();
    match.games.forEach((game, number) => {
      const log = stored.logs[number];
      this.db
        .insert(games)
        .values({
          id: `${id}:${number}`,
          matchId: id,
          number,
          seed: game.seed,
          chooser: game.chooser,
          onPlay: game.onPlay,
          winner: game.result?.winner ?? null,
          reason: game.result?.reason ?? null,
          turns: game.result?.turn ?? null,
          decisions: game.decisions.length,
          eventLog: log === undefined ? null : pack(log),
          logEncoding: log === undefined ? null : defaultEncoding,
        })
        .run();
    });
    this.db
      .update(cycles)
      .set({ matchesDone: sql`${cycles.matchesDone} + 1` })
      .where(eq(cycles.id, cycleId(runId, stored.cycle)))
      .run();
  }

  private matchesOf(runId: string, withLogs: boolean): StoredMatch[] {
    const rows = this.db
      .select({ match: matches, cycle: cycles.number })
      .from(matches)
      .innerJoin(cycles, eq(cycles.id, matches.cycleId))
      .where(eq(matches.runId, runId))
      .orderBy(asc(cycles.number), asc(matches.number))
      .all();
    return rows.map(({ match: row, cycle }) => {
      const logs: GameEventLog[] = [];
      if (withLogs) {
        for (const game of this.db
          .select({ log: games.eventLog, encoding: games.logEncoding })
          .from(games)
          .where(eq(games.matchId, row.id))
          .orderBy(asc(games.number))
          .all()) {
          if (game.log !== null && game.encoding !== null) {
            logs.push(unpack<GameEventLog>(game.log, game.encoding));
          }
        }
      }
      return {
        cycle,
        index: row.number,
        kind: row.kind === 'tiebreak' ? 'tiebreak' : 'cycle',
        match: unpack<MatchResult>(row.detail, row.detailEncoding),
        logs,
      };
    });
  }
}

const cycleId = (runId: string, number: number): string => `${runId}:${number}`;

const runInfoOf = (row: typeof runs.$inferSelect): RunInfo => ({
  id: row.id,
  name: row.name,
  seed: row.seed,
  settings: JSON.parse(row.settings) as RunSettings,
  status: row.status,
  createdAt: row.createdAt,
  forkedFrom:
    row.forkedFromRun === null ? null : { run: row.forkedFromRun, cycle: row.forkedFromCycle ?? 0 },
});

/** A cycle's statistics for one agent as `card_stats` rows. */
const statRows = (
  runId: string,
  cycle: string,
  agent: PlayerId,
  counts: AgentCounts,
): (typeof cardStats.$inferInsert)[] => {
  const base = { runId, cycleId: cycle, agent, zone: 'main' };
  const rows: (typeof cardStats.$inferInsert)[] = [];
  for (const [oracleId, card] of Object.entries(counts.cards)) {
    rows.push({
      ...base,
      oracleId,
      opponentDeckGen: EVERY_OPPONENT,
      games: card.games,
      gamesDrawn: card.drawn.games,
      winsDrawn: card.drawn.wins,
      gamesNotDrawn: card.notDrawn.games,
      winsNotDrawn: card.notDrawn.wins,
      castGames: card.cast,
      deadInHand: card.deadInHand,
      sumTurnCast: card.firstCastTurns,
      firstCasts: card.firstCasts,
      sumImpact: card.impact,
      impacts: card.impacts,
      mulliganBlame: card.mulliganed,
    });
  }
  for (const [generation, byCard] of Object.entries(counts.matchups)) {
    for (const [oracleId, matchup] of Object.entries(byCard)) {
      rows.push({
        ...base,
        oracleId,
        opponentDeckGen: generation,
        games: 0,
        gamesDrawn: matchup.drawn.games,
        winsDrawn: matchup.drawn.wins,
        gamesNotDrawn: matchup.notDrawn.games,
        winsNotDrawn: matchup.notDrawn.wins,
        castGames: 0,
        deadInHand: 0,
        sumTurnCast: 0,
        firstCasts: 0,
        sumImpact: 0,
        impacts: 0,
        mulliganBlame: 0,
      });
    }
  }
  return rows;
};
