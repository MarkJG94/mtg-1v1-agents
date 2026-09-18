import type { CardAbility, CardType } from '@mtg/engine';
import type { CardKeyword } from '../keyword-names.js';
import type { OracleLine } from '../oracle-text.js';
import { parseTypeLine } from '../oracle-text.js';
import type { CardProjection } from '../scryfall.js';
import { normaliseCard } from './normalise.js';

/**
 * Step 2 of the auto-scripter: what kind of ability each line is (docs/03, ADR 0007).
 *
 * The categories are the engine's own ability kinds rather than a list of its own, so the
 * emitter in 3.4 maps a classification straight to a `kind:` instead of re-reading text
 * this step already read. `keyword` and `unknown` are the two that are not ability kinds:
 * one is the card's `keywords:` list, and the other is the honest answer.
 *
 * Most of this is the Comprehensive Rules rather than heuristics, which is the point.
 * CR 603.1 says a triggered ability begins with "when", "whenever" or "at". CR 602.1 gives
 * an activated ability its cost-colon-effect shape, and CR 605.1a decides which of those
 * are mana abilities. CR 112.3 settles the rest: text on an instant or sorcery is a spell
 * ability, and text on a permanent that is none of the others is static. Only the shapes
 * those rules do not reach are guesses, and those come back `unknown` with a reason.
 *
 * What this does **not** claim is that a line can be parsed. "All creatures lose all
 * abilities and have base power and toughness 1/1" is a static ability by rule, and
 * whether the grammar in 3.3 can read it is a different question with a different answer.
 */

export type LineKind = CardAbility['kind'] | 'keyword' | 'unknown';

export interface ClassifiedLine {
  readonly line: OracleLine;
  readonly kind: LineKind;
  /** Why, in the rule's own terms — and for `unknown`, what stopped it. */
  readonly why: string;
  /** An activated, mana or loyalty ability's cost, as printed. */
  readonly cost?: string;
  /** What that ability does, with the cost taken off the front. */
  readonly effect?: string;
}

export interface ClassifiedCard {
  readonly name: string;
  readonly lines: readonly ClassifiedLine[];
  /** From the normaliser, unchanged: this step does not read the card's characteristics. */
  readonly keywords: readonly string[];
  /** Also from the normaliser: the keyword lines that are a field on the card. */
  readonly cardKeywords: readonly CardKeyword[];
  readonly otherKeywords: readonly string[];
  readonly notes: readonly string[];
}

export const classifyCard = (card: CardProjection): ClassifiedCard => {
  const normalised = normaliseCard(card);
  const types = parseTypeLine(card.typeLine).types;

  return {
    name: normalised.name,
    lines: [
      ...normalised.keywordLines.map(
        (line): ClassifiedLine => ({
          line,
          kind: 'keyword',
          why: 'every part of the line is a keyword the script vocabulary can say',
        }),
      ),
      ...normalised.abilities.map((line) => classifyLine(line, types)),
    ].sort((left, right) => left.line.line - right.line.line),
    keywords: normalised.keywords,
    cardKeywords: normalised.cardKeywords,
    otherKeywords: normalised.otherKeywords,
    notes: normalised.notes,
  };
};

export const classifyLine = (line: OracleLine, types: readonly CardType[]): ClassifiedLine => {
  const say = (
    kind: LineKind,
    why: string,
    rest: Partial<ClassifiedLine> = {},
  ): ClassifiedLine => ({
    line,
    kind,
    why,
    ...rest,
  });

  const text = line.text.trim();

  // A loyalty cost is a number, and it comes first because it is also a colon (CR 606.1).
  const loyalty = /^([+-]?(?:\d+|X)):\s*(.*)$/.exec(text);
  if (loyalty !== null) {
    return say('loyalty', 'the cost is a loyalty cost (CR 606.1)', {
      cost: loyalty[1] ?? '',
      effect: loyalty[2] ?? '',
    });
  }

  const colon = text.indexOf(':');
  if (colon > 0) {
    const cost = text.slice(0, colon).trim();
    const effect = text.slice(colon + 1).trim();
    if (!isCost(cost)) {
      return say('unknown', `there is a colon, but "${cost}" is not a cost this can read`);
    }
    return isManaAbility(effect)
      ? say('mana', 'an activated ability that adds mana and targets nothing (CR 605.1a)', {
          cost,
          effect,
        })
      : say('activated', 'cost, colon, effect (CR 602.1)', { cost, effect });
  }

  if (/^(when|whenever|at)\b/i.test(text)) {
    return say('triggered', 'it begins with a trigger word (CR 603.1)');
  }

  if (isReplacement(text)) {
    return say('replacement', 'it says how something happens instead (CR 614)');
  }

  const shape = unreadableShape(text);
  if (shape !== null) return say('unknown', shape);

  return types.includes('instant') || types.includes('sorcery')
    ? say('spell', 'text on an instant or sorcery is a spell ability (CR 112.3a)')
    : say('static', 'text on a permanent that is none of the other kinds is static (CR 112.3d)');
};

