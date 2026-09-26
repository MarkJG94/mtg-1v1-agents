import { StatisticalDeckAgent } from '@mtg/agents';
import type { CardProjection, ScriptResolver } from '@mtg/cards';
import { type CardDefinition, createRng } from '@mtg/engine';
import {
  type AgentCounts,
  applyDeckChange,
  applyLegalChange,
  type BanEvent,
  banViolations,
  type CycleRecord,
  type Deck75,
  type DeckChange,
  type DeckGeneration,
  type GameEventLog,
  type OracleId,
  opponentOf,
  type PlayerId,
  playerIds,
  type RunInfo,
  type RunSettings,
  type RunStatus,
  rollUp,
} from '@mtg/shared';
import { BanRegistry, banEnforcer } from './bans.js';
import { type AgentFactory, agentsAt, runCycle } from './cycle.js';
import { cardCount, cardsIn } from './deck.js';
import type { MatchResult } from './match.js';
import { ScryfallPool } from './pool.js';
import { generateSeedDeck } from './seed-deck.js';
import { deckCardsFor, sideboardCardsFor } from './sideboard-cards.js';
import { trials } from './trial.js';

/**
 * A run (docs/05 "The cycle", "Run lifecycle"; docs/06 "Resume protocol"; roadmap 5.6):
 * the loop of cycles, each played, judged and followed by the loser's deck change, kept
 * in a `RunStore` so that it survives a crash.
 *
 * **Checkpoints.** A match is written the moment it ends — its result, its games' event
 * logs, any deck a ban legalised during it, and the ban trail as it then stood — in one
 * write; a finished cycle is written with its record and the deck change in another. A
 * crash loses at most the match in progress.
 *
 * **Resume** is loading the run and driving it again. The cycle in progress picks up at
 * its next match, its statistics rebuilt from the stored logs; since every seed is derived
 * from the run's — `${seed}:cycle-${n}`, then `:match-${m}`, `:change`, `:trial` — what it
 * plays is exactly what it would have played had it never stopped. A crash during the
 * deck change replays the change from the same seeds, to the same change.
 *
 * **Bans** asked for during a game take effect when it ends (`banEnforcer`); one asked for
 * between cycles, when no game is in progress, takes effect as the next cycle starts. A
 * deck the list catches out — after a ban, a fork or an import — is legalised then too.
 */

/** One stored match: which cycle, which number in it, and whether it was a tiebreak. */
export interface StoredMatch {
  readonly cycle: number;
  readonly index: number;
  readonly kind: 'cycle' | 'tiebreak';
  readonly match: MatchResult;
  /** Its games' event logs; empty when not asked for (`RunStore.matches`). */
  readonly logs: readonly GameEventLog[];
}

/** Everything needed to show a run or carry it on. */
export interface RunSnapshot {
  readonly run: RunInfo;
  /** Every deck generation of both agents, oldest first. */
  readonly lineage: readonly DeckGeneration[];
  /** The ban list's audit trail, pending edits included. */
  readonly bans: readonly BanEvent[];
  /** Finished cycles, oldest first. */
  readonly cycles: readonly CycleRecord[];
  /** The cycle started and not yet finished, with its matches so far and their logs. */
  readonly current: { readonly number: number; readonly matches: readonly StoredMatch[] } | null;
}

