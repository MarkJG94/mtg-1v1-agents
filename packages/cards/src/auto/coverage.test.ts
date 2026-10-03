import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CardProjection } from '../scryfall.js';
import { measureCoverage, patternOf } from './coverage.js';

/**
 * The coverage report (docs/03, roadmap 3.5).
 *
 * Two things here have real logic and both can be wrong quietly. The counting can flatter
 * the parser — a card with no rules text is supported without anything being read, and a
 * headline that mixes those in says the parser is better than it is. And the pattern
 * grouping decides whether the report is useful at all: too coarse and every sentence
 * lands in one bucket, too fine and the templates are buried under twenty thousand
 * one-offs.
 *
 * The fixture is the committed corpus, so none of this needs the network.
 */

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const corpus = Object.values(
  JSON.parse(readFileSync(here('../../fixtures/corpus.json'), 'utf8')) as Record<
    string,
    CardProjection
  >,
);

describe('what a pattern keeps and what it throws away', () => {
  it('generalises the numbers that differ between printings of one template', () => {
    expect(patternOf('~ deals 3 damage to any target.')).toBe(
      patternOf('~ deals 5 damage to any target.'),
    );
  });

  it('generalises a number however it is spelled', () => {
    expect(patternOf('Draw two cards.')).toBe(patternOf('Draw 2 cards.'));
  });

  it('generalises mana symbols', () => {
    expect(patternOf('Equip {2}')).toBe(patternOf('Equip {3}'));
    expect(patternOf('Equip {2}')).toBe('equip {M}');
  });

  it('generalises a power and toughness pair', () => {
    expect(patternOf('Target creature gets +3/+3 until end of turn.')).toBe(
      patternOf('Target creature gets +1/+1 until end of turn.'),
    );
  });

  it('keeps templates that differ apart', () => {
    expect(patternOf('Destroy target creature.')).not.toBe(patternOf('Exile target creature.'));
    expect(patternOf('When ~ enters, draw a card.')).not.toBe(
      patternOf('When ~ dies, draw a card.'),
    );
  });

  it('keeps only the opening words, so a sentence that goes on lands with the short one', () => {
    expect(patternOf('When ~ enters, draw a card.')).toBe(
      patternOf('When ~ enters, draw a card and gain 2 life.'),
    );
  });

  /**
   * And deliberately *not* past that: "destroy target creature an opponent controls" needs
   * a qualifier the parser does not have, so it is a different thing to teach from
   * "destroy target creature", and a bucket that merged them would say the wrong number.
   */
  it('keeps a qualifier inside the opening words apart from the plain template', () => {
    expect(patternOf('Destroy target creature.')).not.toBe(
      patternOf('Destroy target creature an opponent controls.'),
    );
  });

  it('is the sentence, tidied, when the sentence is short', () => {
    expect(patternOf('Draw a card.')).toBe('draw a card');
  });
});

describe('counting, over the committed corpus', () => {
  // Quick: the smoke test plays every card three times, which is most of a real run and
  // all of it here. What is being checked is the arithmetic, not the verdicts.
  const report = measureCoverage(corpus, { skipSmokeTest: true, top: 10 });

  it('counts every card exactly once', () => {
    const { counts } = report;
    expect(counts.cards).toBe(corpus.length);
    expect(counts.supported + counts.partial + counts.unsupported + counts.unscripted).toBe(
      counts.cards,
    );
  });

  it('keeps the cards with no rules text out of the honest headline', () => {
    const { counts } = report;
    expect(counts.withoutRulesText).toBeGreaterThan(0);
    expect(counts.supportedWithText).toBeLessThan(counts.supported);
    expect(counts.supportedWithText).toBe(counts.supported - counts.withoutRulesText);
  });

  it('counts claimed sentences as part of all sentences, never more', () => {
    const { counts } = report;
    expect(counts.sentencesClaimed).toBeGreaterThan(0);
    expect(counts.sentencesClaimed).toBeLessThanOrEqual(counts.sentences);
  });

  it('ranks the patterns by how many cards each would unlock', () => {
    expect(report.patterns.length).toBeGreaterThan(0);
    expect(report.patterns.length).toBeLessThanOrEqual(10);

    const counts = report.patterns.map((pattern) => pattern.count);
    expect([...counts].sort((left, right) => right - left)).toEqual(counts);
  });

  /**
   * The count says how many sentences share a shape; `finishes` says how many *cards* have
   * nothing else standing in their way. They rank differently, and the second is the one
   * worth working from: a template on nine hundred cards that each need three more things
   * taught buys nothing until the other three are done.
   */
  it('says how many cards each pattern is the last thing standing in the way of', () => {
    for (const pattern of report.patterns) {
      expect(pattern.finishes).toBeGreaterThanOrEqual(0);
      expect(pattern.finishes).toBeLessThanOrEqual(pattern.count);
    }
    expect(report.patterns.some((pattern) => pattern.finishes > 0)).toBe(true);
  });

  it('gives every pattern an example somebody can go and look at', () => {
    for (const pattern of report.patterns) {
      expect(pattern.example.card.length).toBeGreaterThan(0);
      expect(pattern.example.sentence.length).toBeGreaterThan(0);
    }
  });

  it('reports the same thing twice in a row', () => {
    expect(measureCoverage(corpus, { skipSmokeTest: true, top: 10 })).toEqual(report);
  });

  it('says the parser reads less than everything, which is the point of the report', () => {
    expect(report.counts.sentencesClaimed).toBeLessThan(report.counts.sentences);
  });

  /**
   * A sentence left unread because an earlier one of the same ability was is fallout, not
   * a template. Counting it as a failure put "draw a card" — read since 3.3 — fourteenth
   * in the table.
   */
  it('counts the fallout of a failure apart from the failure', () => {
    const { counts } = report;
    expect(counts.sentencesFallout).toBeGreaterThan(0);
    expect(counts.sentencesClaimed + counts.sentencesFallout).toBeLessThanOrEqual(counts.sentences);
  });

  it('never ranks a template the grammar reads', () => {
    // If "draw a card" is in the table, the report is counting fallout as failure again.
    expect(report.patterns.map((pattern) => pattern.pattern)).not.toContain('draw a card');
  });
});
