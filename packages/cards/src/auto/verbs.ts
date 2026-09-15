import { type GrantableKeyword, grantableKeywords } from '@mtg/engine';
import { keywordFromPrinted } from '../keyword-names.js';
import {
  type Bindings,
  duration,
  type ObjectPhrase,
  object,
  player,
  quantity,
  type ScriptFilter,
  type ScriptQuantity,
} from './phrases.js';
import type { Reader } from './reader.js';

/**
 * The effect verbs (docs/03, auto-scripter step 3).
 *
 * One rule per template, tried in order, each producing script effects — `{ op, ...args }`
 * in the vocabulary docs/03 describes. What comes out is checked by the loader and the
 * validator like any other script, so a verb that builds an op wrongly fails there rather
 * than reaching a game.
 *
 * The list is the common templates rather than all of Magic, by design: docs/03's
 * expectation is that vanilla creatures, burn, pump, simple removal, counters, cantrips and
 * ETB triggers are the first third of all cards and cheap to reach, and that the long tail
 * stays hand-scripted. A sentence no verb here matches is reported with the word it stopped
 * at rather than approximated.
 */

/** An effect in script form. Deliberately loose: the loader is what decides it is valid. */
export type ScriptEffect = Readonly<Record<string, unknown>> & { readonly op: string };

/**
 * Apply an effect to whatever the object phrase named — wrapping it in a `forEach` when
 * that was "all creatures", since the vocabulary has no selector meaning "every one of
 * these" (CR 109.2: an effect on a set of objects acts on each of them).
 */
const forEachOf = (
  phrase: ObjectPhrase,
  build: (ref: string) => ScriptEffect,
): readonly ScriptEffect[] =>
  phrase.kind === 'ref'
    ? [build(phrase.ref)]
    : [{ op: 'forEach', of: phrase.filter, effects: [build('$each')] }];

type Verb = (reader: Reader, bindings: Bindings) => readonly ScriptEffect[] | null;

// --- Damage and life ---

/** "~ deals 3 damage to any target", and the same sentence with a creature dealing it. */
const damage: Verb = (reader, bindings) => {
  const source = object(reader, bindings);
  if (source === null || source.kind !== 'ref') return null;
  if (!reader.word('deals')) return null;
  const amount = quantity(reader);
  if (amount === null) return reader.stopped('"deals" is not followed by an amount');
  if (!reader.word('damage')) return null;
  if (!reader.word('to')) return reader.stopped('damage with nobody to deal it to');

  const to = object(reader, bindings);
  if (to !== null) {
    return forEachOf(to, (ref) => ({
      op: 'damage',
      to: ref,
      amount,
      ...(source.ref === '~' ? {} : { from: source.ref }),
    }));
  }
  const who = player(reader, bindings);
  if (who === null) return reader.stopped('damage dealt to something this cannot read');
  return [{ op: 'damage', to: who, amount, ...(source.ref === '~' ? {} : { from: source.ref }) }];
};

/** "You gain 7 life", "target player loses 2 life". */
const life: Verb = (reader, bindings) => {
  // "Target player draws two cards and loses 2 life" names the player once, so a clause
  // with no subject of its own belongs to the one before it.
  const who = player(reader, bindings) ?? bindings.subject;
  if (who === null) return null;
  const word = reader.anyWord('gain', 'gains', 'lose', 'loses');
  if (word === null) return null;
  const amount = quantity(reader);
  if (amount === null) return reader.stopped('life gained or lost without an amount');
  if (!reader.word('life')) return null;
  return [{ op: word.startsWith('gain') ? 'gainLife' : 'loseLife', player: who, amount }];
};

/** "Target creature you control fights target creature you don't control" (CR 701.13). */
const fight: Verb = (reader, bindings) => {
  const first = object(reader, bindings);
  if (first === null || first.kind !== 'ref') return null;
  if (!reader.word('fights')) return null;
  const second = object(reader, bindings);
  if (second === null || second.kind !== 'ref') {
    return reader.stopped('"fights" is not followed by a creature this can read');
  }
  return [{ op: 'fight', first: first.ref, second: second.ref }];
};

// --- Cards ---

/** "Draw a card", "target player draws two cards", "target player mills twenty cards". */
const cards: Verb = (reader, bindings) => {
  const who = reader.try(() => player(reader, bindings)) ?? 'you';
  const word = reader.anyWord('draw', 'draws', 'mill', 'mills', 'discard', 'discards');
  if (word === null) return null;
  const count = quantity(reader);
  if (count === null) return reader.stopped(`"${word}" is not followed by a number`);
  if (reader.anyWord('card', 'cards') === null) return null;

  if (word.startsWith('draw')) return [{ op: 'draw', player: who, count }];
  if (word.startsWith('mill')) return [{ op: 'mill', player: who, count }];
  // Only discarding at random is in the vocabulary: choosing which card is a decision
  // mid-resolution, which the engine cannot pause for yet (roadmap 2.1's stated limit).
  if (!reader.words('at', 'random')) {
    return reader.stopped('a discard the player chooses needs a decision mid-resolution');
  }
  return [{ op: 'discardAtRandom', player: who, count }];
};