/** Where a run is kept (docs/06). The server's is SQLite; `MemoryRunStore` is for tests. */
export interface RunStore {
  /** A new run: a fresh one, a fork, or an import, with any matches it brings. */
  create(snapshot: RunSnapshot, matches?: readonly StoredMatch[]): Promise<void>;
  load(runId: string): Promise<RunSnapshot | null>;
  status(runId: string): Promise<RunStatus | null>;
  setStatus(runId: string, status: RunStatus): Promise<void>;
  /** Every stored match of the run, oldest first; with their logs if asked. */
  matches(runId: string, withLogs: boolean): Promise<StoredMatch[]>;
  /** The ban trail as it stands — an operator's edit is written as soon as it is asked for. */
  saveBans(runId: string, bans: readonly BanEvent[]): Promise<void>;
  startCycle(runId: string, cycle: number): Promise<void>;
  /** A checkpoint: the match, its logs, the generations a ban made during it, the trail. */
  saveMatch(
    runId: string,
    match: StoredMatch,
    generations: readonly DeckGeneration[],
    bans: readonly BanEvent[],
  ): Promise<void>;
  /** Generations made outside a match: a legalisation as a cycle starts. */
  saveGenerations(
    runId: string,
    generations: readonly DeckGeneration[],
    bans: readonly BanEvent[],
  ): Promise<void>;
  /** The end of a cycle: its record, the deck change it made, the trail. */
  finishCycle(
    runId: string,
    record: CycleRecord,
    generations: readonly DeckGeneration[],
    bans: readonly BanEvent[],
  ): Promise<void>;
}

/** The cards a run draws from: Scryfall's projections, and the resolver that scripts them. */
export interface RunCards {
  readonly pool: readonly CardProjection[];
  readonly resolver: Pick<ScriptResolver, 'resolve'>;
}

export class RunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunError';
  }
}

// --- Creating a run ---

export interface NewRunOptions {
  readonly store: RunStore;
  readonly cards: RunCards;
  readonly id: string;
  readonly name: string;
  readonly settings: RunSettings;
  readonly now: () => string;
  /** docs/05 `seedDeck: fixed`: a pasted 75 in place of the constrained-random one. */
  readonly seedDeck?: Deck75;
  /** An initial ban list, in effect from the start. */
  readonly bans?: readonly BanEvent[];
}

/** A new run: both agents on the same 75 as generation 0 (docs/05). */
export const createRun = async (options: NewRunOptions): Promise<RunSnapshot> => {
  const { settings } = options;
  const registry = new BanRegistry(options.bans ?? []);
  registry.applyPending(`${options.id}:created`);
  const deck =
    options.seedDeck ??
    generateSeedDeck({
      pool: options.cards.pool,
      resolver: options.cards.resolver,
      seed: `${settings.seed}:seed-deck`,
      settings,
      banList: registry.list,
      runId: options.id,
    }).deck;
  if (cardCount(deck.main) !== 60 || cardCount(deck.side) !== 15) {
    throw new RunError('a seed deck is sixty cards and a fifteen-card sideboard');
  }
  const [broken] = banViolations(deck, registry.list);
  if (broken !== undefined) {
    throw new RunError(
      `the seed deck holds ${broken.held} of ${broken.oracleId}, which is ${broken.status}`,
    );
  }
  const seed = (agent: PlayerId): DeckGeneration => ({
    agent,
    generation: 0,
    cycle: 0,
    cause: 'seed',
    deck,
    change: null,
  });
  const snapshot: RunSnapshot = {
    run: {
      id: options.id,
      name: options.name,
      seed: settings.seed,
      settings,
      status: 'created',
      createdAt: options.now(),
      forkedFrom: null,
    },
    lineage: [seed('A'), seed('B')],
    bans: registry.history,
    cycles: [],
    current: null,
  };
  await options.store.create(snapshot);
  return snapshot;
};

// --- Driving a run ---

export interface DriveOptions {
  readonly store: RunStore;
  readonly cards: RunCards;
  readonly runId: string;
  /** Cycles to play at most in this call; the run may pause or stop sooner. */
  readonly cycles: number;
  /** The play agents; the run's `agentLevel` if not given. */
  readonly agents?: AgentFactory;
  /** Told of each cycle as it finishes, with the change it made. */
  readonly onCycle?: (record: CycleRecord, change: DeckGeneration) => void;
}

export interface DriveResult {
  readonly played: number;
  readonly status: RunStatus;
}

/** Thrown out of a checkpoint to stop a run that was paused or stopped mid-cycle. */
class Halted extends Error {}

/**
 * Plays up to `cycles` cycles of a run, resuming the one in progress if there is one. A
 * run that is paused or stopped plays nothing; one paused or stopped while this plays
 * halts after the match in progress.
 */
