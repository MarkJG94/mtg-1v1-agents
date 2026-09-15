import type { Reader } from './reader.js';

/**
 * The vocabulary every effect verb is built out of (docs/03, auto-scripter step 3).
 *
 * Quantities, players, filters, durations and the object phrases — "target creature", "all
 * creatures", "it". Each is a rule that either matches and hands back **script form** or
 * leaves the cursor where it found it.
 *
 * Script form, not engine form, because a script is what the auto-scripter emits and what
 * the resolver hands to the loader: `{ type: creature, controller: you }` rather than the
 * engine's tagged union. That means the loader and the validator are the ones that decide
 * whether what came out is playable, which is the point — a parser that built engine
 * objects directly would be a second place where the vocabulary is written down.
 */

/** A filter in script form: a shorthand name, or the object form read as "all of these". */
export type ScriptFilter = string | Readonly<Record<string, unknown>>;

/** A quantity in script form: a plain number, or `{ x: true }` for a spell's X. */
export type ScriptQuantity = number | Readonly<Record<string, unknown>>;

/** What an effect acts on: something named, or every object matching a filter. */
export type ObjectPhrase =
  | { readonly kind: 'ref'; readonly ref: string }
  | { readonly kind: 'all'; readonly filter: ScriptFilter };

/**
 * The targets an ability has declared so far, and what the sentences after it can call
 * them (CR 601.2c for the declaring, anaphora for the calling).
 *
 * "Gain control of target creature until end of turn. Untap that creature. It gains haste"
 * is three sentences about one target, and only the first one declares it. So a target is
 * remembered with the noun it was declared under, and "it", "them" and "that creature"
 * find it again.
 */
export interface DeclaredTarget {
  readonly id: string;
  /** What it may be aimed at, which only the phrase that declared it knows. */
  readonly filter: ScriptFilter;
  /** The word it was declared under, so a pronoun can find it again. */
  readonly noun: string;
}

export class Bindings {
  private readonly declared: DeclaredTarget[] = [];

  /**
   * The player the last clause was about, so "Target player draws two cards and loses 2
   * life" does not need a subject twice.
   */
  subject: string | null = null;

  /** Whether any effect has been read yet, which decides what a bare "it" may mean. */
  started = false;

  /** How many targets are declared, so a rule that fails can undo the ones it declared. */
  mark(): number {
    return this.declared.length;
  }

  /**
   * Put the declarations back to a mark.
   *
   * Ordered choice means a verb can read half a sentence, declare a target and then fail,
   * and the next verb gets the tokens back — so it has to get the bindings back too.
   * Without this, Giant Growth declared three targets for its one "target creature", one
   * per verb that tried and gave up.
   */
  reset(mark: number): void {
    this.declared.length = mark;
  }

  /** Declare a target and hand back the reference the effects will use. */
  declare(noun: string, filter: ScriptFilter): string {
    const id = String.fromCharCode('t'.charCodeAt(0) + this.declared.length);
    this.declared.push({ id, filter, noun });
    return `$${id}`;
  }

  /** What a pronoun refers to: the most recent target, or one declared under this noun. */
  resolve(noun: string | null): string | null {
    const found =
      noun === null
        ? this.declared.at(-1)
        : ([...this.declared].reverse().find((each) => each.noun === noun) ?? this.declared.at(-1));
    return found === undefined ? null : `$${found.id}`;
  }

  /** Every target declared, with the filter it was declared with, in reading order. */
  get targets(): readonly DeclaredTarget[] {
    return [...this.declared];
  }
}

// --- Quantities ---

const numberWords: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  twenty: 20,
};

/** A number, however it is spelled, or the X a spell was cast with. */
export const quantity = (reader: Reader): ScriptQuantity | null =>
  reader.first<ScriptQuantity>(
    () => {
      const digits = reader.match(/\d+/);
      return digits === null ? null : Number(digits[0]);
    },
    () => (reader.word('x') ? { x: true } : null),
    () => {
      const word = reader.peek()?.word;
      if (word === undefined || numberWords[word] === undefined) return null;
      reader.next();
      return numberWords[word] ?? null;
    },
  );

