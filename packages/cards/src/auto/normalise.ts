import type { GrantableKeyword } from '@mtg/engine';
import {
  type CardKeyword,
  cardKeywordFromPrinted,
  keywordFromPrinted,
  printedCardKeyword,
  printedKeyword,
} from '../keyword-names.js';
import { linesOf, type OracleLine, parseTypeLine } from '../oracle-text.js';
import type { CardProjection } from '../scryfall.js';

/**
 * Step 1 of the auto-scripter: normalising oracle text (docs/03 "Auto-scripter").
 *
 * Everything downstream — the classifier in 3.2, the grammar in 3.3 — reads the text this
 * produces rather than the text Scryfall printed. The job is to remove the variation that
 * is about *presentation* rather than about rules, so that later steps can be written
 * against one spelling of each thing instead of several:
 *
 * - the card's own name becomes `~`, which is what a script writes;
 * - "this creature", "this land" and the rest become `~` too, since modern templating uses
 *   them where older cards repeat the name — the same rule, printed two ways;
 * - the typography goes to ASCII: a loyalty cost is printed with a real minus sign
 *   (U+2212), and a grammar that had to know that would be a grammar with a bug waiting;
 * - a line that is nothing but keywords is separated out, because those are the card's
 *   `keywords:` list rather than an ability anybody parses.
 *
 * What it never does is guess. Anything it could not do confidently comes back in `notes`,
 * because a normaliser that quietly dropped a line would hand the classifier a card that
 * does less than it says and nothing downstream would know.
 */

export interface NormalisedCard {
  readonly name: string;
  /** Lines that are rules text, normalised, with the sentence numbers they cover. */
  readonly abilities: readonly OracleLine[];
  /** Keywords read off keyword lines, ready for a script's `keywords:` list. */
  readonly keywords: readonly GrantableKeyword[];
  /**
   * Keyword lines that are a field on the card rather than an entry in `keywords:`:
   * `flash: true` and `splitSecond: true`. Separate because the engine keeps them
   * separate — they are about when a spell may be cast, not about a permanent.
   */
  readonly cardKeywords: readonly CardKeyword[];
  /** The lines those keywords came from, so `covers:` can still claim their sentences. */
  readonly keywordLines: readonly OracleLine[];
  /**
   * Scryfall keywords the script vocabulary has no word for. Not a verdict: Scryfall's
   * `keywords` array mixes keyword abilities with action words and ability words, so Jace
   * Beleren lists "Mill" — an op the engine has — and an Equipment lists "Equip", which it
   * has not. Which is which is the classifier's call in 3.2, not the normaliser's.
   */
  readonly otherKeywords: readonly string[];
  /** Everything it could not do confidently, in the card's own terms. */
  readonly notes: readonly string[];
}

export const normaliseCard = (card: CardProjection): NormalisedCard => {
  const notes: string[] = [];
  const face = faceToRead(card, notes);

  const text = normaliseText(face.oracleText, face.name, card.typeLine);
  const lines = linesOf(text);

  const abilities: OracleLine[] = [];
  const keywordLines: OracleLine[] = [];
  const found: GrantableKeyword[] = [];
  const onCard: CardKeyword[] = [];

  for (const line of lines) {
    const keywords = keywordsOnLine(line.text);
    if (keywords === null) {
      abilities.push(line);
      continue;
    }
    keywordLines.push(line);
    for (const keyword of keywords.keywords) if (!found.includes(keyword)) found.push(keyword);
    for (const keyword of keywords.cardKeywords) {
      if (!onCard.includes(keyword)) onCard.push(keyword);
    }
  }

  notes.push(...crossCheck(card, found, onCard));

  return {
    name: face.name,
    abilities,
    keywords: found,
    cardKeywords: onCard,
    keywordLines,
    otherKeywords: card.keywords.filter(
      (keyword) => keywordFromPrinted(keyword) === null && cardKeywordFromPrinted(keyword) === null,
    ),
    notes,
  };
};

// --- The text itself ---

/**
 * Self-reference, as modern templating spells it. "This creature" and the rest are the
 * card talking about itself, which is `~`; "this turn", "this way" and "this one" are not,
 * which is why the list is of type words rather than a rule about the word "this".
 */
const selfWords = [
  'spell',
  'permanent',
  'creature',
  'land',
  'artifact',
  'enchantment',
  'planeswalker',
  'card',
  'token',
  'equipment',
  'aura',
  'battle',
] as const;

/**
 * Oracle text with everything that is presentation rather than rules taken out. Exported
 * because a normaliser is worth testing on a string rather than only on a whole card.
 */
export const normaliseText = (oracleText: string, name: string, typeLine: string): string => {
  let text = normalisePunctuation(oracleText);

  // The full name first: a legendary card's short name is a prefix of it, so replacing the
  // short one first would leave "~ Beleren" behind.
  text = text.replace(wordPattern(normalisePunctuation(name)), '~');

  const short = shortName(normalisePunctuation(name), typeLine);
  if (short !== null) text = text.replace(wordPattern(short), '~');

  return text.replace(new RegExp(`\\bthis (${selfWords.join('|')})\\b`, 'gi'), '~');
};

