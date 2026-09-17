/**
 * `pnpm cards:coverage` — run the auto-scripter over every card and report (docs/03).
 *
 * Reads the projection `pnpm fetch:scryfall` writes, which is one card per line, and
 * streams it: thirty-five thousand projections is not a thing to hold in an array
 * alongside thirty-five thousand emitted scripts.
 *
 * Two outputs, because there are two readers. The JSON is for the nightly workflow, which
 * turns it into an issue. The Markdown is for a person deciding what to teach the parser
 * next, and its useful half is the pattern table rather than the score.
 *
 * `--quick` skips playing each card, which is most of the run's time. The verdict then
 * says only that a script loads and agrees with its printed card, not that the engine
 * survives it — so the report says which kind of run it was, because a number that was
 * measured a different way is not the same number.
 */
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { type CardProjection, measureCoverage, type ParserCoverage } from '@mtg/cards';

const INPUT = 'data/scryfall/cards.jsonl';
const JSON_OUT = 'reports/coverage.json';
const MARKDOWN_OUT = 'reports/coverage.md';

const quick = process.argv.includes('--quick');
const top = Number(argument('--top') ?? 40);

function argument(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at < 0 ? undefined : process.argv[at + 1];
}

/** Every card in the projection, one line at a time. */
const cards = async function* (): AsyncGenerator<CardProjection> {
  const lines = createInterface({
    input: createReadStream(INPUT, 'utf8'),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    if (line.trim().length > 0) yield JSON.parse(line) as CardProjection;
  }
};

/**
 * The report wants an iterable and the file gives an async one, so the cards are collected
 * first. They are projections rather than scripts — about 40 MB — and the alternative is
 * an async version of a function whose whole body is synchronous.
 */
const collect = async (): Promise<readonly CardProjection[]> => {
  const all: CardProjection[] = [];
  for await (const card of cards()) all.push(card);
  return all;
};

const percent = (part: number, whole: number): string =>
  whole === 0 ? '0.0%' : `${((part / whole) * 100).toFixed(1)}%`;

const markdown = (report: ParserCoverage): string => {
  const { counts, patterns } = report;
  const withText = counts.cards - counts.withoutRulesText;

  return [
    '# Auto-scripter coverage',
    '',
    `Run over **${counts.cards.toLocaleString()} cards**${quick ? ' (quick: cards were not played)' : ''}.`,
    '',
    '| | cards | of all |',
    '|---|---:|---:|',
    `| supported | ${counts.supported} | ${percent(counts.supported, counts.cards)} |`,
    `| partial | ${counts.partial} | ${percent(counts.partial, counts.cards)} |`,
    `| unsupported | ${counts.unsupported} | ${percent(counts.unsupported, counts.cards)} |`,
    `| no script at all | ${counts.unscripted} | ${percent(counts.unscripted, counts.cards)} |`,
    '',
    `**${counts.supportedWithText}** of the **${withText.toLocaleString()}** cards that have `,
    `rules text are supported (${percent(counts.supportedWithText, withText)}); the other `,
    `${counts.withoutRulesText.toLocaleString()} have none and are supported without anything `,
    'being read.',
    '',
    `Sentences claimed: **${counts.sentencesClaimed.toLocaleString()}** of `,
    `**${counts.sentences.toLocaleString()}** (${percent(counts.sentencesClaimed, counts.sentences)}).`,
    '',
    '## What to teach it next',
    '',
    'Each row is a template the parser cannot read. **sentences** is how many share its',
    'shape; **finishes** is how many cards have nothing else left unread, so teaching it',
    'is the last thing standing in their way. Work from the second column: a shape on nine',
    'hundred cards that each need three more things taught buys nothing on its own.',
    '',
    '| sentences | finishes | pattern | example |',
    '|---:|---:|---|---|',
    ...patterns.map(
      (pattern) =>
        `| ${pattern.count} | ${pattern.finishes} | \`${pattern.pattern}\` | ${pattern.example.card}: ${pattern.example.sentence.slice(0, 90)} |`,
    ),
    '',
  ].join('\n');
};

const main = async (): Promise<void> => {
  const all = await collect();
  process.stdout.write(`read ${all.length} cards, running…\n`);

  const started = Date.now();
  const report = measureCoverage(all, {
    top,
    skipSmokeTest: quick,
    onProgress: (done) => process.stdout.write(`  ${done} / ${all.length}\r`),
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(0);

  mkdirSync(dirname(JSON_OUT), { recursive: true });
  writeFileSync(JSON_OUT, `${JSON.stringify({ quick, ...report }, null, 2)}\n`);
  writeFileSync(MARKDOWN_OUT, markdown(report));

  const { counts } = report;
  const withText = counts.cards - counts.withoutRulesText;
  console.log(
    `\n${counts.supported} supported, ${counts.partial} partial, ${counts.unsupported} ` +
      `unsupported, ${counts.unscripted} unscripted of ${counts.cards} cards in ${seconds}s\n` +
      `${percent(counts.supported, counts.cards)} of all cards; ` +
      `${percent(counts.supportedWithText, withText)} of the ones with rules text\n` +
      `wrote ${JSON_OUT} and ${MARKDOWN_OUT}`,
  );
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