// --- Durations ---

/** "until end of turn", the only duration the vocabulary can say (CR 611.2). */
export const duration = (reader: Reader): 'untilEndOfTurn' | null =>
  reader.words('until', 'end', 'of', 'turn') ? 'untilEndOfTurn' : null;

// --- Players ---

/**
 * A player phrase, in script form: `you`, `opponent`, `each`, or `$p` for a target.
 *
 * "Target player" declares a target the way "target creature" does, so it goes through the
 * same bindings and gets the same anaphora.
 */
export const player = (reader: Reader, bindings: Bindings): string | null => {
  const found = readPlayer(reader, bindings);
  if (found !== null) bindings.subject = found;
  return found;
};

const readPlayer = (reader: Reader, bindings: Bindings): string | null =>
  reader.first<string>(
    () => (reader.word('you') ? 'you' : null),
    () => (reader.words('target', 'player') ? bindings.declare('player', 'player') : null),
    () =>
      reader.words('target', 'opponent')
        ? bindings.declare('player', { is: 'player', controller: 'opponent' })
        : null,
    () => (reader.words('each', 'player') ? 'each' : null),
    () => (reader.words('each', 'opponent') ? 'opponent' : null),
    () => (reader.words('that', 'player') ? bindings.resolve('player') : null),
  );

/**
 * Not here, on purpose: "its controller". The engine can say it — a `controllerOf` player
 * selector — but the script vocabulary can only spell that for the card itself (`~`), so
 * a sentence about a *target's* controller has nowhere to go. Swords to Plowshares is the
 * card, and it is one of the three the bootstrap set already marks partial. Reading it
 * into something else would be worse than not reading it.
 */

// --- Filters ---

const types = ['artifact', 'creature', 'enchantment', 'land', 'planeswalker', 'battle'] as const;
const colours: Readonly<Record<string, string>> = {
  white: 'W',
  blue: 'U',
  black: 'B',
  red: 'R',
  green: 'G',
};

/** One noun with the adjectives in front of it: "nonblack creature", "artifact creature". */
const noun = (reader: Reader): ScriptFilter | null => {
  const parts: Record<string, unknown> = {};
  let found = false;

  for (;;) {
    const colour = reader.try(() => {
      const word = reader.peek()?.word ?? '';
      const negated = word.startsWith('non') ? word.slice(3) : word;
      const letter = colours[negated];
      if (letter === undefined) return null;
      reader.next();
      return { letter, negated: word.startsWith('non') };
    });
    if (colour !== null) {
      if (colour.negated) parts['not'] = { colour: colour.letter };
      else parts['colour'] = colour.letter;
      continue;
    }

    const word = reader.peek()?.word ?? '';
    const bare = word.startsWith('non') ? word.slice(3) : word;
    const type = (types as readonly string[]).includes(bare) ? bare : null;
    if (type !== null) {
      reader.next();
      found = true;
      if (word.startsWith('non')) parts['not'] = { type };
      else if (parts['type'] === undefined) parts['type'] = type;
      else parts['and'] = [{ type: parts['type'] }, { type }];
      continue;
    }

    if (reader.word('permanent') || reader.word('permanents')) {
      parts['is'] = 'permanent';
      found = true;
      continue;
    }
    if (reader.word('spell') || reader.word('spells')) {
      parts['is'] = 'spell';
      found = true;
      continue;
    }
    if (reader.word('creatures')) {
      found = true;
      parts['type'] = 'creature';
      continue;
    }
    break;
  }

  if (!found) return null;
  return simplify(parts);
};

/** `{ type: creature }` is just `creature` when nothing else qualifies it. */
const simplify = (parts: Record<string, unknown>): ScriptFilter => {
  const keys = Object.keys(parts);
  if (keys.length === 1 && parts['type'] === 'creature') return 'creature';
  if (keys.length === 1 && parts['is'] === 'permanent') return 'permanent';
  if (keys.length === 1 && parts['is'] === 'spell') return 'spell';
  return parts;
};

