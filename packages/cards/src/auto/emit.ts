import { parseTypeLine } from '../oracle-text.js';
import type { CardProjection } from '../scryfall.js';
import { type ClassifiedLine, classifyCard } from './classify.js';
import {
  type ParsedAbility,
  parseCost,
  parseEffects,
  parseManaModes,
  parseReplacement,
  parseRiders,
  parseStatic,
  parseTrigger,
} from './parse.js';

/**
 * Step 4 of the auto-scripter: a whole card script (docs/03 "Auto-scripter").
 *
 * The steps before this read a card; this one writes one. Characteristics come off the
 * printed card rather than out of the text, the keywords come from the normaliser, and
 * each classified line becomes one ability of the kind the classifier named — which is
 * where ADR 0007 pays off, because there is nothing to work out a second time.
 *
 * The important part is `covers:`. It names **only the sentences the grammar actually
 * read**, so a card whose text was half understood produces a script that claims half of
 * it — which the validator calls *partial*, and a partial script is never played. The
 * alternative, claiming the whole line because most of it parsed, is how a card ends up
 * quietly playing as something it is not.
 */

export interface EmittedScript {
  /** The script, or `null` when nothing at all could be read. */
  readonly script: Readonly<Record<string, unknown>> | null;
  /** What could not be read, in the card's own words, for the coverage report. */
  readonly problems: readonly string[];
}

export const emitScript = (card: CardProjection): EmittedScript => {
  const classified = classifyCard(card);
  const problems: string[] = [...classified.notes];
  const abilities: Record<string, unknown>[] = [];

  // A card has one spell ability, however many lines its spell text runs to (CR 112.3a).
  // One per line would leave every line after the first unplayed, because the engine
  // resolves the first spell ability it finds — which is how Twisted Image drew no card.
  const spellLines = classified.lines.filter((line) => line.kind === 'spell');
  const spell = spellAbility(spellLines);
  if (spell !== null) abilities.push(spell);
  else if (spellLines.length > 0) {
    const first = spellLines[0];
    if (first !== undefined) problems.push(`${first.why} — "${first.line.text}"`);
  }

  for (const line of classified.lines) {
    if (line.kind === 'keyword' || line.kind === 'spell') continue;
    const emitted = abilityFor(line);
    if (emitted === null) {
      problems.push(`${line.why} — "${line.line.text}"`);
      continue;
    }
    abilities.push(emitted);
  }

  const printed = parseTypeLine(card.typeLine);
  if (printed.types.length === 0) {
    return { script: null, problems: [...problems, `no card type in "${card.typeLine}"`] };
  }

  return {
    script: {
      oracleId: card.oracleId,
      name: card.name,
      manaCost: card.manaCost ?? '',
      types: printed.types,
      ...(printed.supertypes.length > 0 ? { supertypes: printed.supertypes } : {}),
      ...(printed.subtypes.length > 0 ? { subtypes: printed.subtypes } : {}),
      colours: card.colors.map((colour) => colour.toUpperCase()),
      ...printedNumbers(card),
      ...(classified.keywords.length > 0 ? { keywords: classified.keywords } : {}),
      // Flash and split second are fields rather than entries in `keywords:`, because
      // they are about when the card may be cast (CR 702.8, CR 702.19) and the engine
      // keeps them where casting can see them.
      ...Object.fromEntries(classified.cardKeywords.map((keyword) => [keyword, true])),
      text: card.oracleText,
      abilities,
    },
    problems,
  };
};

/**
 * Power, toughness and loyalty as numbers.
 *
 * Scryfall prints them as strings because `*` is a real answer, and a `*` is left out
 * rather than guessed at — the validator then reports it as a disagreement with the
 * printed card, which is the truth: the script vocabulary cannot say a dynamic power yet.
 */
const printedNumbers = (card: CardProjection): Readonly<Record<string, number>> => {
  const numbers: Record<string, number> = {};
  for (const [key, printed] of [
    ['power', card.power],
    ['toughness', card.toughness],
    ['loyalty', card.loyalty],
  ] as const) {
    if (printed === null || printed === '') continue;
    const value = Number(printed);
    if (Number.isInteger(value)) numbers[key] = value;
  }
  return numbers;
};

