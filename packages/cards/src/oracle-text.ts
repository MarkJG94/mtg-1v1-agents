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
 * The sentences of a card's rules text, numbered in reading order.
 *
 * Reminder text is dropped: it is in parentheses precisely because it restates rules that
 * are true anyway (CR 207.2), so asking a script to claim it would be asking it to
 * implement the rulebook twice. Lines are split first, because a Magic card's abilities
 * are line-separated, and then sentences within a line, because "Draw a card. Then
 * discard a card." is two sentences of one ability — which `covers` can say.
 */
export const sentencesOf = (oracleText: string): readonly string[] =>
  oracleText
    .replace(/\([^)]*\)/g, '')
    .split('\n')
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