export const driveRun = async (options: DriveOptions): Promise<DriveResult> => {
  const { store, runId } = options;
  let played = 0;
  let pool: ScryfallPool | null = null;
  while (played < options.cycles) {
    const snapshot = await store.load(runId);
    if (snapshot === null) throw new RunError(`no run ${runId}`);
    const { run } = snapshot;
    if (run.status === 'paused' || run.status === 'stopped') break;
    if (run.status === 'created') await store.setStatus(runId, 'running');
    pool ??= new ScryfallPool(
      options.cards.pool,
      options.cards.resolver,
      run.settings.legalityFilter,
      runId,
    );
    try {
      await playCycle(options, snapshot, pool);
    } catch (error) {
      if (error instanceof Halted) break;
      throw error;
    }
    played += 1;
  }
  return { played, status: (await store.status(runId)) ?? 'stopped' };
};

const playCycle = async (
  options: DriveOptions,
  snapshot: RunSnapshot,
  pool: ScryfallPool,
): Promise<void> => {
  const { store, runId } = options;
  const { run } = snapshot;
  const { settings } = run;
  const number = snapshot.current?.number ?? snapshot.cycles.length + 1;
  const cycleSeed = `${run.seed}:cycle-${number}`;
  const agents = options.agents ?? agentsAt(settings.agentLevel);
  const deckAgent = new StatisticalDeckAgent({
    shortlistSize: settings.shortlistSize,
    trialTopK: settings.trialTopK,
  });
  const registry = new BanRegistry(snapshot.bans);
  const latest = latestGenerations(snapshot.lineage);
  const nextGeneration: Record<PlayerId, number> = {
    A: latest.A.generation + 1,
    B: latest.B.generation + 1,
  };
  const decks: Record<PlayerId, Deck75> = { A: latest.A.deck, B: latest.B.deck };

  const known = new Map<OracleId, CardDefinition>();
  const definitions = () => {
    for (const player of playerIds) {
      for (const oracleId of cardsIn(decks[player]).keys()) {
        if (known.has(oracleId)) continue;
        const definition = pool.definitionOf(oracleId);
        if (definition === null)
          throw new RunError(`${oracleId} is in a deck and cannot be played`);
        known.set(oracleId, definition);
      }
    }
    for (const [oracleId, definition] of pool.definitions()) known.set(oracleId, definition);
    return known;
  };
  const history = (player: PlayerId): AgentCounts =>
    rollUp(snapshot.cycles.map((cycle) => cycle.stats[player]));
  const generation = (
    agent: PlayerId,
    cause: DeckGeneration['cause'],
    change: DeckChange | null,
  ) => {
    const made: DeckGeneration = {
      agent,
      generation: nextGeneration[agent],
      cycle: number,
      cause,
      deck: decks[agent],
      change,
    };
    nextGeneration[agent] += 1;
    return made;
  };
  /** A generation per forced change, each the deck as that change left it. */
  const legalised = (player: PlayerId, changes: readonly DeckChange[]): DeckGeneration[] =>
    changes.map((change) => {
      decks[player] = applyDeckChange(decks[player], change);
      return generation(player, 'ban', change);
    });
  const enforcer = banEnforcer({
    registry,
    agent: deckAgent,
    pool,
    definitions,
    counts: history,
    seed: `${cycleSeed}:bans`,
  });

  if (snapshot.current === null) {
    await store.startCycle(runId, number);
    // Between cycles no game is in progress: a pending edit takes effect now, and a deck
    // the list catches out — after a ban, a fork or an import — is legalised now.
    const caughtOut = playerIds.some(
      (player) => banViolations(decks[player], registry.list).length > 0,
    );
    if (registry.pending.length > 0 || caughtOut) {
      const update = await enforcer({ gameId: `${cycleSeed}:start`, decks });
      const made: DeckGeneration[] = [];
      for (const player of playerIds)
        made.push(...legalised(player, update?.changes[player] ?? []));
      await store.saveGenerations(runId, made, registry.history);
    }
  }

  const generations = { A: nextGeneration.A - 1, B: nextGeneration.B - 1 };
  const completed = snapshot.current?.matches ?? [];
  const result = await runCycle({
    decks,
    definitions: definitions(),
    seed: cycleSeed,
    settings,
    agents,
    ...(snapshot.cycles.length === 0
      ? {}
      : { playDraw: (snapshot.cycles.at(-1) as CycleRecord).playDraw }),
    generations,
    history: { A: history('A'), B: history('B') },
    afterGame: enforcer,
    completed: {
      matches: completed.map((stored) => stored.match),
      logs: completed.flatMap((stored) => stored.logs),
    },
    onMatch: async (match, index, logs) => {
      const made: DeckGeneration[] = [];
      for (const legalisation of match.legalisations) {
        for (const player of playerIds)
          made.push(...legalised(player, legalisation.changes[player]));
      }
      await store.saveMatch(
        runId,
        {
          cycle: number,
          index,
          kind: index < settings.matchesPerCycle ? 'cycle' : 'tiebreak',
          match,
          logs,
        },
        made,
        registry.history,
      );
      if ((await store.status(runId)) !== 'running') throw new Halted();
    },
  });

  // The loser's change (docs/05 "Choosing the change").
  const loser = result.loser;
  const opponent = opponentOf(loser);
  decks.A = result.decks.A;
  decks.B = result.decks.B;
  const all = definitions();
  const trialRunner = trials({
    opponent: result.decks[opponent],
    definitions: () => new Map([...all, ...pool.definitions()]),
    agents,
    matches: settings.trialMatches,
    settings,
    seed: `${cycleSeed}:trial`,
    generations: { candidate: nextGeneration[loser], opponent: nextGeneration[opponent] - 1 },
  });
  const change = await deckAgent.chooseChange({
    deck: result.decks[loser],
    cards: deckCardsFor(definitionsOf(result.decks[loser], all)),
    counts: rollUp([...snapshot.cycles.map((cycle) => cycle.stats[loser]), result.stats[loser]]),
    opponent: {
      seen: result.shown[opponent],
      cards: sideboardCardsFor(
        result.shown[opponent].flatMap((slot) => {
          const definition = all.get(slot.oracleId);
          return definition === undefined ? [] : [definition];
        }),
      ),
    },
    banList: registry.list,
    pool,
    rng: createRng(`${cycleSeed}:change`),
    ...(settings.trialTopK > 0 ? { trial: trialRunner.run } : {}),
    cycleWinRate: result.winRate[loser],
  });
  decks[loser] = applyLegalChange(result.decks[loser], change, registry.list);
  const changed = generation(loser, 'change', change);

  const trialStats: Record<string, AgentCounts> = {};
  for (const candidate of change.evidence.candidates) {
    const counts = trialRunner.countsFor(candidate.oracleId);
    if (counts !== undefined) trialStats[candidate.oracleId] = counts;
  }
  const record: CycleRecord = {
    number,
    generations,
    matches: result.matches.length,
    tiebreakMatches: result.tiebreakMatches,
    winRate: result.winRate,
    loser,
    decidedBy: result.decidedBy,
    playDraw: result.playDraw,
    stats: result.stats,
    shown: result.shown,
    trials: trialStats,
  };
  await store.finishCycle(runId, record, [changed], registry.history);
  options.onCycle?.(record, changed);
};

