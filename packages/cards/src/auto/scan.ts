/**
 * Tokeniser and backtracking scanner for the auto-scripter's grammar (docs/03 §Auto-scripter step 3).
 *
 * Magic templating is regular enough that a token scanner with explicit backtracking reads closer to the
 * oracle templates than a generated parser would; see docs/adr/0003.
 */
export type TokenKind = 'word' | 'number' | 'mana' | 'pt' | 'punct';

export interface Token {
  /** Original text, with unicode dashes and quotes folded to ASCII. */
  text: string;
  /** Lowercased `text`; every grammar rule matches on this. */
  lower: string;
  kind: TokenKind;
  /** Character offset in the source sentence, for "failed at" diagnostics. */
  at: number;
}

/** A run of mana/tap symbols, e.g. `{1}{R}` or `{T}`. */
const MANA = /^(?:\{[^}\s]*\})+/;
/** Power/toughness pairs, e.g. `+3/+3` or `0/1`, including the star forms. */
const PT = /^[+-]?[\dX*]+\/[+-]?[\dX*]+/i;
const NUMBER = /^\d+/;
const WORD = /^[A-Za-z~][A-Za-z'-]*/;

/** Folds the characters Scryfall uses that would otherwise need duplicate grammar rules. */
export function foldText(text: string): string {
  return text
    .replace(/−/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/—/g, '--')
    .replace(/•/g, '*');
}

export function tokenize(text: string): Token[] {
  const src = foldText(text);
  const out: Token[] = [];
  let i = 0;
  const push = (kind: TokenKind, raw: string, at: number): void => {
    out.push({ text: raw, lower: raw.toLowerCase(), kind, at });
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\n' || ch === '\t') {
      i++;
      continue;
    }
    const rest = src.slice(i);
    const mana = ch === '{' ? MANA.exec(rest) : null;
    if (mana) {
      push('mana', mana[0], i);
      i += mana[0].length;
      continue;
    }
    const pt = PT.exec(rest);
    if (pt) {
      push('pt', pt[0], i);
      i += pt[0].length;
      continue;
    }
    // A sign that is not part of a P/T pair belongs to a loyalty cost ("+2:", "-10:").
    const signed = /^[+-]\d+/.exec(rest);
    if (signed) {
      push('number', signed[0], i);
      i += signed[0].length;
      continue;
    }
    const num = NUMBER.exec(rest);
    if (num) {
      push('number', num[0], i);
      i += num[0].length;
      continue;
    }
    const word = WORD.exec(rest);
    if (word) {
      // Trailing apostrophes belong to possessives ("controllers'"), not to the next token.
      push('word', word[0], i);
      i += word[0].length;
      continue;
    }
    push('punct', ch, i);
    i++;
  }
  return out;
}

/**
 * A cursor over a sentence's tokens. Every rule is written as "try to consume; return null and the caller
 * rewinds", which `attempt` makes safe.
 */
export class Scanner {
  i = 0;
  /** Furthest index any rule reached, so a failure can point at the token that stopped it. */
  furthest = 0;

  constructor(readonly tokens: Token[]) {}

  static of(text: string): Scanner {
    return new Scanner(tokenize(text));
  }

  get done(): boolean {
    return this.i >= this.tokens.length;
  }

  peek(n = 0): Token | undefined {
    return this.tokens[this.i + n];
  }

  private advance(n: number): void {
    this.i += n;
    if (this.i > this.furthest) this.furthest = this.i;
  }

  next(): Token | undefined {
    const t = this.tokens[this.i];
    if (t) this.advance(1);
    return t;
  }

  /** Consumes a fixed space-separated phrase (`"until end of turn"`) if it comes next. */
  eat(phrase: string): boolean {
    const want = phrase.split(' ');
    for (let k = 0; k < want.length; k++)
      if (this.tokens[this.i + k]?.lower !== want[k]) return false;
    this.advance(want.length);
    return true;
  }

  /** Consumes the first alternative that matches and returns it, or null. */
  eatAny(...phrases: string[]): string | null {
    for (const p of phrases) if (this.eat(p)) return p;
    return null;
  }

  /** Whether the phrase comes next, without consuming it. */
  at(phrase: string): boolean {
    const want = phrase.split(' ');
    for (let k = 0; k < want.length; k++)
      if (this.tokens[this.i + k]?.lower !== want[k]) return false;
    return true;
  }

  /** Consumes the next token if it has this kind. */
  kind(k: TokenKind): Token | null {
    const t = this.tokens[this.i];
    if (!t || t.kind !== k) return null;
    this.advance(1);
    return t;
  }

  /** Runs `fn`, rewinding the cursor if it returns null. */
  attempt<T>(fn: () => T | null): T | null {
    const save = this.i;
    const r = fn();
    if (r === null) this.i = save;
    return r;
  }

  /** True once only sentence-final punctuation is left. */
  atEnd(): boolean {
    let k = this.i;
    while (
      k < this.tokens.length &&
      (this.tokens[k]!.lower === '.' || this.tokens[k]!.lower === ';')
    )
      k++;
    return k >= this.tokens.length;
  }

  /** Consumes sentence-final punctuation; false if anything else remains. */
  finish(): boolean {
    while (this.eat('.') || this.eat(';')) {
      /* trailing punctuation */
    }
    return this.done;
  }

  /** Unparsed remainder, for failure messages. */
  remainder(): string {
    return this.tokens
      .slice(this.furthest)
      .map((t) => t.text)
      .join(' ');
  }
}