/** "you control", "you don't control", "an opponent controls" — who has to have it. */
const controller = (reader: Reader): string | null =>
  reader.first<string>(
    () => (reader.words('you', 'control') ? 'you' : null),
    () => (reader.words('you', "don't", 'control') ? 'opponent' : null),
    () => (reader.words('an', 'opponent', 'controls') ? 'opponent' : null),
    () => (reader.words('your', 'opponents', 'control') ? 'opponent' : null),
  );

/**
 * A noun phrase: what a spell is allowed to be pointed at.
 *
 * "Any target" is its own filter rather than a synonym for anything (CR 115.4), and
 * "player or planeswalker" is the other phrase that spans kinds, so both are matched
 * before the ordinary nouns get a turn.
 */
export const filter = (reader: Reader): ScriptFilter | null => {
  if (reader.words('any', 'target')) return 'any';
  if (reader.words('player', 'or', 'planeswalker')) return { or: ['player', 'planeswalker'] };

  if (reader.word('player') || reader.word('players')) return 'player';

  const first = noun(reader);
  if (first === null) return null;

  // "target artifact, creature, or land": a list of alternatives, commas and all.
  const alternatives: ScriptFilter[] = [first];
  for (;;) {
    const next = reader.try(() => {
      const comma = reader.word(',');
      const or = reader.word('or');
      return comma || or ? noun(reader) : null;
    });
    if (next === null) break;
    alternatives.push(next);
  }
  const combined: ScriptFilter = alternatives.length === 1 ? first : { or: alternatives };

  const who = controller(reader);
  if (who === null) return combined;
  return typeof combined === 'string'
    ? { is: combined, controller: who }
    : { ...combined, controller: who };
};

// --- Objects ---

const pronouns = ['it', 'them', 'they', 'its'];

/**
 * What an effect acts on.
 *
 * Four shapes, in the order Magic writes them: the card itself (`~`), a target it declares,
 * every object matching a filter ("all creatures", "each creature"), and a pronoun pointing
 * back at something a previous sentence declared.
 */
export const object = (reader: Reader, bindings: Bindings): ObjectPhrase | null =>
  reader.first<ObjectPhrase>(
    () => (reader.word('~') ? { kind: 'ref', ref: '~' } : null),
    // "any target" is a target like any other, and its filter is the one that means a
    // creature, a player, a planeswalker or a battle (CR 115.4).
    () =>
      reader.words('any', 'target') ? { kind: 'ref', ref: bindings.declare('any', 'any') } : null,
    () => {
      if (!reader.word('target')) return null;
      const what = filter(reader);
      return what === null
        ? reader.stopped('"target" is not followed by anything this can read')
        : { kind: 'ref', ref: bindings.declare(nounOf(what), what) };
    },
    () => {
      if (reader.anyWord('all', 'each', 'every') === null) return null;
      const what = filter(reader);
      return what === null ? null : { kind: 'all', filter: what };
    },
    () => {
      const word = reader.peek()?.word;
      if (word === undefined || !pronouns.includes(word)) return null;
      reader.next();
      const ref = bindings.resolve(null);
      if (ref !== null) return { kind: 'ref', ref };
      // "Sacrifice ~: It deals 1 damage to any target." — an "it" with nothing before it
      // to refer to is the card itself. Only before any effect has been read, because
      // after one it is far more likely to mean whatever that effect produced ("draw a
      // card. If it is a land…"), which this vocabulary cannot say at all.
      return bindings.started ? null : { kind: 'ref', ref: '~' };
    },
    () => {
      if (!reader.word('that')) return null;
      const what = noun(reader);
      if (what === null) return null;
      const ref = bindings.resolve(nounOf(what));
      return ref === null ? null : { kind: 'ref', ref };
    },
  );

/** The word a filter would be called by, so a pronoun can find it again. */
const nounOf = (what: ScriptFilter): string => {
  if (typeof what === 'string') return what;
  const record = what as Record<string, unknown>;
  const name = record['type'] ?? record['is'];
  return typeof name === 'string' ? name : 'permanent';
};
