/**
 * Engine benchmarks (roadmap 1.14; docs/02 "Performance targets").
 *
 * Plays fixed-seed random games and reports how long each took. The target is a median
 * game inside 5 ms of engine time on one core with a trivial AI, which is what makes the
 * evolution loop's thousands of games per cycle affordable.
 *
 * Three things to know before trusting a number here:
 *
 * - **Games are played, not merely stepped.** Until roadmap 4.2 wired `legalActions` into
 *   the priority decision, nothing was ever cast: a game was the turn loop, priority,
 *   mulligans, combat between the creatures put out at the start, the layer system,
 *   state-based actions and cleanup. A game now draws, plays lands, casts spells, resolves
 *   them and fires their triggers as well, so these numbers are not comparable with any
 *   recorded before 4.2 — the workload is a different and much larger one.
 * - **Invariant checking is off.** `playRandomGame` skips the checks `fuzzGame` makes,
 *   which cost several times what playing the game does and are not engine time.
 * - **The seeds are fixed**, so two runs play exactly the same games and any difference
 *   between them is the machine, not the workload.
 * - **It times the code as built.** `pnpm bench` bundles this file the way tsup builds the
 *   engine and runs the bundle (`scripts/run-bundled.ts`, ADR 0013). Run directly under
 *   `tsx` it reads about a fifth slower, because `tsx` keeps function names and that costs
 *   a call every time a closure is made — which is not engine time.
 *
 * Usage:
 *   pnpm bench [--games N] [--json path] [--budget MS]
 *
 * `pnpm bench` runs this from the repository root, so `--json` is relative to there.
 * Running the package's own `bench` script instead puts the working directory in
 * `packages/engine`, which is where a relative path would then land.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { type FuzzOptions, playRandomGame } from '../src/testing/index.js';

/** docs/02: median game ≤ 5 ms of engine time with a trivial AI, on one core. */
const BUDGET_MS = 5;

/**
 * Discarded games run before any case is timed, so the JIT has settled by the first one.
 *
 * Every case warms every other case, not only itself. Warming case by case meant the
 * first case paid for compiling code that the last three then found already hot, which
 * showed up as the baseline reading slower than a case playing exactly the same games.
 */
const WARMUP_GAMES = 20;

interface BenchCase {
  readonly name: string;
  /** What this case is meant to stress, printed with the results. */
  readonly what: string;
  readonly games: number;
  readonly options: FuzzOptions;
  /**
   * Seeds to play, when they should be another case's rather than this one's own.
   *
   * A case that exists to price one setting has to play the *same games* with it on and
   * off, or it prices the seeds instead. Seeding from the case name meant
   * `no-loop-detection` played two hundred different games from `baseline` and reported
   * the difference between them as the cost of CR 726 hashing — which at one point read
   * as nineteen per cent of a game for a check that, at the default threshold, never ran.
   */
  readonly seedsFrom?: string;
}

const CASES: readonly BenchCase[] = [
  {
    name: 'baseline',
    what: 'three creatures each and a 30-card library',
    games: 200,
    options: { creatures: 3, librarySize: 30 },
  },
  {
    name: 'wide-combat',
    what: 'eight creatures each, so blocks and damage assignment do real work',
    games: 200,
    options: { creatures: 8, librarySize: 30 },
  },
  {
    name: 'long-game',
    what: 'a 60-card library and a high turn cap, so games run long',
    games: 100,
    options: { creatures: 3, librarySize: 60, turnCap: 40 },
  },
  {
    name: 'no-loop-detection',
    what: 'the same games as the baseline without CR 726 hashing, to price it',
    games: 200,
    options: { creatures: 3, librarySize: 30, detectLoops: false },
    seedsFrom: 'baseline',
  },
];

export interface CaseResult {
  readonly name: string;
  readonly games: number;
  readonly decisions: number;
  readonly turns: number;
  readonly meanMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly minMs: number;
  readonly gamesPerSecond: number;
  readonly decisionsPerSecond: number;
}

export interface BenchReport {
  /** Bumped if the shape changes, so an old baseline is rejected rather than misread. */
  readonly version: 1;
  readonly recordedAt: string;
  readonly node: string;
  readonly budgetMs: number;
  readonly cases: readonly CaseResult[];
}

