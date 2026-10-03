/**
 * The weight-tuning harness (docs/04 item 1, roadmap 4.7), from the command line.
 *
 * `compare` plays one weights file against another — docs/04's "evaluator A vs B for
 * 1,000 games" — every board from both seats. `climb` hill-climbs from a weights file one
 * term at a time, keeps a step only if it wins by more than chance, and finishes by playing
 * what it found against where it started on seeds no step was judged on. That last match
 * is the one to believe: the steps it kept are the ones their own games flattered.
 *
 * `default` names the checked-in weights (`packages/agents/src/weights/default.json`).
 *
 * Usage:
 *   pnpm tune compare <a.json|default> <b.json|default> [--level greedy] [--games 1000]
 *   pnpm tune climb [--from default] [--level greedy] [--trials 20] [--games 200]
 *                   [--alpha 0.05] [--factor 1.25] [--confirm 1000] [--terms a,b]
 *                   [--seed tune] [--out tuned.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  defaultWeights,
  parseWeights,
  tunableTerms,
  type Weights,
} from '../packages/agents/src/index.js';
import {
  compareWeights,
  hillClimb,
  type RungResult,
  type TuningLevel,
} from '../packages/sim/src/index.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    level: { type: 'string', default: 'greedy' },
    games: { type: 'string' },
    seed: { type: 'string', default: 'tune' },
    from: { type: 'string', default: 'default' },
    trials: { type: 'string', default: '20' },
    alpha: { type: 'string', default: '0.05' },
    factor: { type: 'string', default: '1.25' },
    confirm: { type: 'string', default: '1000' },
    terms: { type: 'string' },
    out: { type: 'string' },
  },
});

const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

const level = values.level as TuningLevel;
if (!['greedy', 'search', 'deep'].includes(level)) fail(`unknown level "${values.level}"`);

const even = (text: string, name: string): number => {
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0 || n % 2 !== 0) {
    fail(`--${name} must be a positive even number, since every board is played from both seats`);
  }
  return n;
};

const load = (path: string): Weights =>
  path === 'default' ? defaultWeights : parseWeights(JSON.parse(readFileSync(path, 'utf8')));

const line = (result: RungResult) =>
  `${result.wins}–${result.losses}, ${result.draws} drawn, one-sided p = ${result.pValue.toExponential(2)}`;

const [mode, ...rest] = positionals;
const started = performance.now();

if (mode === 'compare') {
  const [a, b] = rest;
  if (a === undefined || b === undefined) fail('compare needs two weights files');
  const games = even(values.games ?? '1000', 'games');
  const result = compareWeights({
    challenger: load(a as string),
    incumbent: load(b as string),
    level,
    games,
    seed: values.seed,
  });
  console.log(`${a} against ${b}, ${games} games at ${level}: ${line(result)}`);
} else if (mode === 'climb') {
  const terms = values.terms?.split(',') ?? tunableTerms;
  for (const term of terms) {
    if (!(tunableTerms as readonly string[]).includes(term))
      fail(`"${term}" is not a tunable term`);
  }
  const start = load(values.from);
  console.log('| step | term | move | won–lost–drawn | p | |');
  console.log('|---:|---|---|---|---:|---|');
  const climb = hillClimb({
    start,
    level,
    seed: values.seed,
    trials: Number(values.trials),
    gamesPerTrial: even(values.games ?? '200', 'games'),
    alpha: Number(values.alpha),
    factor: Number(values.factor),
    confirmGames: even(values.confirm, 'confirm'),
    terms: terms as readonly (keyof Weights)[],
    observe: (trial) =>
      console.log(
        `| ${trial.index} | ${trial.term} | ${trial.from} → ${trial.to} | ` +
          `${trial.result.wins}–${trial.result.losses}–${trial.result.draws} | ` +
          `${trial.result.pValue.toExponential(2)} | ${trial.accepted ? '**kept**' : ''} |`,
      ),
  });

  const changed = tunableTerms.filter((term) => climb.weights[term] !== start[term]);
  console.log(
    `\n${climb.trials.filter((t) => t.accepted).length} of ${climb.trials.length} steps kept` +
      (climb.converged ? '; every move from the result was tried and refused.' : '.'),
  );
  for (const term of changed) console.log(`  ${term}: ${start[term]} → ${climb.weights[term]}`);
  if (climb.confirmation === null) {
    console.log('Nothing was kept, so there is nothing to confirm.');
  } else {
    console.log(
      `Held out, against the start (${climb.confirmation.seed}): ${line(climb.confirmation)}`,
    );
  }
  if (values.out !== undefined) {
    writeFileSync(values.out, `${JSON.stringify(climb.weights, null, 2)}\n`);
    console.log(`Wrote ${values.out}.`);
  }
} else {
  fail('usage: pnpm tune compare <a> <b> | pnpm tune climb [options]');
}

console.log(`(${((performance.now() - started) / 1000).toFixed(1)} s)`);