// --- Costs ---

/** Cost verbs that start a cost rather than an effect (CR 118.3). */
const costVerbs = [
  'sacrifice',
  'discard',
  'pay',
  'exile',
  'remove',
  'return',
  'tap',
  'untap',
  'reveal',
  'put',
];

/**
 * Whether the text before a colon is a cost.
 *
 * Every piece of it has to be one, because a cost is a list of them joined by commas
 * (CR 601.2h) and half a cost is not a cost. A line whose left side has a piece this
 * cannot read is `unknown` rather than an activated ability with a cost nobody checked —
 * a cost read wrongly is a card that is cheaper than the one that is printed.
 */
const isCost = (text: string): boolean => {
  if (text.length === 0 || text.length > 80 || text.includes('.')) return false;
  return text
    .split(',')
    .map((piece) => piece.trim().toLowerCase())
    .every(
      (piece) =>
        piece.length > 0 &&
        (/^(\{[^}]+\})+$/.test(piece) ||
          costVerbs.some((verb) => piece === verb || piece.startsWith(`${verb} `))),
    );
};

/**
 * CR 605.1a: an activated ability is a mana ability when it could add mana, has no target
 * and is not a loyalty ability. The loyalty part is already decided above.
 */
const isManaAbility = (effect: string): boolean =>
  /^add\b/i.test(effect) && !/\btarget\b/i.test(effect);

// --- Replacements and shapes ---

/**
 * Replacement templating (CR 614.1). "As ~ enters" and "~ enters tapped" are how a
 * permanent changes its own arrival; "if ... would ..., instead" is the general form.
 */
const isReplacement = (text: string): boolean =>
  /^as ~ enters\b/i.test(text) ||
  /~ enters (the battlefield )?(tapped|with)\b/i.test(text) ||
  (/\bwould\b/i.test(text) && /\binstead\b/i.test(text));

/**
 * Shapes the rules above do not reach, named rather than guessed at.
 *
 * These are what the coverage report in 3.5 counts: each one is a template the
 * auto-scripter would need to learn, and saying which is more useful than a pile of
 * lines that did not parse.
 */
const unreadableShape = (text: string): string | null => {
  if (text.startsWith('\u2022')) return 'a mode of a modal spell';
  if (/^choose (one|two|up to)\b/i.test(text)) return 'a modal spell';

  // "Equip {2}", "Ward {2}", "Flashback {1}{R}": a keyword and the cost it charges. The
  // first word has to not be a verb, because "Add {B}{B}{B}" is the same shape and is Dark
  // Ritual — an ordinary spell, which this rule called a keyword until it said so.
  const costed = /^([A-Z][A-Za-z]*)(?: [a-z]+)? (?:\{[^}]+\})+\.?$/.exec(text);
  if (costed !== null && !startsAnEffect(costed[1] ?? '')) {
    return 'a keyword ability with a cost, which the script vocabulary cannot say yet';
  }
  return null;
};

/** Verbs that begin an effect, so a line starting with one is text rather than a keyword. */
const effectVerbs = [...costVerbs, 'add', 'draw', 'destroy', 'counter', 'gain', 'lose', 'deal'];

const startsAnEffect = (word: string): boolean => effectVerbs.includes(word.toLowerCase());