/** The newest generation of each agent's deck. */
export const latestGenerations = (
  lineage: readonly DeckGeneration[],
): Record<PlayerId, DeckGeneration> => {
  const latest: Partial<Record<PlayerId, DeckGeneration>> = {};
  for (const entry of lineage) {
    const held = latest[entry.agent];
    if (held === undefined || entry.generation > held.generation) latest[entry.agent] = entry;
  }
  if (latest.A === undefined || latest.B === undefined) {
    throw new RunError('a run needs a deck for each agent');
  }
  return { A: latest.A, B: latest.B };
};

const definitionsOf = (
  deck: Deck75,
  known: ReadonlyMap<OracleId, CardDefinition>,
): CardDefinition[] =>
  [...cardsIn(deck).keys()].flatMap((oracleId) => {
    const definition = known.get(oracleId);
    return definition === undefined ? [] : [definition];
  });

// --- Fork, export, import ---

/**
 * A new run from an old one as it stood after `cycle` (docs/05 "Run lifecycle"): its
 * decks and statistics as of that cycle, a fresh seed, and the ban list copied — its
 * whole trail, so a deck a later ban catches out is legalised as the fork's first cycle
 * starts.
 */
export const forkRun = async (options: {
  readonly store: RunStore;
  readonly from: string;
  readonly cycle: number;
  readonly id: string;
  readonly name: string;
  readonly seed: string;
  readonly now: () => string;
}): Promise<RunSnapshot> => {
  const source = await options.store.load(options.from);
  if (source === null) throw new RunError(`no run ${options.from}`);
  if (options.cycle < 0 || options.cycle > source.cycles.length) {
    throw new RunError(
      `run ${options.from} has finished ${source.cycles.length} cycles; it cannot be forked at ${options.cycle}`,
    );
  }
  const snapshot: RunSnapshot = {
    run: {
      ...source.run,
      id: options.id,
      name: options.name,
      seed: options.seed,
      settings: { ...source.run.settings, seed: options.seed },
      status: 'created',
      createdAt: options.now(),
      forkedFrom: { run: options.from, cycle: options.cycle },
    },
    // Every deck made in or before that cycle: its seed decks, changes and legalisations.
    lineage: source.lineage.filter((entry) => entry.cycle <= options.cycle),
    bans: source.bans,
    cycles: source.cycles.filter((cycle) => cycle.number <= options.cycle),
    current: null,
  };
  await options.store.create(snapshot);
  return snapshot;
};

