import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkCoverage } from '../checks.js';
import { readScripts } from '../files.js';
import { linesOf } from '../oracle-text.js';
import { cardScriptSchema } from '../schema.js';
import type { CardProjection } from '../scryfall.js';
import { classifyCard, classifyLine, type LineKind } from './classify.js';

/**
 * The classifier (docs/03, auto-scripter step 2; ADR 0007).
 *
 * The unit cases below are each a rule of the Comprehensive Rules, and the run over the
 * bootstrap set is the one that would catch a rule being right in theory and wrong on real
 * cards. Its ground truth is the hand scripts: sixty cards somebody read and wrote a
 * `kind:` for by hand, with `covers:` saying which sentences each ability is. A classifier
 * that disagrees with one of those is wrong about a card that has already been checked.
 */

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const fixture = JSON.parse(readFileSync(here('../../fixtures/scryfall.json'), 'utf8')) as Record<
  string,
  CardProjection
>;
const card = (name: string): CardProjection => {
  const found = Object.values(fixture).find((each) => each.name === name);
  if (found === undefined) throw new Error(`no ${name} in the fixture`);
  return found;
};

/** One line of text, classified as if it were on a card of these types. */
const kindOf = (text: string, ...types: Parameters<typeof classifyLine>[1]): LineKind => {
  const line = linesOf(text)[0];
  if (line === undefined) throw new Error('no line');
  return classifyLine(line, types).kind;
};

describe('the rules that decide a kind', () => {
  it('reads a loyalty cost as a loyalty ability (CR 606.1)', () => {
    expect(kindOf('+2: Each player draws a card.', 'planeswalker')).toBe('loyalty');
    expect(kindOf('-10: Target player mills twenty cards.', 'planeswalker')).toBe('loyalty');
    expect(kindOf('0: Draw a card.', 'planeswalker')).toBe('loyalty');
  });

  it('reads cost, colon, effect as an activated ability (CR 602.1)', () => {
    expect(kindOf('{1}, {T}: Untap target artifact.', 'artifact')).toBe('activated');
    expect(kindOf('Sacrifice ~: It deals 1 damage to any target.', 'creature')).toBe('activated');
    expect(kindOf('Pay 3 life: Draw a card.', 'enchantment')).toBe('activated');
  });

  it('separates the mana abilities out of those (CR 605.1a)', () => {
    expect(kindOf('{T}: Add {U} or {B}.', 'land')).toBe('mana');
    expect(kindOf('{T}: Add one mana of any color.', 'land')).toBe('mana');
  });

  it('does not call an ability that targets a mana ability', () => {
    expect(kindOf('{T}: Add {R} to target player’s mana pool.', 'land')).toBe('activated');
  });

  it('reads a trigger word as a triggered ability (CR 603.1)', () => {
    expect(kindOf('When ~ enters, draw a card.', 'creature')).toBe('triggered');
    expect(kindOf('Whenever ~ attacks, draw a card.', 'creature')).toBe('triggered');
    expect(kindOf('At the beginning of your upkeep, draw a card.', 'enchantment')).toBe(
      'triggered',
    );
  });

  it('reads replacement templating as a replacement (CR 614)', () => {
    expect(kindOf('~ enters tapped.', 'land')).toBe('replacement');
    expect(kindOf('As ~ enters, choose a color.', 'enchantment')).toBe('replacement');
    expect(kindOf('~ enters with two +1/+1 counters on it.', 'creature')).toBe('replacement');
    expect(kindOf('If ~ would die, exile it instead.', 'creature')).toBe('replacement');
  });

  it('takes "When ~ enters" as the trigger it is, not a replacement', () => {
    expect(kindOf('When ~ enters, draw a card.', 'creature')).toBe('triggered');
  });

  it('makes text on an instant or sorcery a spell ability (CR 112.3a)', () => {
    expect(kindOf('~ deals 3 damage to any target.', 'instant')).toBe('spell');
    expect(kindOf('Destroy all creatures.', 'sorcery')).toBe('spell');
  });

  it('makes the rest of a permanent’s text static (CR 112.3d)', () => {
    expect(kindOf('Creatures you control get +1/+1.', 'enchantment')).toBe('static');
    expect(kindOf('~ can’t be blocked.', 'creature')).toBe('static');
  });
});