// --- Removal ---

const removal: Verb = (reader, bindings) => {
  const word = reader.anyWord('destroy', 'exile', 'counter', 'sacrifice', 'regenerate');
  if (word === null) return null;
  const what = object(reader, bindings);
  if (what === null) return reader.stopped(`"${word}" is not followed by anything this can read`);
  return forEachOf(what, (ref) => ({ op: word, object: ref }));
};

/** "Return target creature to its owner's hand." */
const bounce: Verb = (reader, bindings) => {
  if (!reader.word('return')) return null;
  const what = object(reader, bindings);
  if (what === null) return null;
  if (!reader.words('to', 'its', 'owner', "'s", 'hand')) {
    return reader.stopped('a return to somewhere other than its owner’s hand');
  }
  return forEachOf(what, (ref) => ({ op: 'bounce', object: ref }));
};

// --- Permanents ---

const tapping: Verb = (reader, bindings) => {
  const word = reader.anyWord('tap', 'untap');
  if (word === null) return null;
  const what = object(reader, bindings);
  if (what === null) return reader.stopped(`"${word}" is not followed by anything this can read`);
  return forEachOf(what, (ref) => ({ op: word, object: ref }));
};

/** "Target creature gets +3/+3 until end of turn." */
const pump: Verb = (reader, bindings) => {
  const what = object(reader, bindings);
  if (what === null) return null;
  if (reader.anyWord('gets', 'get') === null) return null;
  const change = reader.match(/([+-]\d+)\/([+-]\d+)/);
  if (change === null) return reader.stopped('"gets" is not followed by a power and toughness');
  const until = reader.try(() => duration(reader));

  const effects = forEachOf(what, (ref) => ({
    op: 'pump',
    object: ref,
    power: Number(change[1]),
    toughness: Number(change[2]),
    ...(until === null ? {} : { duration: until }),
  }));

  // "gets +1/+1 and gains double strike until end of turn" is one sentence about one
  // creature, so the second half is read here rather than as a sentence of its own.
  const also = reader.try(() => (reader.word('and') ? keywordGrant(reader, what) : null));
  return also === null ? effects : [...effects, ...also];
};

/** "gains flying until end of turn", once something has already been named. */
const keywordGrant = (reader: Reader, what: ObjectPhrase): readonly ScriptEffect[] | null => {
  if (reader.anyWord('gains', 'gain', 'has', 'have') === null) return null;
  const keywords: GrantableKeyword[] = [];
  for (;;) {
    const keyword = readKeyword(reader);
    if (keyword === null) break;
    keywords.push(keyword);
    if (!reader.word('and') && !reader.word(',')) break;
  }
  if (keywords.length === 0) return reader.stopped('a keyword the engine cannot grant');

  const until = reader.try(() => duration(reader));
  return keywords.flatMap((keyword) =>
    forEachOf(what, (ref) => ({
      op: 'grantKeyword',
      object: ref,
      keyword,
      ...(until === null ? {} : { duration: until }),
    })),
  );
};

/** A keyword as a card prints it, which may be two words ("first strike"). */
const readKeyword = (reader: Reader): GrantableKeyword | null =>
  reader.try(() => {
    const first = reader.peek()?.word;
    if (first === undefined) return null;
    const pair = `${first} ${reader.peek(1)?.word ?? ''}`;
    const two = keywordFromPrinted(pair);
    if (two !== null && (grantableKeywords as readonly string[]).includes(two)) {
      reader.next();
      reader.next();
      return two;
    }
    const one = keywordFromPrinted(first);
    if (one === null) return null;
    reader.next();
    return one;
  });

/** "Target creature gains haste until end of turn", as a sentence of its own. */
const grants: Verb = (reader, bindings) => {
  const what = object(reader, bindings);
  if (what === null) return null;
  return keywordGrant(reader, what);
};

/** "Switch target creature's power and toughness until end of turn." */
const switchStats: Verb = (reader, bindings) => {
  if (!reader.word('switch')) return null;
  const what = object(reader, bindings);
  if (what === null) return reader.stopped('a switch of something this cannot read');
  if (!reader.words("'s", 'power', 'and', 'toughness')) {
    return reader.stopped('"switch" is not followed by power and toughness');
  }
  const until = reader.try(() => duration(reader));
  return forEachOf(what, (ref) => ({
    op: 'switchPowerToughness',
    object: ref,
    ...(until === null ? {} : { duration: until }),
  }));
};

