import type { CardType, Supertype } from '@mtg/engine';
import { cardTypes, supertypes } from '@mtg/engine';

/**
 * Reading a printed card: its type line and its oracle text (docs/03 "Validation").
 *
 * Both are prose, and prose is where a validator earns its keep or invents problems. The
 * rules here are deliberately dull: split where Magic itself splits, ignore what Magic
 * says is not rules text, and never guess. Anything this cannot read confidently is
 * reported rather than assumed, because the cost of a wrong answer is a card quietly
 * playing differently from the one it is printed as.
 */

export interface ParsedTypeLine {
  readonly supertypes: readonly Supertype[];
  readonly types: readonly CardType[];
  readonly subtypes: readonly string[];
  /** Words in the type line that are none of the above — a type the engine has no idea about. */
  readonly unknown: readonly string[];
}

/** Scryfall uses an em dash between types and subtypes: `Legendary Creature — Human Wizard`. */
export const parseTypeLine = (typeLine: string): ParsedTypeLine => {
  const [left = '', right = ''] = typeLine.split('—').map((part) => part.trim());

  const found: Supertype[] = [];
  const kinds: CardType[] = [];
  const unknown: string[] = [];

  for (const word of left.split(/\s+/).filter(Boolean)) {
    const lower = word.toLowerCase();
    if ((supertypes as readonly string[]).includes(lower)) {
      found.push(lower as Supertype);
    } else if ((cardTypes as readonly string[]).includes(lower)) {
      kinds.push(lower as CardType);
    } else {
      unknown.push(word);
    }
  }

  return {
    supertypes: found,
    types: kinds,
    subtypes: right
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word.toLowerCase()),
    unknown,
  };
};

/**
 * A line of a card's rules text: one ability, and the sentences that make it up.
 *
 * A Magic card's abilities are line-separated, and a sentence is the unit `covers:`
 * counts in. Both matter and they are not the same unit — "Draw a card. Then discard a
 * card." is one ability of two sentences — so the structure keeps both rather than making
 * whoever needs the other one guess it back.
 */
export interface OracleSentence {
  /** Sentence number, as `sentencesOf` numbers them: what `covers:` would say. */
  readonly index: number;
  readonly text: string;
}

export interface OracleLine {
  /** Position among the lines that have text, in reading order. */
  readonly line: number;
  readonly sentences: readonly OracleSentence[];
  /** The whole line, which is what a classifier and a grammar read. */
  readonly text: string;
}

/**
 * A card's rules text as lines of sentences, numbered in reading order.
 *
 * Reminder text is dropped: it is in parentheses precisely because it restates rules that
 * are true anyway (CR 207.2), so asking a script to claim it would be asking it to
 * implement the rulebook twice.
 */
export const linesOf = (oracleText: string): readonly OracleLine[] => {
  const lines: OracleLine[] = [];
  let next = 0;

  for (const raw of oracleText.replace(/\([^)]*\)/g, '').split('\n')) {
    const texts = raw
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length > 0);
    if (texts.length === 0) continue;

    lines.push({
      line: lines.length,
      sentences: texts.map((text, index) => ({ index: next + index, text })),
      text: texts.join(' '),
    });
    next += texts.length;
  }

  return lines;
};

/**
 * The sentences of a card's rules text, numbered in reading order.
 *
 * This is the numbering `covers:` is checked against, so it is defined as the flattening
 * of `linesOf` rather than computed a second way: the auto-scripter emits `covers:` from
 * the line structure, and two functions that agree today would not stay that way.
 */
export const sentencesOf = (oracleText: string): readonly string[] =>
  linesOf(oracleText).flatMap((line) => line.sentences.map((sentence) => sentence.text));
