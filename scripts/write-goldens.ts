/**
 * `pnpm cards:goldens` — recompute the auto-scripter's golden corpus (docs/09).
 *
 * The test compares the committed file against what the pipeline produces now, and fails
 * when they differ. This is what you run to accept a change: read the diff, satisfy
 * yourself that every card that moved was meant to move, and commit it.
 *
 * `--check` writes nothing and exits non-zero when the file is stale, which is what CI
 * runs through `pnpm check`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { type CardProjection, goldensFor, tally } from '@mtg/cards';

const CORPUS = 'packages/cards/fixtures/corpus.json';
const GOLDENS = 'packages/cards/fixtures/corpus-goldens.json';

const corpus = JSON.parse(readFileSync(CORPUS, 'utf8')) as Record<string, CardProjection>;
const goldens = goldensFor(corpus);
const rendered = `${JSON.stringify(goldens, null, 2)}\n`;

const counts = tally(goldens);
const summary = Object.entries(counts)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([status, count]) => `${count} ${status}`)
  .join(', ');

if (process.argv.includes('--check')) {
  const existing = readFileSync(GOLDENS, 'utf8');
  if (existing !== rendered) {
    console.error(
      `${GOLDENS} is stale: the auto-scripter produces something different now.\n` +
        'Run `pnpm cards:goldens`, read the diff, and commit it if every card that moved ' +
        'was meant to.',
    );
    process.exit(1);
  }
  console.log(`goldens are current: ${summary}`);
} else {
  writeFileSync(GOLDENS, rendered);
  console.log(`wrote ${Object.keys(goldens).length} goldens to ${GOLDENS}: ${summary}`);
}
