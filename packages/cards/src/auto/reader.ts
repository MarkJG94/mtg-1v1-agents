/**
 * Reading a line of oracle text a token at a time (docs/03, auto-scripter step 3).
 *
 * This is the machinery a PEG would have generated: a cursor over tokens, ordered choice,
 * and backtracking. A rule tries to match; if it cannot, it puts the tokens back and the
 * next alternative gets its turn. ADR 0008 says why it is written rather than generated.
 *
 * Two things it does that a naive `split(' ')` would not. Mana symbols stay whole, so
 * `{1}{R}` is one token rather than six, and a power/toughness pair stays whole, so
 * `+3/+3` is one token rather than a sum. Both are single words as far as Magic is
 * concerned, and splitting them is the kind of thing that only shows up on the one card
 * that needs it.
 *
 * Every failure carries the token it stopped at. docs/03 asks for an unparseable sentence
 * to be recorded with the failing position, and a report that says "could not read this"
 * is worth much less than one that says "could not read this, at «regenerate»".
 */

export interface Token {
  /** The token as it was written, for a message somebody has to read. */
  readonly text: string;
  /** Lower case, for matching. */
  readonly word: string;
  /** Position in the line, in characters, for pointing at it. */
  readonly at: number;
}

const pattern = new RegExp(
  [
    '(?:\\{[^}]*\\})+', // a run of mana or tap symbols: {1}{R}, {T}
    '[+-]?\\d+/[+-]?\\d+', // a power/toughness pair, printed either way: +3/+3, 1/1
    '[+-]?\\d+', // a number, with the sign a loyalty cost carries
    "[A-Za-z~][A-Za-z'-]*", // a word, including ~ and don't and nonblack
    '[.,;:—]', // the punctuation that separates clauses
  ].join('|'),
  'g',
);

/**
 * A possessive is two tokens, not one.
 *
 * "target creature's power" is about a creature, and a rule looking for the word
 * "creature" would never see it if the apostrophe came along for the ride. "don't" keeps
 * its apostrophe, because that is one word.
 */
const split = (token: Token): readonly Token[] =>
  token.word.endsWith("'s") && token.word.length > 2
    ? [
        { text: token.text.slice(0, -2), word: token.word.slice(0, -2), at: token.at },
        { text: "'s", word: "'s", at: token.at + token.text.length - 2 },
      ]
    : [token];

export const tokenise = (line: string): readonly Token[] =>
  [...line.matchAll(pattern)].flatMap((match) =>
    split({ text: match[0], word: match[0].toLowerCase(), at: match.index }),
  );

/** Where a parse stopped, and on what. */
export interface ParseFailure {
  readonly reason: string;
  /** The token it stopped at, or `null` at the end of the line. */
  readonly token: Token | null;
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/**
 * A cursor over a line's tokens.
 *
 * Mutable on purpose: a parser that threads an index through every rule turns each one
 * into a function returning a pair, and the rules are already the hard part to read. The
 * discipline that replaces immutability is `try`, which puts the cursor back wherever a
 * rule gives up — so no rule can consume tokens and then fail.
 */
export class Reader {
  private index = 0;
  private furthest = 0;
  private why = 'no rule matched';

  constructor(private readonly tokens: readonly Token[]) {}

  static of(line: string): Reader {
    return new Reader(tokenise(line));
  }

  get done(): boolean {
    return this.index >= this.tokens.length;
  }

  /** The token under the cursor, or `null` past the end. */
  peek(ahead = 0): Token | null {
    return this.tokens[this.index + ahead] ?? null;
  }

  /** Take the next token, whatever it is. */
  next(): Token | null {
    const token = this.peek();
    if (token !== null) this.index += 1;
    return token;
  }

  /** Take the next token if it is this word. */
  word(text: string): boolean {
    if (this.peek()?.word !== text.toLowerCase()) return false;
    this.index += 1;
    return true;
  }

  /** Take these words in order, or nothing at all. */
  words(...texts: readonly string[]): boolean {
    return this.try(() => texts.every((text) => this.word(text)));
  }

  /** Take the next token if it is any of these words, and say which. */
  anyWord(...texts: readonly string[]): string | null {
    const word = this.peek()?.word;
    if (word === undefined || !texts.includes(word)) return null;
    this.index += 1;
    return word;
  }

  /** Take the next token if it matches, and hand back what the pattern captured. */
  match(regex: RegExp): RegExpExecArray | null {
    const token = this.peek();
    if (token === null) return null;
    const found = new RegExp(`^(?:${regex.source})$`, regex.flags.replace('g', '')).exec(
      token.text,
    );
    if (found === null) return null;
    this.index += 1;
    return found;
  }

  /**
   * Run `rule`, and put the cursor back if it comes up empty.
   *
   * `false`, `null` and `undefined` all count as "did not match", which is what lets a
   * rule return the thing it built rather than wrapping every result.
   */
  try<T>(rule: () => T): T {
    const from = this.index;
    const value = rule();
    if (value === false || value === null || value === undefined) this.index = from;
    return value;
  }

  /** The first of these rules that matches. */
  first<T>(...rules: readonly (() => T | null)[]): T | null {
    for (const rule of rules) {
      const value = this.try(rule);
      if (value !== null && value !== undefined) return value;
    }
    return null;
  }

  /** Remember where the parse got to and why it stopped, for the report. */
  stopped(reason: string): null {
    if (this.index >= this.furthest) {
      this.furthest = this.index;
      this.why = reason;
    }
    return null;
  }

  /**
   * Why the parse failed, pointing at the furthest token any rule reached.
   *
   * The furthest rather than the last, because ordered choice means the last thing tried
   * is usually the least likely one — reporting that would send whoever reads it to the
   * wrong end of the sentence.
   */
  failure(): ParseFailure {
    return { reason: this.why, token: this.tokens[this.furthest] ?? null };
  }

  /** Skip a clause separator, so a rule can be written without punctuation in it. */
  punctuation(): boolean {
    return this.anyWord('.', ',', ';', ':', '—') !== null;
  }

  /** Everything from here to the end, as text — for a message about what was left. */
  rest(): string {
    return this.tokens
      .slice(this.index)
      .map((token) => token.text)
      .join(' ');
  }
}
