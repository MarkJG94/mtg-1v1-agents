/**
 * Search benchmarks (roadmap 4.8; docs/02 "Performance targets").
 *
 * The engine's own benchmarks (`packages/engine/bench`) price a game with a trivial
 * agent, against docs/02's 5 ms. This prices a game **at the `search` level**, against
 * docs/02's 50 ms: whole games between agents, from the deal to the result, so the
 * number is what the evolution loop will pay per game rather than what one decision
 * costs.
 *
 * - **`search-mirror`** is the case the target is for: both players at `search`, as the
 *   evolution loop plays them.
 * - **`search-vs-greedy`** is the ladder's top rung, one searcher and greedy's baseline.
 *
 * Each game is on a fuzz board (three creatures a side, a 30-card library: the ladder's),
 * seeds fixed, so two runs play the same games and any difference is the machine. Cases
 * are interleaved after a shared warm-up, for the reason the engine's are (see there).
 * A searched decision's own cost is reported too — docs/04 aims for 20 ms or less — timed
 * only where the search had something to choose between.
 *
 * Usage:
 *   pnpm bench:search [--games N] [--json path] [--budget MS]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { greedyAgent, type PlayAgent, searchAgent } from '@mtg/agents';
import { defaultRungBoard, playGame } from '../src/index.js';

/** docs/02: a median game at `search`, on one core. */
const BUDGET_MS = 50;
const WARMUP_GAMES = 5;

interface SearchCase {
  readonly name: string;
  readonly what: string;
  readonly games: number;
  readonly opponent: () => PlayAgent;
}

const CASES: readonly SearchCase[] = [
  {
    name: 'search-mirror',
    what: 'both players at search, as the evolution loop plays them',
    games: 40,
    opponent: () => searchAgent('search'),
  },
  {
    name: 'search-vs-greedy',
    what: 'one searcher against greedy, the ladder top rung',
    games: 40,
    opponent: () => greedyAgent(),
  },
];

/** The shape `pnpm bench:compare` reads, and a searched decision's cost besides. */
export interface SearchCaseResult {
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
  readonly searchedDecisions: number;
  readonly searchedMeanMs: number;
  readonly searchedP99Ms: number;
}

interface Timings {
  readonly times: number[];
  readonly searched: number[];
  decisions: number;
  turns: number;
}

