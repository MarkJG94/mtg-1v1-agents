import { describe, expect, it } from 'vitest';
import { coverageReport, failurePattern, formatCoverage } from '../src/coverage.js';
import { handScriptsByOracleId } from '../src/scripts.js';
import type { ScryfallCard } from '../src/scryfall.js';
import corpus from './fixtures/auto-corpus.json' with { type: 'json' };
import bootstrap from './fixtures/scryfall-subset.json' with { type: 'json' };

describe('failurePattern', () => {
  it('keeps the rule and the first unread words, dropping the rest', () => {
    expect(
      failurePattern('sentence 2: effect: return target creature card from your graveyard .'),
    ).toBe('effect: return target creature card from');
  });
  it('passes through a whole-card reason', () => {
    expect(failurePattern('multi-faced cards need a hand script')).toBe(
      'multi-faced cards need a hand script',
    );
  });
});

describe('coverageReport', () => {
  const cards = [...(bootstrap as ScryfallCard[]), ...(corpus as ScryfallCard[])];

  it('credits hand scripts before the grammar and counts the rest', () => {
    const report = coverageReport(cards, { handScripts: handScriptsByOracleId() });
    expect(report.total).toBe(cards.length);
    expect(report.handScripted).toBe(98);
    expect(report.autoScripted).toBeGreaterThanOrEqual(30);
    expect(report.counts.supported).toBe(report.handScripted + report.autoScripted);
    expect(report.supportedFraction).toBeGreaterThan(0.9);
  });

  it('ranks failing patterns by how many cards they block', () => {
    const report = coverageReport(cards);
    expect(report.patterns.length).toBeGreaterThan(0);
    const counts = report.patterns.map((p) => p.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    expect(report.patterns[0]?.examples.length).toBeGreaterThan(0);
  });

  it('renders a markdown summary', () => {
    const md = formatCoverage(coverageReport(cards.slice(0, 20)));
    expect(md).toContain('# Card coverage');
    expect(md).toContain('| supported |');
  });
});