/** docs/05 `export(runId)`: a JSON bundle that `importRun` can recreate the run from. */
export interface RunBundle {
  readonly format: 'mtg-1v1-run';
  readonly version: 1;
  readonly exportedAt: string;
  readonly snapshot: RunSnapshot;
  /** Every stored match; with its games' event logs only if the export asked for them. */
  readonly matches: readonly StoredMatch[];
  /** A plain-text decklist per generation, keyed `A-3`, `B-0`, … (docs/05). */
  readonly decklists: Readonly<Record<string, string>>;
}

export const exportRun = async (options: {
  readonly store: RunStore;
  readonly runId: string;
  readonly logs: boolean;
  readonly now: () => string;
  /** A card's name for the decklists; its oracle id if not given. */
  readonly name?: (oracleId: OracleId) => string;
}): Promise<RunBundle> => {
  const snapshot = await options.store.load(options.runId);
  if (snapshot === null) throw new RunError(`no run ${options.runId}`);
  const name = options.name ?? ((oracleId: OracleId) => oracleId);
  const decklists: Record<string, string> = {};
  for (const entry of snapshot.lineage) {
    decklists[`${entry.agent}-${entry.generation}`] = decklist(entry.deck, name);
  }
  return {
    format: 'mtg-1v1-run',
    version: 1,
    exportedAt: options.now(),
    snapshot,
    matches: await options.store.matches(options.runId, options.logs),
    decklists,
  };
};

/** A run recreated from a bundle under a new id (docs/06 "Export/import"), not yet playing. */
export const importRun = async (options: {
  readonly store: RunStore;
  readonly bundle: RunBundle;
  readonly id: string;
}): Promise<RunSnapshot> => {
  const { bundle } = options;
  if (bundle.format !== 'mtg-1v1-run' || bundle.version !== 1) {
    throw new RunError('not a run bundle this version can read');
  }
  const status: RunStatus = bundle.snapshot.run.status === 'stopped' ? 'stopped' : 'paused';
  const snapshot: RunSnapshot = {
    ...bundle.snapshot,
    run: { ...bundle.snapshot.run, id: options.id, status },
  };
  await options.store.create(snapshot, bundle.matches);
  return snapshot;
};