const quantile = (sorted: readonly number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

/** Times the decisions that had more than one thing to choose between. */
const timed = (agent: PlayAgent, into: () => number[]): PlayAgent => ({
  level: agent.level,
  decide: (view, decision, rng, simulator) => {
    const started = performance.now();
    const answer = agent.decide(view, decision, rng, simulator);
    const choosing =
      decision.kind === 'priority'
        ? decision.options.some((option) => option.kind !== 'pass')
        : decision.kind === 'declareAttackers' || decision.kind === 'declareBlockers';
    if (choosing) into().push(performance.now() - started);
    return answer;
  },
});

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

  const timings = new Map<string, Timings>();
  let current: Timings | null = null;
  const searched = () => current?.searched ?? [];
  const players = new Map(
    CASES.map((benchCase) => [
      benchCase.name,
      { searcher: timed(searchAgent('search'), searched), opponent: benchCase.opponent() },
    ]),
  );

  const play = (benchCase: SearchCase, seed: string, i: number) => {
    const pair = players.get(benchCase.name);
    if (pair === undefined) throw new Error(`no players for ${benchCase.name}`);
    // Seats alternate, so neither agent always has the play.
    const agents =
      i % 2 === 0 ? { A: pair.searcher, B: pair.opponent } : { A: pair.opponent, B: pair.searcher };
    return playGame(defaultRungBoard(seed), agents, seed);
  };

  for (const benchCase of CASES) {
    for (let i = 0; i < WARMUP_GAMES; i += 1) play(benchCase, `warmup-${i}`, i);
  }
  for (const benchCase of CASES) {
    timings.set(benchCase.name, { times: [], searched: [], decisions: 0, turns: 0 });
  }

  const gamesFor = (benchCase: SearchCase) => override ?? benchCase.games;
  const most = Math.max(...CASES.map(gamesFor));
  for (let i = 0; i < most; i += 1) {
    for (const benchCase of CASES) {
      if (i >= gamesFor(benchCase)) continue;
      const timing = timings.get(benchCase.name);
      if (timing === undefined) continue;
      current = timing;
      const started = performance.now();
      const game = play(benchCase, `search-${i}`, i);
      timing.times.push(performance.now() - started);
      timing.decisions += game.decisions.length;
      timing.turns += game.state.turn;
      current = null;
    }
  }

  const round = (value: number, places = 3) => Number(value.toFixed(places));
  const results: SearchCaseResult[] = CASES.map((benchCase) => {
    const { times, searched, decisions, turns } = timings.get(benchCase.name) ?? {
      times: [],
      searched: [],
      decisions: 0,
      turns: 0,
    };
    const total = times.reduce((sum, ms) => sum + ms, 0);
    const sorted = [...times].sort((a, b) => a - b);
    const decided = [...searched].sort((a, b) => a - b);
    return {
      name: benchCase.name,
      games: times.length,
      decisions,
      turns,
      meanMs: round(total / times.length),
      medianMs: round(quantile(sorted, 0.5)),
      p95Ms: round(quantile(sorted, 0.95)),
      minMs: round(sorted[0] ?? 0),
      gamesPerSecond: round((times.length / total) * 1000, 1),
      decisionsPerSecond: round((decisions / total) * 1000, 1),
      searchedDecisions: decided.length,
      searchedMeanMs: round(decided.reduce((sum, ms) => sum + ms, 0) / Math.max(1, decided.length)),
      searchedP99Ms: round(quantile(decided, 0.99)),
    };
  });

  for (const benchCase of CASES) console.log(`${benchCase.name}: ${benchCase.what}`);
  console.log('');
  const columns: readonly [string, (result: SearchCaseResult) => string][] = [
    ['case', (result) => result.name],
    ['games', (result) => String(result.games)],
    ['median ms', (result) => result.medianMs.toFixed(1)],
    ['mean ms', (result) => result.meanMs.toFixed(1)],
    ['p95 ms', (result) => result.p95Ms.toFixed(1)],
    ['decisions/game', (result) => (result.decisions / result.games).toFixed(0)],
    ['searched/game', (result) => (result.searchedDecisions / result.games).toFixed(1)],
    ['searched mean ms', (result) => result.searchedMeanMs.toFixed(2)],
    ['searched p99 ms', (result) => result.searchedP99Ms.toFixed(2)],
  ];
  const rows = [
    columns.map(([heading]) => heading),
    ...results.map((result) => columns.map(([, cell]) => cell(result))),
  ];
  const widths = columns.map((_, i) => Math.max(...rows.map((row) => (row[i] ?? '').length)));
  for (const row of rows) console.log(row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  '));

  console.log('');
  for (const result of results) {
    const verdict = result.medianMs <= budgetMs ? 'within' : 'OVER';
    console.log(
      `${result.name}: median ${result.medianMs.toFixed(1)} ms/game, ${verdict} the ${budgetMs} ms budget`,
    );
  }

  if (values.json !== undefined) {
    mkdirSync(dirname(values.json), { recursive: true });
    const report = {
      version: 1,
      recordedAt: new Date().toISOString(),
      node: process.version,
      budgetMs,
      cases: results,
    };
    writeFileSync(values.json, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nwrote ${values.json}`);
  }

  // Only the case the target is written for decides the exit code: the ladder's rung is
  // reported so a change to greedy's side shows, not held to the same number.
  const mirror = results.find((result) => result.name === 'search-mirror');
  if (budgetMs > 0 && mirror !== undefined && mirror.medianMs > budgetMs) {
    console.error(`\nsearch-mirror is over the ${budgetMs} ms budget`);
    process.exitCode = 1;
  }
};

main();