const quantile = (sorted: readonly number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

/** Play every case's shape without timing it, so no case is measured on a cold engine. */
const warmUp = (cases: readonly BenchCase[]): void => {
  for (const benchCase of cases) {
    const seeds = benchCase.seedsFrom ?? benchCase.name;
    for (let i = 0; i < WARMUP_GAMES; i += 1) {
      playRandomGame(`${seeds}:warmup-${i}`, benchCase.options);
    }
  }
};

interface Timings {
  readonly times: number[];
  decisions: number;
  turns: number;
}

/**
 * Play every case's games interleaved, one from each in turn, rather than finishing one
 * case before starting the next.
 *
 * Whichever case goes first pays for a colder process: inline caches, the code cache and
 * the heap all settle as games are played, and running four cases back to back made the
 * first read several per cent slower than the last. That is not a property of the case,
 * and it showed plainly once `no-loop-detection` began playing the baseline's own games
 * and still came out faster than it. Interleaving spreads whatever drift is left evenly
 * over all of them, so the cases can be compared with each other and not only with a
 * recorded baseline.
 */
const runCases = (
  cases: readonly BenchCase[],
  games: (benchCase: BenchCase) => number,
): Map<string, Timings> => {
  const timings = new Map<string, Timings>();
  for (const benchCase of cases) timings.set(benchCase.name, { times: [], decisions: 0, turns: 0 });

  const most = Math.max(...cases.map(games));
  for (let i = 0; i < most; i += 1) {
    for (const benchCase of cases) {
      if (i >= games(benchCase)) continue;
      const timing = timings.get(benchCase.name);
      if (timing === undefined) continue;
      const seeds = benchCase.seedsFrom ?? benchCase.name;

      const started = performance.now();
      const result = playRandomGame(`${seeds}-${i}`, benchCase.options);
      timing.times.push(performance.now() - started);
      timing.decisions += result.decisions.length;
      timing.turns += result.turns;
    }
  }

  return timings;
};

const summarise = (benchCase: BenchCase, timing: Timings): CaseResult => {
  const { times, decisions, turns } = timing;
  const total = times.reduce((sum, ms) => sum + ms, 0);
  const sorted = [...times].sort((a, b) => a - b);

  return {
    name: benchCase.name,
    games: times.length,
    decisions,
    turns,
    meanMs: total / times.length,
    medianMs: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    minMs: sorted[0] ?? 0,
    gamesPerSecond: (times.length / total) * 1000,
    decisionsPerSecond: (decisions / total) * 1000,
  };
};

const round = (value: number, places = 3): number => Number(value.toFixed(places));

const report = (results: readonly CaseResult[], budgetMs: number): void => {
  const columns: readonly [string, (result: CaseResult) => string][] = [
    ['case', (result) => result.name],
    ['games', (result) => String(result.games)],
    ['median ms', (result) => round(result.medianMs).toFixed(3)],
    ['mean ms', (result) => round(result.meanMs).toFixed(3)],
    ['p95 ms', (result) => round(result.p95Ms).toFixed(3)],
    ['games/s', (result) => String(Math.round(result.gamesPerSecond))],
    ['decisions/s', (result) => String(Math.round(result.decisionsPerSecond))],
    ['decisions/game', (result) => (result.decisions / result.games).toFixed(1)],
  ];

  const rows = [
    columns.map(([heading]) => heading),
    ...results.map((result) => columns.map(([, cell]) => cell(result))),
  ];
  const widths = columns.map((_, i) => Math.max(...rows.map((row) => (row[i] ?? '').length)));
  for (const row of rows) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  '));
  }

  if (budgetMs > 0) {
    console.log('');
    for (const result of results) {
      const verdict = result.medianMs <= budgetMs ? 'within' : 'OVER';
      console.log(
        `${result.name}: median ${round(result.medianMs).toFixed(3)} ms/game, ` +
          `${verdict} the ${budgetMs} ms budget`,
      );
    }
  }
};

const main = (): void => {
  const { values } = parseArgs({
    options: {
      games: { type: 'string' },
      json: { type: 'string' },
      budget: { type: 'string' },
    },
  });

  const budgetMs = values.budget === undefined ? BUDGET_MS : Number(values.budget);
  const override = values.games === undefined ? null : Number(values.games);
  if (override !== null && (!Number.isFinite(override) || override < 1)) {
    throw new Error(`--games must be a positive number, got "${values.games}"`);
  }

  warmUp(CASES);
  const gamesFor = (benchCase: BenchCase): number => override ?? benchCase.games;
  const timings = runCases(CASES, gamesFor);
  const results = CASES.map((benchCase) =>
    summarise(benchCase, timings.get(benchCase.name) ?? { times: [], decisions: 0, turns: 0 }),
  );

  for (const benchCase of CASES) console.log(`${benchCase.name}: ${benchCase.what}`);
  console.log('');
  report(results, budgetMs);

  if (values.json !== undefined) {
    const output: BenchReport = {
      version: 1,
      recordedAt: new Date().toISOString(),
      node: process.version,
      budgetMs,
      cases: results.map((result) => ({
        ...result,
        meanMs: round(result.meanMs),
        medianMs: round(result.medianMs),
        p95Ms: round(result.p95Ms),
        minMs: round(result.minMs),
        gamesPerSecond: round(result.gamesPerSecond, 1),
        decisionsPerSecond: round(result.decisionsPerSecond, 1),
      })),
    };
    mkdirSync(dirname(values.json), { recursive: true });
    writeFileSync(values.json, `${JSON.stringify(output, null, 2)}\n`);
    console.log(`\nwrote ${values.json}`);
  }

  const over = results.filter((result) => budgetMs > 0 && result.medianMs > budgetMs);
  if (over.length > 0) {
    console.error(`\n${over.length} case(s) over the ${budgetMs} ms budget`);
    process.exitCode = 1;
  }
};

main();
