import { type CardDefinition, manaValue, parseManaCost } from '@mtg/engine';
import type { Colour } from '@mtg/shared';
import { cardKeywordFromPrinted, keywordFromPrinted } from './keyword-names.js';
import { parseTypeLine, sentencesOf } from './oracle-text.js';
import type { CardScript } from './schema.js';
import type { CardProjection } from './scryfall.js';

/**
 * The two checks that compare a script with the card it claims to be (docs/03
 * "Validation").
 *
 * Characteristic agreement is the one that matters most: a script that gets a cost or a
 * power wrong is not a bug in one card, it is a card that is quietly better or worse than
 * the one everybody else is playing with, and a run of thousands of games would build on
 * it without anybody noticing. So it is exact, and a mismatch makes a script unsupported
 * rather than merely suspect.
 *
 * Text coverage is the one that keeps a script honest about what it has *not* done. A
 * sentence nobody claimed means the card does less than it is printed to do, which makes
 * the script partial — never played, and listed for someone to finish.
 */

export interface CheckProblem {
  readonly check: 'schema' | 'characteristics' | 'coverage' | 'executability';
  readonly message: string;
}

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && [...left].sort().join() === [...right].sort().join();

/** `{1}{G}` and `{G}{1}` are the same cost; a missing cost and `{0}` are not. */
const sameCost = (scriptCost: string, printed: string | null): boolean => {
  const mine = parseManaCost(scriptCost);
  const theirs = parseManaCost(printed ?? '');
  if (manaValue(mine) !== manaValue(theirs)) return false;
  return sameSet(
    mine.symbols.map((symbol) => JSON.stringify(symbol)),
    theirs.symbols.map((symbol) => JSON.stringify(symbol)),
  );
};

/** Scryfall gives power and toughness as strings, because `*` is a real answer. */
const samePrintedNumber = (mine: number | undefined, printed: string | null): boolean => {
  if (printed === null || printed === '') return mine === undefined;
  const asNumber = Number(printed);
  return Number.isInteger(asNumber) ? mine === asNumber : false;
};

export const checkCharacteristics = (
  script: CardScript,
  definition: CardDefinition,
  card: CardProjection,
): readonly CheckProblem[] => {
  const problems: CheckProblem[] = [];
  const say = (message: string) => problems.push({ check: 'characteristics', message });

  if (script.oracleId !== card.oracleId) {
    say(`oracle id ${script.oracleId} is not ${card.name}'s (${card.oracleId})`);
  }
  if (script.name !== card.name) say(`name "${script.name}" is printed as "${card.name}"`);

  if (!sameCost(script.manaCost, card.manaCost)) {
    say(`mana cost "${script.manaCost}" is printed as "${card.manaCost ?? ''}"`);
  }

  const printed = parseTypeLine(card.typeLine);
  if (printed.unknown.length > 0) {
    say(`the type line has words the engine has no type for: ${printed.unknown.join(', ')}`);
  }
  if (!sameSet(definition.types, printed.types)) {
    say(`types [${definition.types.join(', ')}] are printed as [${printed.types.join(', ')}]`);
  }
  if (!sameSet(definition.supertypes ?? [], printed.supertypes)) {
    say(
      `supertypes [${(definition.supertypes ?? []).join(', ')}] are printed as ` +
        `[${printed.supertypes.join(', ')}]`,
    );
  }
  if (!sameSet(definition.subtypes ?? [], printed.subtypes)) {
    say(
      `subtypes [${(definition.subtypes ?? []).join(', ')}] are printed as ` +
        `[${printed.subtypes.join(', ')}]`,
    );
  }

  if (!samePrintedNumber(script.power, card.power)) {
    say(`power ${script.power ?? '(none)'} is printed as ${card.power ?? '(none)'}`);
  }
  if (!samePrintedNumber(script.toughness, card.toughness)) {
    say(`toughness ${script.toughness ?? '(none)'} is printed as ${card.toughness ?? '(none)'}`);
  }
  if (!samePrintedNumber(script.loyalty, card.loyalty)) {
    say(`loyalty ${script.loyalty ?? '(none)'} is printed as ${card.loyalty ?? '(none)'}`);
  }

  const printedColours = card.colors.map((colour) => colour.toUpperCase() as Colour);
  if (!sameSet(script.colours, printedColours)) {
    say(`colours [${script.colours.join(', ')}] are printed as [${printedColours.join(', ')}]`);
  }

  return problems;
};

/**
 * A keyword line claims itself.
 *
 * "Flying", or "Flying, first strike", is not an ability a script writes out: the card's
 * `keywords:` list says it, and the loader expands it into the engine's keywords. So a
 * sentence that is nothing but keywords the script declares is claimed — by the card
 * itself rather than by one of its abilities.
 *
 * "Flash" and "Split second" are the same thing said a different way: the script declares
 * them as `flash: true` and `splitSecond: true` rather than in `keywords:`, because the
 * engine keeps them on the card where casting can see them. A line of them is claimed by
 * the field, and only when the script actually sets it — a card printed with flash whose
 * script forgot it is a card that may be cast at the wrong time, which is a disagreement
 * worth reporting rather than a line to wave through.
 */
const isClaimedByKeywords = (sentence: string, script: CardScript): boolean => {
  const parts = sentence
    .toLowerCase()
    .replace(/\.$/, '')
    .split(/,|\band\b/)
    .map((part) => part.trim())
    .filter(Boolean);

  return (
    parts.length > 0 &&
    parts.every((part) => {
      const keyword = keywordFromPrinted(part);
      if (keyword !== null) return (script.keywords as readonly string[]).includes(keyword);
      const field = cardKeywordFromPrinted(part);
      return field !== null && script[field] === true;
    })
  );
};

export interface CoverageReport {
  readonly sentences: readonly string[];
  /** Sentences nobody claimed. These make a script partial, not wrong. */
  readonly unclaimed: readonly number[];
  /** Claims that are wrong rather than missing: a sentence claimed twice, or one that
   * does not exist. These make a script unsupported. */
  readonly problems: readonly CheckProblem[];
}

/**
 * Every sentence claimed by exactly one ability.
 *
 * A card with no rules text at all — a vanilla creature, a basic land — has nothing to
 * claim and is covered by definition.
 */
export const checkCoverage = (script: CardScript, card: CardProjection): CoverageReport => {
  const sentences = sentencesOf(card.oracleText);
  const problems: CheckProblem[] = [];
  const say = (message: string) => problems.push({ check: 'coverage', message });

  const claims = new Map<number, number>();
  script.abilities.forEach((ability, index) => {
    for (const sentence of ability.covers ?? []) {
      if (sentence >= sentences.length) {
        say(`abilities[${index}] claims sentence ${sentence}, and there are ${sentences.length}`);
        continue;
      }
      claims.set(sentence, (claims.get(sentence) ?? 0) + 1);
    }
  });

  for (const [sentence, count] of claims) {
    if (count > 1) {
      say(`sentence ${sentence} is claimed by ${count} abilities: "${sentences[sentence] ?? ''}"`);
    }
  }

  const unclaimed = sentences
    .map((_, index) => index)
    .filter(
      (index) =>
        (claims.get(index) ?? 0) === 0 && !isClaimedByKeywords(sentences[index] ?? '', script),
    );

  return { sentences, unclaimed, problems };
};