describe('what it will not guess at', () => {
  it('refuses a colon whose left side is not a cost', () => {
    expect(kindOf('Choose a creature you control: it fights.', 'sorcery')).toBe('unknown');
  });

  /** Half a cost is not a cost: a piece it cannot read makes the whole line unknown. */
  it('refuses a cost with one piece it cannot read', () => {
    expect(kindOf('{T}, choose a creature: Draw a card.', 'creature')).toBe('unknown');
    expect(kindOf('Sacrifice ~, flip a coin: Draw a card.', 'creature')).toBe('unknown');
  });

  it('names a keyword ability with a cost rather than reading it', () => {
    expect(kindOf('Equip {2}', 'artifact')).toBe('unknown');
    expect(kindOf('Ward {2}', 'creature')).toBe('unknown');
    expect(kindOf('Flashback {1}{R}', 'sorcery')).toBe('unknown');
  });

  it('does not mistake a spell that adds mana for one of those', () => {
    expect(kindOf('Add {B}{B}{B}.', 'instant')).toBe('spell');
  });

  it('names a modal spell and its modes', () => {
    expect(kindOf('Choose one —', 'instant')).toBe('unknown');
    expect(kindOf('• Draw a card.', 'instant')).toBe('unknown');
  });

  it('says what stopped it, every time', () => {
    const line = linesOf('Equip {2}')[0];
    if (line === undefined) throw new Error('no line');
    expect(classifyLine(line, ['artifact']).why).toContain('keyword ability with a cost');
  });
});

describe('an activated ability’s parts', () => {
  it('hands on the cost and the effect separately', () => {
    const line = linesOf('{1}, {T}: Untap target artifact.')[0];
    if (line === undefined) throw new Error('no line');
    const classified = classifyLine(line, ['artifact']);
    expect(classified.cost).toBe('{1}, {T}');
    expect(classified.effect).toBe('Untap target artifact.');
  });

  it('does the same for a loyalty cost', () => {
    const line = linesOf('-1: Target player draws a card.')[0];
    if (line === undefined) throw new Error('no line');
    const classified = classifyLine(line, ['planeswalker']);
    expect(classified.cost).toBe('-1');
    expect(classified.effect).toBe('Target player draws a card.');
  });
});

describe('over the bootstrap set', () => {
  /**
   * What the hand script says each sentence's ability is: sixty cards read by a person.
   *
   * Three things can be true of a sentence, and the validator already knows which. An
   * ability claims it, and that claim is the ground truth. The card's `keywords:` list
   * claims it, which makes it a keyword line. Or nobody claims it — which is what makes a
   * script *partial*, and a sentence its author deliberately did not implement says
   * nothing about what kind of ability it is.
   */
  const declared = new Map<
    string,
    { readonly byAbility: ReadonlyMap<number, LineKind>; readonly unclaimed: ReadonlySet<number> }
  >();
  for (const file of readScripts(here('../../scripts'))) {
    const script = cardScriptSchema.parse(file.content);
    const byAbility = new Map<number, LineKind>();
    for (const ability of script.abilities) {
      for (const sentence of ability.covers ?? []) byAbility.set(sentence, ability.kind);
    }
    const printed = Object.values(fixture).find((each) => each.oracleId === script.oracleId);
    declared.set(script.oracleId, {
      byAbility,
      unclaimed: new Set(printed === undefined ? [] : checkCoverage(script, printed).unclaimed),
    });
  }

  it('agrees with every hand script about every sentence it claims', () => {
    const disagreements: string[] = [];

    for (const each of Object.values(fixture)) {
      const byHand = declared.get(each.oracleId);
      if (byHand === undefined) continue;

      for (const line of classifyCard(each).lines) {
        const numbers = line.line.sentences.map((sentence) => sentence.index);
        const claimed = numbers
          .map((index) => byHand.byAbility.get(index))
          .filter((kind): kind is LineKind => kind !== undefined);

        if (claimed.length > 0) {
          if (!claimed.includes(line.kind)) {
            disagreements.push(
              `${each.name}: "${line.line.text}" is ${line.kind}, hand-scripted as ${claimed.join('/')}`,
            );
          }
          continue;
        }

        // Left unimplemented on purpose — the script is partial here and says so.
        if (numbers.every((index) => byHand.unclaimed.has(index))) continue;

        // What is left is claimed by the card's keywords rather than by an ability.
        if (line.kind !== 'keyword') {
          disagreements.push(
            `${each.name}: "${line.line.text}" is ${line.kind}, but its keywords claim it`,
          );
        }
      }
    }

    expect(disagreements).toEqual([]);
  });

  it('reads every line of the set, leaving none unknown', () => {
    for (const each of Object.values(fixture)) {
      const unknown = classifyCard(each).lines.filter((line) => line.kind === 'unknown');
      expect(
        unknown.map((line) => line.line.text),
        each.name,
      ).toEqual([]);
    }
  });

  it('keeps the lines in reading order, keyword lines among them', () => {
    const wall = classifyCard(card('Wall of Omens'));
    expect(wall.lines.map((line) => line.kind)).toEqual(['keyword', 'triggered']);
  });
});