/** "Put a +1/+1 counter on ~." */
const counters: Verb = (reader, bindings) => {
  if (!reader.word('put')) return null;
  const amount = quantity(reader) ?? 1;
  const kind = reader.match(/[+-]\d+\/[+-]\d+/);
  if (kind === null) return reader.stopped('a counter this cannot name');
  if (reader.anyWord('counter', 'counters') === null) return null;
  if (!reader.word('on')) return null;
  const what = object(reader, bindings);
  if (what === null) return reader.stopped('counters put on something this cannot read');
  return forEachOf(what, (ref) => ({
    op: 'addCounters',
    object: ref,
    counter: kind[0],
    amount,
  }));
};

/** "Gain control of target creature until end of turn." */
const control: Verb = (reader, bindings) => {
  if (!reader.words('gain', 'control', 'of')) return null;
  const what = object(reader, bindings);
  if (what === null) return reader.stopped('control of something this cannot read');
  const until = reader.try(() => duration(reader));
  return forEachOf(what, (ref) => ({
    op: 'gainControl',
    object: ref,
    player: 'you',
    ...(until === null ? {} : { duration: until }),
  }));
};

// --- Mana and turns ---

/** "Add {B}{B}{B}", the whole of a ritual and of every land's mana ability. */
const mana: Verb = (reader, bindings) => {
  if (!reader.word('add')) return null;
  const symbols = reader.match(/(?:\{[^}]*\})+/);
  if (symbols === null) return reader.stopped('"add" is not followed by mana symbols');

  const produce = [...symbols[0].matchAll(/\{([^}]*)\}/g)].map((match) => match[1] ?? '');
  if (!produce.every((type) => /^[WUBRGC]$/.test(type))) {
    return reader.stopped('mana this cannot name, such as a hybrid or a generic amount');
  }
  const counted = new Map<string, number>();
  for (const type of produce) counted.set(type, (counted.get(type) ?? 0) + 1);

  const who = reader.try(() => (reader.word('to') ? player(reader, bindings) : null)) ?? 'you';
  return [
    {
      op: 'addMana',
      player: who,
      produce: [...counted].map(([type, amount]) => ({ type, amount })),
    },
  ];
};

/** "Target player takes an extra turn after this one." */
const extraTurn: Verb = (reader, bindings) => {
  const who = player(reader, bindings);
  if (who === null) return null;
  if (!reader.words('takes', 'an', 'extra', 'turn')) return null;
  reader.try(() => reader.words('after', 'this', 'one'));
  return [{ op: 'extraTurn', player: who }];
};

// --- Tokens ---

/** "Create a 1/1 white Spirit creature token with flying." */
const token: Verb = (reader, bindings) => {
  if (!reader.word('create')) return null;
  const count = quantity(reader) ?? 1;
  const size = reader.match(/(\d+)\/(\d+)/);
  if (size === null) return reader.stopped('a token whose size this cannot read');

  const colours: string[] = [];
  for (;;) {
    const colour = reader.try(() => {
      const word = reader.peek()?.word ?? '';
      const letter = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' }[word];
      if (letter === undefined) return null;
      reader.next();
      return letter;
    });
    if (colour === null) break;
    colours.push(colour);
  }

  const named = reader.match(/[A-Z][A-Za-z]*/);
  if (named === null) return reader.stopped('a token with no creature type this can read');
  if (!reader.words('creature', 'token')) {
    return reader.stopped('a token that is not a creature token');
  }

  const keywords: GrantableKeyword[] = [];
  if (reader.try(() => reader.word('with'))) {
    for (;;) {
      const keyword = readKeyword(reader);
      if (keyword === null) break;
      keywords.push(keyword);
      if (!reader.word('and') && !reader.word(',')) break;
    }
    if (keywords.length === 0) return reader.stopped('a token ability this cannot read');
  }

  return [
    {
      op: 'createToken',
      controller: reader.try(() => player(reader, bindings)) ?? 'you',
      count,
      token: {
        name: named[0],
        types: ['creature'],
        subtypes: [named[0].toLowerCase()],
        colours,
        power: Number(size[1]),
        toughness: Number(size[2]),
        ...(keywords.length > 0 ? { keywords } : {}),
      },
    },
  ];
};

/**
 * Every verb, in the order they are tried.
 *
 * Order is the grammar here, the way ordered choice is in a PEG. The ones that start with
 * an object phrase come after the ones that start with a keyword, because "Destroy target
 * creature" would otherwise be read as an object phrase followed by a verb nobody knows.
 */
export const verbs: readonly Verb[] = [
  removal,
  switchStats,
  bounce,
  tapping,
  counters,
  control,
  mana,
  token,
  cards,
  damage,
  fight,
  life,
  pump,
  grants,
  extraTurn,
];

export type { ScriptFilter, ScriptQuantity };
