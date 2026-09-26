import { describe, expect, it } from 'vitest';
import { entriesCount, parseDecklist } from './decklist.js';

/** A pasted decklist, as the common exports write one (docs/08 "New run"; roadmap 6.3). */

const names = (entries: readonly { count: number; name: string }[]) =>
  entries.map((entry) => `${entry.count} ${entry.name}`);

describe('parsing a pasted decklist', () => {
  it('reads counts written plainly, with an x, or not at all', () => {
    const parsed = parseDecklist('4 Lightning Bolt\n3x Counterspell\nBlack Lotus');
    expect(names(parsed.main)).toEqual(['4 Lightning Bolt', '3 Counterspell', '1 Black Lotus']);
    expect(parsed.problems).toEqual([]);
  });

  it('puts what follows a sideboard header, in any of its spellings, in the side', () => {
    for (const header of ['Sideboard', 'sideboard:', 'SB:', 'SB']) {
      const parsed = parseDecklist(`Deck\n4 Island\n${header}\n2 Pyroblast`);
      expect(names(parsed.main)).toEqual(['4 Island']);
      expect(names(parsed.side)).toEqual(['2 Pyroblast']);
    }
  });

  it('sides a line marked SB: wherever it is', () => {
    const parsed = parseDecklist('4 Island\nSB: 2 Pyroblast\n4 Mountain');
    expect(names(parsed.main)).toEqual(['4 Island', '4 Mountain']);
    expect(names(parsed.side)).toEqual(['2 Pyroblast']);
  });

  it('reads an Arena export: set codes dropped, the block after a blank line the side', () => {
    const parsed = parseDecklist(
      'Deck\n4 Lightning Bolt (M11) 146\n20 Mountain (M21) 275\n\n2 Smash to Smithereens (SOM) 100',
    );
    expect(names(parsed.main)).toEqual(['4 Lightning Bolt', '20 Mountain']);
    expect(names(parsed.side)).toEqual(['2 Smash to Smithereens']);
  });

  it('keeps blank lines inside the main deck when a sideboard header says where it starts', () => {
    const parsed = parseDecklist('4 Island\n\n4 Mountain\nSideboard\n1 Pyroblast');
    expect(names(parsed.main)).toEqual(['4 Island', '4 Mountain']);
    expect(names(parsed.side)).toEqual(['1 Pyroblast']);
  });

  it('keeps a split card’s whole name, and drops comments', () => {
    const parsed = parseDecklist('// burn\n2 Fire // Ice # the good one\n1 Wear // Tear');
    expect(names(parsed.main)).toEqual(['2 Fire // Ice', '1 Wear // Tear']);
  });

  it('does not take a comment inside the main deck for the gap before the sideboard', () => {
    const parsed = parseDecklist('4 Island\n// creatures\n4 Grizzly Bears\n\n2 Pyroblast');
    expect(names(parsed.main)).toEqual(['4 Island', '4 Grizzly Bears']);
    expect(names(parsed.side)).toEqual(['2 Pyroblast']);
  });

  it('says which line has no card, or a count of none', () => {
    const parsed = parseDecklist('4 Island\n0 Mountain\n4x');
    expect(parsed.problems.map((problem) => [problem.line, problem.message])).toEqual([
      [2, 'a count is a whole number from 1'],
      [3, 'no card name'],
    ]);
    expect(names(parsed.main)).toEqual(['4 Island']);
  });

  it('counts a list’s cards', () => {
    expect(entriesCount(parseDecklist('4 Island\n20 Mountain\nBlack Lotus').main)).toBe(25);
  });
});