/**
 * One spelling of each piece of punctuation, so that everything downstream can be written
 * against it. A loyalty cost is printed with a real minus sign (U+2212) rather than a
 * hyphen, quotes are typographic, and the two dash characters both turn up — a grammar
 * that had to know all of that would be a grammar with a bug waiting.
 */
const normalisePunctuation = (text: string): string =>
  text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    // A loyalty cost's minus sign, which is not a hyphen (U+2212).
    .replace(/\u2212/g, '-')
    // One dash character rather than two: Scryfall prints an en dash and an em dash, and
    // a modal spell's "Choose one" line ends in one of them.
    .replace(/[\u2013\u2014]/g, '\u2014')
    .replace(/\u00a0/g, ' ');

/**
 * A pattern matching `word` on its own, wherever it appears.
 *
 * Case-sensitive, because a card's name is printed the same way every time it appears in
 * its own text, and matching loosely would let a short name swallow the ordinary English
 * word it is spelled like. The word boundaries are only added where the name starts or
 * ends with a word character: `\b` before a name beginning with a quote would never match
 * anything at all.
 */
const wordPattern = (word: string): RegExp => {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const before = /^\w/.test(word) ? '\\b' : '';
  const after = /\w$/.test(word) ? '\\b' : '';
  return new RegExp(`${before}${escaped}${after}`, 'g');
};

/**
 * The name a legendary card calls itself by: "Chandra" for "Chandra, Torch of Defiance".
 *
 * Only for legendary cards, and only when it is a single word, because that is the
 * templating rule — a nonlegendary card always repeats its whole name. It is still the
 * one guess in here: a card whose given name is an ordinary English word would have that
 * word replaced. Nothing in the bootstrap set is one, and the alternative is failing to
 * normalise every planeswalker.
 */
const shortName = (name: string, typeLine: string): string | null => {
  if (!parseTypeLine(typeLine).supertypes.includes('legendary')) return null;
  const given = name.split(',')[0]?.trim() ?? '';
  return given.length > 0 && given !== name && !given.includes(' ') ? given : null;
};

// --- Keyword lines ---

/** What a keyword line said, split the way the engine keeps the two kinds apart. */
export interface KeywordLine {
  readonly keywords: readonly GrantableKeyword[];
  readonly cardKeywords: readonly CardKeyword[];
}

/**
 * The keywords a line is made of, or `null` if it is not a keyword line at all.
 *
 * A keyword line is one where *every* part is a keyword the script can say — one the
 * engine can grant, or one of the two it keeps as a field on the card. A line with one
 * word it cannot — "Protection from red", "Equip {2}" — is not partly a keyword line; it
 * is an ability, and it goes to the classifier whole. Claiming half of it would lose the
 * other half.
 */
export const keywordsOnLine = (line: string): KeywordLine | null => {
  const parts = line
    .toLowerCase()
    .replace(/\.$/, '')
    .split(/,|\band\b/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;

  const keywords: GrantableKeyword[] = [];
  const onCard: CardKeyword[] = [];
  for (const part of parts) {
    const keyword = keywordFromPrinted(part);
    if (keyword !== null) {
      keywords.push(keyword);
      continue;
    }
    const field = cardKeywordFromPrinted(part);
    if (field === null) return null;
    onCard.push(field);
  }
  return { keywords, cardKeywords: onCard };
};

/**
 * What Scryfall says the card has, against what was read off its keyword lines.
 *
 * Only one direction is a problem. A keyword line naming something Scryfall does not list
 * means the line was misread, and that is worth saying. The other direction is ordinary:
 * a keyword the card *grants* rather than has ("target creature gains flying") is in
 * Scryfall's list and on no keyword line, and so is every action word.
 */
const crossCheck = (
  card: CardProjection,
  found: readonly GrantableKeyword[],
  onCard: readonly CardKeyword[],
): readonly string[] => {
  const printed = new Set(card.keywords.map((keyword) => keyword.toLowerCase()));
  return [...found.map(printedKeyword), ...onCard.map(printedCardKeyword)]
    .filter((keyword) => !printed.has(keyword))
    .map(
      (keyword) =>
        `read "${keyword}" off a keyword line, but Scryfall does not list it ` +
        "as one of this card's keywords",
    );
};

// --- Faces ---

interface Face {
  readonly name: string;
  readonly oracleText: string;
}

/**
 * Which face to read. A card with two faces keeps its text on them rather than on the
 * card, so the front one is read and the rest are named as unread — a transform card
 * scripted from its front face alone is a card that does less than it says.
 */
const faceToRead = (card: CardProjection, notes: string[]): Face => {
  const faces = card.faces ?? [];
  if (card.oracleText.length > 0 || faces.length === 0) return card;

  const [front, ...rest] = faces;
  if (front === undefined) return card;
  if (rest.length > 0) {
    notes.push(
      `this card has ${faces.length} faces; only "${front.name}" was read, and ` +
        `${rest.map((face) => `"${face.name}"`).join(', ')} ${rest.length === 1 ? 'was' : 'were'} not`,
    );
  }
  return front;
};
