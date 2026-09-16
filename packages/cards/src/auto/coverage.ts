import { checkCoverage } from '../checks.js';
import { cardScriptSchema } from '../schema.js';
import type { CardProjection } from '../scryfall.js';
import { validateScript } from '../validate.js';
import { emitScript } from './emit.js';
import { normaliseCard } from './normalise.js';

/**
 * `pnpm cards:coverage` — how much of Magic the auto-scripter can read (docs/03).
 *
 * The number that matters is not one number. A card with no rules text is supported for
 * free, so a headline that mixed those in with the ones that were actually *read* would
 * flatter the parser; the counts below keep them apart. And the point of the run is not
 * the score at all — it is the **top failing patterns**, which is the list of templates to
 * teach next, ranked by how many cards each would unlock.
 *
 * Cards are taken as an iterable so the whole of Scryfall can be streamed off disk a line
 * at a time. Thirty-five thousand card projections is not a thing to hold in an array
 * alongside thirty-five thousand emitted scripts.
 */

export interface CoverageCounts {
  readonly cards: number;
  readonly supported: number;
  readonly partial: number;
  readonly unsupported: number;
  /** No script at all: a card whose type line the engine has no type for. */
  readonly unscripted: number;
  /** Cards with no rules text, which are supported without anything being read. */
  readonly withoutRulesText: number;
  /** Supported cards that actually had text to read, which is the honest headline. */
  readonly supportedWithText: number;
  readonly sentences: number;
  readonly sentencesClaimed: number;
}

export interface FailingPattern {
  /** The generalised shape of the sentences in this bucket. */
  readonly pattern: string;
  readonly count: number;
  readonly example: { readonly card: string; readonly sentence: string };
}

/**
 * Named for the parser rather than for a card: `CoverageReport` in `checks.ts` is one
 * card's sentences, and this is every card's parser.
 */
export interface ParserCoverage {
  readonly counts: CoverageCounts;
  /** The templates to teach next, most cards unlocked first. */
  readonly patterns: readonly FailingPattern[];
}

export interface CoverageOptions {
  /** How many patterns to report. The tail is a very long list of one-offs. */
  readonly top?: number;
  /**
   * Skip playing each card, which is most of the time. The verdict then says only that a
   * script loads and agrees with its card, not that the engine survives it — so a run with
   * this on is a rough number, and the report says which it was.
   */
  readonly skipSmokeTest?: boolean;
  /** Called every so often, so a run over the whole of Scryfall can say where it is. */
  readonly onProgress?: (done: number) => void;
}

export const measureCoverage = (
  cards: Iterable<CardProjection>,
  options: CoverageOptions = {},
): ParserCoverage => {
  const counts = {
    cards: 0,
    supported: 0,
    partial: 0,
    unsupported: 0,
    unscripted: 0,
    withoutRulesText: 0,
    supportedWithText: 0,
    sentences: 0,
    sentencesClaimed: 0,
  };

  const buckets = new Map<string, { count: number; card: string; sentence: string }>();

  for (const card of cards) {
    counts.cards += 1;
    if (counts.cards % 1000 === 0) options.onProgress?.(counts.cards);

    const hasText = card.oracleText.trim().length > 0;
    if (!hasText) counts.withoutRulesText += 1;

    const emitted = emitScript(card);
    if (emitted.script === null) {
      counts.unscripted += 1;
      continue;
    }

    const verdict = validateScript(emitted.script, card, {
      skipSmokeTest: options.skipSmokeTest ?? false,
    });
    if (verdict.status === 'supported') {
      counts.supported += 1;
      if (hasText) counts.supportedWithText += 1;
    } else if (verdict.status === 'partial') counts.partial += 1;
    else counts.unsupported += 1;

    const read = sentenceCoverage(emitted.script, card);
    counts.sentences += read.total;
    counts.sentencesClaimed += read.total - read.unread.length;

    for (const unread of read.unread) {
      const pattern = patternOf(unread);
      const bucket = buckets.get(pattern);
      if (bucket === undefined) {
        buckets.set(pattern, { count: 1, card: card.name, sentence: unread });
      } else {
        bucket.count += 1;
      }
    }
  }

  const patterns = [...buckets]
    .map(([pattern, bucket]) => ({
      pattern,
      count: bucket.count,
      example: { card: bucket.card, sentence: bucket.sentence },
    }))
    // By count, and by pattern where counts tie, so two runs over the same data agree.
    .sort((left, right) => right.count - left.count || left.pattern.localeCompare(right.pattern))
    .slice(0, options.top ?? 40);

  return { counts, patterns };
};

// --- What was not read ---

/**
 * How much of a card's text the script claimed, and which sentences it did not.
 *
 * The unread ones come back as the *normalised* text rather than the printed text: the
 * parser is what failed, the report is for whoever has to teach it, and it should read the
 * way the parser saw it.
 */
const sentenceCoverage = (
  script: Readonly<Record<string, unknown>>,
  card: CardProjection,
): { readonly total: number; readonly unread: readonly string[] } => {
  const parsed = cardScriptSchema.safeParse(script);
  if (!parsed.success) return { total: 0, unread: [] };

  const report = checkCoverage(parsed.data, card);
  const normalised = normaliseCard(card).abilities.flatMap((line) => line.sentences);
  const byIndex = new Map(normalised.map((sentence) => [sentence.index, sentence.text]));

  return {
    total: report.sentences.length,
    unread: report.unclaimed.flatMap((index) => {
      const text = byIndex.get(index);
      return text === undefined ? [] : [text];
    }),
  };
};

// --- Patterns ---

const numberWords = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fifteen',
  'twenty',
  'x',
];

/** How many leading words a pattern keeps. */
const WORDS = 6;

/**
 * The shape of a sentence, with what is card-specific taken out.
 *
 * A list of twenty thousand distinct sentences is not a report. Numbers and mana symbols
 * are what differ between two printings of the same template — "deals 3 damage" and "deals
 * 5 damage" are one template — so they are generalised, and what is left is the first few
 * words, which is where Magic puts the verb.
 *
 * It is a blunt instrument on purpose. A prefix cannot tell "destroy target creature" from
 * "destroy target creature an opponent controls", and it does not need to: the first is
 * the template to teach and the second falls out of it.
 */
export const patternOf = (sentence: string): string =>
  sentence
    .toLowerCase()
    .replace(/(\{[^}]*\})+/g, '{M}')
    .replace(/[+-]?\d+\/[+-]?\d+/g, 'N/N')
    .replace(/\b\d+\b/g, 'N')
    .split(/\s+/)
    .map((word) => (numberWords.includes(word.replace(/[.,;:]$/, '')) ? 'N' : word))
    .filter((word) => word.length > 0)
    .slice(0, WORDS)
    .join(' ')
    .replace(/[.,;:]$/, '');
