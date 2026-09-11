import { playGame } from '../src/testing/index.js';
import { blueBlackDeck, CARDS, greenWhiteDeck, redDeck } from '../test/fixtures/cards.js';

/**
 * Engine throughput with the random agent (roadmap 1.14 target: ≤ 5 ms/game median).
 * Run with `pnpm bench`; prints ms/game and decisions/sec. BENCH_GAMES overrides the sample size.
 */
const games = Number(process.env.BENCH_GAMES ?? 200);
const matchups: [string[], string[]][] = [
  [redDeck(), redDeck()],
  [greenWhiteDeck(), blueBlackDeck()],
  [blueBlackDeck(), greenWhiteDeck()],
];

// Warm-up so the JIT has seen the hot paths.
for (let i = 0; i < 20; i++)
  playGame({
    definitions: CARDS,
    decks: { A: matchups[i % 3]![0], B: matchups[i % 3]![1] },
    seed: `warm-${i}`,
  });

const times: number[] = [];
let decisions = 0;
let turns = 0;
const t0 = performance.now();
for (let i = 0; i < games; i++) {
  const [a, b] = matchups[i % matchups.length]!;
  const start = performance.now();
  const r = playGame({ definitions: CARDS, decks: { A: a, B: b }, seed: `bench-${i}` });
  times.push(performance.now() - start);
  decisions += r.decisions;
  turns += r.state.turn;
}
const total = performance.now() - t0;
times.sort((x, y) => x - y);
const median = times[Math.floor(times.length / 2)]!;
const p90 = times[Math.floor(times.length * 0.9)]!;
console.log(
  JSON.stringify(
    {
      games,
      msPerGameMedian: Number(median.toFixed(2)),
      msPerGameP90: Number(p90.toFixed(2)),
      msPerGameMean: Number((total / games).toFixed(2)),
      decisionsPerSec: Math.round(decisions / (total / 1000)),
      avgTurns: Number((turns / games).toFixed(1)),
      avgDecisions: Math.round(decisions / games),
    },
    null,
    2,
  ),
);
