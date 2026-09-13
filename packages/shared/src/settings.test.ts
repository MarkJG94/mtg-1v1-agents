import { describe, expect, it } from 'vitest';
import { parseRunSettings, runSettingsSchema, validateSeedDeckColours } from './settings.js';

describe('runSettingsSchema', () => {
  it('fills in every documented default from a seed alone', () => {
    const settings = parseRunSettings({ seed: '42' });
    expect(settings).toEqual({
      seed: '42',
      matchesPerCycle: 100,
      tieMargin: 0.04,
      tiebreakMatches: 30,
      changeSize: 'slot',
      shortlistSize: 50,
      trialTopK: 3,
      trialMatches: 20,
      turnCap: 40,
      agentLevel: 'search',
      seedDeck: 'constrainedRandom',
      seedDeckColours: [],
      seedDeckLands: 24,
      seedDeckLandsJitter: 2,
      legalityFilter: 'vintage',
    });
  });

  it('keeps values the caller supplied', () => {
    const settings = parseRunSettings({ seed: '1', matchesPerCycle: 10, agentLevel: 'greedy' });
    expect(settings.matchesPerCycle).toBe(10);
    expect(settings.agentLevel).toBe('greedy');
  });

  it('accepts a full 64-bit seed without losing precision', () => {
    const seed = '18446744073709551615';
    expect(parseRunSettings({ seed }).seed).toBe(seed);
    expect(BigInt(parseRunSettings({ seed }).seed)).toBe(2n ** 64n - 1n);
  });

  it.each([
    ['a seed that is not an integer', { seed: '1.5' }],
    ['a negative seed', { seed: '-1' }],
    ['a seed wider than 64 bits', { seed: '18446744073709551616' }],
    ['an unknown agent level', { seed: '1', agentLevel: 'brilliant' }],
    ['a non-integer match count', { seed: '1', matchesPerCycle: 1.5 }],
    ['a tie margin above 0.5', { seed: '1', tieMargin: 0.9 }],
    ['a zero turn cap', { seed: '1', turnCap: 0 }],
  ])('rejects %s', (_label, input) => {
    expect(runSettingsSchema.safeParse(input).success).toBe(false);
  });

  it('allows trials to be disabled', () => {
    expect(parseRunSettings({ seed: '1', trialTopK: 0 }).trialTopK).toBe(0);
  });
});

describe('validateSeedDeckColours', () => {
  it('accepts an empty list, which means "roll the colours"', () => {
    expect(validateSeedDeckColours(parseRunSettings({ seed: '1' }))).toEqual([]);
  });

  it('accepts one to three distinct colours', () => {
    const settings = parseRunSettings({ seed: '1', seedDeckColours: ['U', 'B', 'R'] });
    expect(validateSeedDeckColours(settings)).toEqual([]);
  });

  it('reports duplicates', () => {
    const settings = parseRunSettings({ seed: '1', seedDeckColours: ['U', 'U'] });
    expect(validateSeedDeckColours(settings)).toEqual(['seedDeckColours contains duplicates']);
  });

  it('reports more than three colours', () => {
    const settings = parseRunSettings({ seed: '1', seedDeckColours: ['W', 'U', 'B', 'R'] });
    expect(validateSeedDeckColours(settings)).toContain(
      'seedDeckColours must name at most 3 colours',
    );
  });
});
