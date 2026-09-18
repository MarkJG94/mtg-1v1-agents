/**
 * Compare a benchmark run against a baseline and fail on a regression (docs/09 "CI").
 *
 * The baseline is the last run recorded on `main`, so what this catches is a change that
 * makes the engine slower than the branch it is about to be merged into. Cases the
 * baseline does not have are reported and ignored: a new case is not a regression.
 *
 * Usage:
 *   pnpm bench:compare <baseline.json> <current.json> [--threshold 20]
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { BenchReport, CaseResult } from '../packages/engine/bench/run.js';

/** docs/09: CI fails on a regression greater than this. */
const DEFAULT_THRESHOLD_PERCENT = 20;

const read = (path: string): BenchReport => {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as BenchReport).version !== 1 ||
    !Array.isArray((parsed as BenchReport).cases)
  ) {
    throw new Error(`${path} is not a benchmark report this version understands`);
  }
  return parsed as BenchReport;
};

/**
 * The median, not the mean: a shared CI runner is noisy, and one game that lost its core
 * to something else on the machine should not read as a regression.
 */
const compare = (
  baseline: readonly CaseResult[],
  current: readonly CaseResult[],
  limit: number,
) => {
  const rows = current.map((result) => {
    const before = baseline.find((candidate) => candidate.name === result.name);
    if (before === undefined) return { name: result.name, before: null, after: result.medianMs };
    const change = ((result.medianMs - before.medianMs) / before.medianMs) * 100;
    return { name: result.name, before: before.medianMs, after: result.medianMs, change };
  });

  const regressions = rows.filter((row) => row.change !== undefined && row.change > limit);
  return { rows, regressions };
};

const main = (): void => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { threshold: { type: 'string' } },
  });

  const [baselinePath, currentPath] = positionals;
  if (baselinePath === undefined || currentPath === undefined) {
    throw new Error('usage: pnpm bench:compare <baseline.json> <current.json>');
  }

  const limit =
    values.threshold === undefined ? DEFAULT_THRESHOLD_PERCENT : Number(values.threshold);
  const current = read(currentPath);

  if (!existsSync(baselinePath)) {
    // The first run on a branch, or the first ever. Nothing to compare against is not a
    // failure; it just means this run becomes the baseline.
    console.log(`no baseline at ${baselinePath}; recording ${currentPath} as the first one`);
    for (const result of current.cases) {
      console.log(`  ${result.name}: ${result.medianMs.toFixed(3)} ms/game`);
    }
    return;
  }

  const baseline = read(baselinePath);
  const { rows, regressions } = compare(baseline.cases, current.cases, limit);

  console.log(`baseline recorded ${baseline.recordedAt} on ${baseline.node}`);
  for (const row of rows) {
    if (row.before === null || row.change === undefined) {
      console.log(`  ${row.name}: ${row.after.toFixed(3)} ms/game (new case, not compared)`);
      continue;
    }
    const direction = row.change >= 0 ? '+' : '';
    console.log(
      `  ${row.name}: ${row.before.toFixed(3)} -> ${row.after.toFixed(3)} ms/game ` +
        `(${direction}${row.change.toFixed(1)}%)`,
    );
  }

  if (regressions.length > 0) {
    console.error(
      `\n${regressions.length} case(s) more than ${limit}% slower than the baseline: ` +
        regressions.map((row) => row.name).join(', '),
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nno case is more than ${limit}% slower than the baseline`);
};

main();