/** One classified line as one script ability, or `null` if it could not be read. */
const abilityFor = (line: ClassifiedLine): Record<string, unknown> | null => {
  const id = `auto-${line.kind}-${line.line.line}`;

  switch (line.kind) {
    case 'mana': {
      const modes = parseManaModes(line.effect ?? line.line.text);
      return modes === null
        ? null
        : {
            kind: 'mana',
            id,
            covers: covered(line),
            ...(line.cost?.toUpperCase().includes('{T}') === true ? { requiresTap: true } : {}),
            modes,
          };
    }

    case 'static': {
      const parsed = parseStatic(line.line.text);
      return parsed === null ? null : { kind: 'static', covers: covered(line), ...parsed };
    }

    case 'replacement': {
      const parsed = parseReplacement(line.line.text);
      return parsed === null ? null : { kind: 'replacement', id, covers: covered(line), ...parsed };
    }

    case 'triggered': {
      const parsed = parseTrigger(line.line.text);
      if ('failure' in parsed) return null;
      return {
        kind: 'triggered',
        id,
        covers: covered(line),
        when: parsed.when,
        ...body(parsed.ability),
      };
    }

    case 'activated': {
      const cost = parseCost(line.cost ?? '');
      // The rider comes off before the grammar sees the effect: "Activate only as a
      // sorcery" is a restriction on the ability, not something the ability does.
      const rider = parseRiders(line.effect ?? line.line.text);
      const parsed = parseEffects([rider.effect]);
      if (cost === null || !parsed.ok) return null;
      return {
        kind: 'activated',
        id,
        covers: covered(line),
        cost,
        ...(rider.sorceryOnly === true ? { sorceryOnly: true } : {}),
        ...body(parsed.ability),
      };
    }

    case 'loyalty': {
      const cost = Number(line.cost);
      const parsed = parseEffects([line.effect ?? line.line.text]);
      if (!Number.isInteger(cost) || !parsed.ok) return null;
      return { kind: 'loyalty', id, covers: covered(line), cost, ...body(parsed.ability) };
    }

    default:
      return null;
  }
};

/**
 * Every spell line of a card as its one spell ability.
 *
 * The sentences are parsed as a single run so the targets one declares are there for the
 * next — the same anaphora that works within a line works across them — and so the target
 * ids cannot collide, which parsing each line separately would let them do.
 */
const spellAbility = (lines: readonly ClassifiedLine[]): Record<string, unknown> | null => {
  const sentences = lines.flatMap((line) => line.line.sentences);
  if (sentences.length === 0) return null;

  const parsed = parseEffects(sentences.map((sentence) => sentence.text));
  if (!parsed.ok) return null;

  return {
    kind: 'spell',
    covers: sentences.slice(0, parsed.ability.sentencesRead).map((sentence) => sentence.index),
    ...body(parsed.ability),
  };
};

/**
 * The sentences this ability claims.
 *
 * `read` is how many of the line's sentences the grammar got through, and claiming more
 * than that is the one thing this file must never do: an unclaimed sentence makes the
 * script partial and keeps it out of games, while a wrongly claimed one makes it
 * *supported* and puts a card that does less than it says into a thousand of them.
 */
const covered = (line: ClassifiedLine, read = line.line.sentences.length): readonly number[] =>
  line.line.sentences.slice(0, read).map((sentence) => sentence.index);

const body = (ability: ParsedAbility): Readonly<Record<string, unknown>> => ({
  ...(ability.targets.length > 0 ? { targets: ability.targets } : {}),
  effects: ability.effects,
});

/**
 * The auto-scripter, as the resolver's third link (roadmap 2.4, docs/03).
 *
 * 2.4 built `ScriptResolver` with this as a port and nothing behind it, and said that was
 * a configuration rather than a hole: without a parser there is simply no third step. This
 * is that step.
 *
 * The version is what the cache keys a verdict on. Bumping it when the grammar changes is
 * what makes a cached "unsupported" from an older parser be re-earned rather than believed
 * — which is the whole reason the row stores a version at all.
 */
export const AUTO_SCRIPTER_VERSION = 1;

export const autoScripter = {
  version: AUTO_SCRIPTER_VERSION,
  script: (card: CardProjection): unknown | null => emitScript(card).script,
};
