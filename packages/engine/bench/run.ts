/**
 * Engine benchmarks (roadmap 1.14; docs/02 "Performance targets").
 *
 * Plays fixed-seed random games and reports how long each took. The target is a median
 * game inside 5 ms of engine time on one core with a trivial AI, which is what makes the
 * evolution loop's thousands of games per cycle affordable.
 *
 * Three things to know before trusting a number here:
 *
 * - **Nothing is cast.** Card definitions arrive in roadmap 2.1, so a game is the turn
 *   loop, priority, mulligans, combat between the creatures put out at the start, the
 *   layer system, state-based actions and cleanup. That is the framework's cost, and the
 *   floor under every real game, but a real game will do more per decision.
 * - **Invariant checking is off.** `playRandomGame` skips the checks `fuzzGame` makes,
 *   which cost several times what playing the game does and are not engine time.
 * - **The seeds are fixed**, so two runs play exactly the same games and any difference
 *   between them is the machine, not the workload.
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

/** Discarded games run before each case, so the JIT has settled by the first timed one. */
const WARMUP_GAMES = 20;

interface BenchCase {
  readonly name: string;
  /** What this case is meant to stress, printed with the results. */
  readonly what: string;
  readonly games: number;
  readonly options: FuzzOptions;
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
    what: 'the baseline without CR 726 hashing, to price it',
    games: 200,
    options: { creatures: 3, librarySize: 30, detectLoops: false },
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

const runCase = (benchCase: BenchCase, games: number): CaseResult => {
  for (let i = 0; i < WARMUP_GAMES; i += 1) {
    playRandomGame(`${benchCase.name}:warmup-${i}`, benchCase.options);
  }

  const times: number[] = [];
  let decisions = 0;
  let turns = 0;

  for (let i = 0; i < games; i += 1) {
    const started = performance.now();
    const result = playRandomGame(`${benchCase.name}-${i}`, benchCase.options);
    times.push(performance.now() - started);
    decisions += result.decisions.length;
    turns += result.turns;
  }

  const total = times.reduce((sum, ms) => sum + ms, 0);
  const sorted = [...times].sort((a, b) => a - b);

  return {
    name: benchCase.name,
    games,
    decisions,
    turns,
    meanMs: total / games,
    medianMs: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    minMs: sorted[0] ?? 0,
    gamesPerSecond: (games / total) * 1000,
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

  const results = CASES.map((benchCase) => runCase(benchCase, override ?? benchCase.games));

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