/** "4 Lightning Bolt" a line, main deck then "Sideboard". */
export const decklist = (deck: Deck75, name: (oracleId: OracleId) => string): string => {
  const lines = (slots: Deck75['main']) =>
    slots
      .map((slot) => ({ count: slot.count, name: name(slot.oracleId) }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((slot) => `${slot.count} ${slot.name}`);
  return [...lines(deck.main), '', 'Sideboard', ...lines(deck.side)].join('\n');
};

// --- An in-memory store ---

/**
 * `RunStore` in memory, with the same behaviour as the SQLite one: everything it hands
 * out is a copy, so a caller cannot change what was stored by changing what it got.
 */
export class MemoryRunStore implements RunStore {
  private readonly runs = new Map<
    string,
    {
      run: RunInfo;
      lineage: DeckGeneration[];
      bans: BanEvent[];
      cycles: CycleRecord[];
      started: number | null;
      matches: StoredMatch[];
    }
  >();

  private get(runId: string) {
    const run = this.runs.get(runId);
    if (run === undefined) throw new RunError(`no run ${runId}`);
    return run;
  }

  async create(snapshot: RunSnapshot, matches: readonly StoredMatch[] = []): Promise<void> {
    if (this.runs.has(snapshot.run.id)) throw new RunError(`run ${snapshot.run.id} exists`);
    this.runs.set(snapshot.run.id, {
      run: copy(snapshot.run),
      lineage: copy([...snapshot.lineage]),
      bans: copy([...snapshot.bans]),
      cycles: copy([...snapshot.cycles]),
      started: snapshot.current?.number ?? null,
      matches: copy([...matches]),
    });
  }

  async load(runId: string): Promise<RunSnapshot | null> {
    const run = this.runs.get(runId);
    if (run === undefined) return null;
    return copy({
      run: run.run,
      lineage: run.lineage,
      bans: run.bans,
      cycles: run.cycles,
      current:
        run.started === null
          ? null
          : {
              number: run.started,
              matches: run.matches.filter((stored) => stored.cycle === run.started),
            },
    });
  }

  async status(runId: string): Promise<RunStatus | null> {
    return this.runs.get(runId)?.run.status ?? null;
  }

  async setStatus(runId: string, status: RunStatus): Promise<void> {
    const run = this.get(runId);
    run.run = { ...run.run, status };
  }

  async matches(runId: string, withLogs: boolean): Promise<StoredMatch[]> {
    return copy(
      this.get(runId).matches.map((stored) => (withLogs ? stored : { ...stored, logs: [] })),
    );
  }

  async saveBans(runId: string, bans: readonly BanEvent[]): Promise<void> {
    this.get(runId).bans = copy([...bans]);
  }

  async startCycle(runId: string, cycle: number): Promise<void> {
    this.get(runId).started = cycle;
  }

  async saveMatch(
    runId: string,
    match: StoredMatch,
    generations: readonly DeckGeneration[],
    bans: readonly BanEvent[],
  ): Promise<void> {
    const run = this.get(runId);
    run.matches.push(copy(match));
    run.lineage.push(...copy([...generations]));
    run.bans = copy([...bans]);
  }

  async saveGenerations(
    runId: string,
    generations: readonly DeckGeneration[],
    bans: readonly BanEvent[],
  ): Promise<void> {
    const run = this.get(runId);
    run.lineage.push(...copy([...generations]));
    run.bans = copy([...bans]);
  }

  async finishCycle(
    runId: string,
    record: CycleRecord,
    generations: readonly DeckGeneration[],
    bans: readonly BanEvent[],
  ): Promise<void> {
    const run = this.get(runId);
    run.cycles.push(copy(record));
    run.lineage.push(...copy([...generations]));
    run.bans = copy([...bans]);
    run.started = null;
  }
}

const copy = <T>(value: T): T => structuredClone(value);
