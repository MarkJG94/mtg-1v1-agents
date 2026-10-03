/**
 * The sanity ladder (docs/09): `search` beats `greedy` beats `random`, each over 500
 * games and each by more than chance allows (one-sided exact binomial, p < 0.001).
 *
 * The unit suite plays the bottom rung at 60 games, where the margin is wide enough to
 * show. The top rung is not wide enough for that — search wins roughly three decided games
 * in five against greedy, which a hundred games cannot tell from luck — so this runs
 * nightly at the size docs/09 asks for, and fails the job if a rung does not hold.
 *
 * It also reports what a searched decision costs, because docs/04 aims for 20 ms or less
 * and the search's budget is counted in engine steps rather than time (a game has to be a
 * pure function of its seed, and a clock is not).
 *
 * Usage:
 *   pnpm ladder [--games 500] [--alpha 0.001]
 */
import { parseArgs } from 'node:util';
import {
  greedyAgent,
  type PlayAgent,
  randomAgent,
  searchAgent,
} from '../packages/agents/src/index.js';
import { playRung } from '../packages/sim/src/index.js';

const { values } = parseArgs({
  options: {
    games: { type: 'string', default: '500' },
    alpha: { type: 'string', default: '0.001' },
  },
});
const games = Number(values.games);
const alpha = Number(values.alpha);

/** Times every decision that had something to search, which is the cost that matters. */
const timed = (agent: PlayAgent) => {
  const costs: number[] = [];
  const wrapped: PlayAgent = {
    level: agent.level,
    decide: (view, decision, rng, simulator) => {
      const start = performance.now();
      const answer = agent.decide(view, decision, rng, simulator);
      if (decision.kind === 'priority' && decision.options.some((o) => o.kind !== 'pass')) {
        costs.push(performance.now() - start);
      }
      return answer;
    },
  };
  return { wrapped, costs };
};

const search = timed(searchAgent('search'));
const rungs = [
  {
    name: 'greedy over random',
    stronger: greedyAgent(),
    weaker: randomAgent,
    seed: 'ladder-greedy',
  },
  {
    name: 'search over greedy',
    stronger: search.wrapped,
    weaker: greedyAgent(),
    seed: 'ladder-search',
  },
];

let failed = false;
console.log(`| rung | wins | losses | draws | p | holds (p < ${alpha}) |`);
console.log('|---|---:|---:|---:|---:|---|');
for (const rung of rungs) {
  const result = playRung({ ...rung, games });
  const holds = result.pValue < alpha;
  failed ||= !holds;
  console.log(
    `| ${rung.name} | ${result.wins} | ${result.losses} | ${result.draws} | ` +
      `${result.pValue.toExponential(2)} | ${holds ? 'yes' : '**no**'} |`,
  );
}

const sorted = [...search.costs].sort((a, b) => a - b);
const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
const mean = sorted.reduce((sum, cost) => sum + cost, 0) / Math.max(1, sorted.length);
console.log(
  `\nsearch: ${sorted.length} searched decisions, mean ${mean.toFixed(2)} ms, ` +
    `p50 ${at(0.5).toFixed(2)} ms, p99 ${at(0.99).toFixed(2)} ms, max ${at(1).toFixed(2)} ms`,
);

if (failed) {
  console.error('\nA rung of the ladder did not hold.');
  process.exit(1);
}
