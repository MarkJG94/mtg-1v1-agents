import {
  type Bindings,
  player,
  quantity,
  type ScriptFilter,
  type ScriptQuantity,
} from './phrases.js';
import { type ParseFailure, Reader } from './reader.js';
import type { ScriptEffect } from './verbs.js';

/**
 * Looking at the top of a library, as printed: scry and surveil (CR 701.22, 701.25), and
 * "look at the top N cards of your library" with what is done with them, which is the
 * one template here that runs over several sentences:
 *
 *     Look at the top three cards of your library. Put one of them into your hand and the
 *     rest on the bottom of your library in any order.
 *
 *     Look at the top four cards of your library. You may reveal a creature card from
 *     among them and put it into your hand. Put the rest on the bottom of your library in
 *     a random order.
 *
 * The first sentence is read as a look that is still *open* — it says which cards, and
 * not yet what becomes of them — and `parseEffects` hands each sentence after it to
 * `continueLook` until the look says where the rest go. A look that never does is unread,
 * as a payment with nothing it buys is: "look at the top five cards" alone would be a
 * card that did nothing with them.
 */

/** A look whose last sentence has not yet said where the rest of the cards go. */
export const isOpenLook = (effect: ScriptEffect | undefined): boolean =>
  effect?.op === 'lookAtTop' && effect['rest'] === undefined;

/** "Scry 2", "surveil 1", and the same with a player first: "each player scries 1". */
export const keywordAction = (
  reader: Reader,
  bindings: Bindings,
): readonly ScriptEffect[] | null => {
  const who = reader.try(() => player(reader, bindings)) ?? bindings.subject ?? 'you';
  const word = reader.anyWord('scry', 'scries', 'surveil', 'surveils');
  if (word === null) return null;
  const count = quantity(reader);
  if (count === null) return reader.stopped(`"${word}" is not followed by a number`);
  return [{ op: word.startsWith('scr') ? 'scry' : 'surveil', player: who, count }];
};

/**
 * "Look at the top three cards of your library", and the one-sentence look that finishes
 * itself: "…, then put them back in any order". Only the reader's own library: "the top
 * card of target player's library" is someone else's, and who chooses there is a question
 * the engine does not yet ask.
 */
export const look = (reader: Reader): readonly ScriptEffect[] | null => {
  if (!reader.words('look', 'at', 'the', 'top')) return null;
  const count = reader.word('card') ? 1 : reader.try(() => countOfCards(reader));
  if (count === null) return reader.stopped('a look at a number of cards this cannot read');
  if (!reader.words('of', 'your', 'library')) {
    return reader.stopped('a look at a library other than your own');
  }
  const back = reader.try(() => {
    reader.word(',');
    return reader.words('then', 'put', 'them', 'back', 'in', 'any', 'order') ? true : null;
  });
  return [{ op: 'lookAtTop', player: 'you', count, ...(back === null ? {} : { rest: 'top' }) }];
};

const countOfCards = (reader: Reader) => {
  const count = quantity(reader);
  return count !== null && reader.word('cards') ? count : null;
};

/**
 * The open look with the next sentence read into it, or null when the sentence is not
 * about the cards being looked at. What it says is one of:
 *
 * - "Put one of them into your hand [and the rest …]" — a number taken, exactly;
 * - "You may reveal a creature card from among them and put it into your hand", or "you
 *   may put a land card from among them onto the battlefield tapped" — one, if there is
 *   one the filter allows, and only if the player likes;
 * - "Put the rest …", once what is taken is settled.
 */
export const continueLook = (
  sentence: string,
  open: ScriptEffect,
): { readonly effect: ScriptEffect } | { readonly failure: ParseFailure } => {
  const reader = Reader.of(sentence);
  const taken = open['take'] !== undefined;
  const read = reader.first<ScriptEffect>(
    () => (taken ? null : takeExactly(reader, open)),
    () => (taken ? null : takeChosen(reader, open)),
    () => {
      if (!reader.words('put', 'the')) return null;
      if (reader.anyWord('rest', 'other', 'others') === null) return null;
      reader.try(() => reader.words('of', 'the', 'cards'));
      const rest = restOf(reader);
      return rest === null ? null : { ...open, rest };
    },
  );
  reader.word('.');
  if (read === null || !reader.done) {
    reader.stopped('a sentence about the cards looked at this cannot read');
    return { failure: reader.failure() };
  }
  return { effect: read };
};

/** "Put one of them into your hand and the rest into your graveyard." */
const takeExactly = (reader: Reader, open: ScriptEffect): ScriptEffect | null => {
  if (!reader.word('put')) return null;
  const take = quantity(reader);
  if (take === null) return null;
  reader.try(() => reader.words('of', 'them') || reader.words('of', 'those', 'cards'));
  const to = destination(reader);
  if (to === null) return null;
  const taken = { ...open, take, to };
  const rest = reader.try(() => {
    if (!reader.words('and', 'the')) return null;
    if (reader.anyWord('rest', 'other', 'others') === null) return null;
    return restOf(reader);
  });
  return rest === null ? taken : { ...taken, rest };
};

/**
 * "You may reveal a creature card from among them and put it into your hand", and "any
 * number of artifact cards … and put them into your hand", which may be all of them.
 * Revealing tells the opponent what the card is, which no view yet remembers, so it is
 * read and not kept.
 */
const takeChosen = (reader: Reader, open: ScriptEffect): ScriptEffect | null => {
  if (!reader.words('you', 'may')) return null;
  const revealed = reader.word('reveal');
  if (!revealed && !reader.word('put')) return null;
  const many = reader.words('any', 'number', 'of');
  const what = cardFilter(reader);
  if (what === null) return reader.stopped('a kind of card this cannot read');
  if (!reader.words('from', 'among', 'them')) return null;
  if (revealed) {
    if (!reader.words('and', 'put')) return null;
    const pronoun = many
      ? reader.word('them') || reader.words('the', 'revealed', 'cards')
      : reader.word('it') || reader.words('that', 'card');
    if (!pronoun) return null;
  }
  const to = destination(reader);
  if (to === null) return null;
  return {
    ...open,
    take: many ? open['count'] : 1,
    upTo: true,
    ...(what === 'any' ? {} : { filter: what }),
    to,
  };
};

/** Where a card taken goes: the hand, the graveyard, or the battlefield. */
const destination = (reader: Reader): Readonly<Record<string, unknown>> | null =>
  reader.first<Readonly<Record<string, unknown>>>(
    () => (reader.words('into', 'your', 'hand') ? { kind: 'hand' } : null),
    () => (reader.words('into', 'your', 'graveyard') ? { kind: 'graveyard' } : null),
    () => {
      if (!reader.words('onto', 'the', 'battlefield')) return null;
      return reader.word('tapped')
        ? { kind: 'battlefield', tapped: true }
        : { kind: 'battlefield' };
    },
  );

/** Where the rest go: "into your graveyard", "on the bottom of your library in any order". */
const restOf = (reader: Reader): string | null =>
  reader.first<string>(
    () => (reader.words('into', 'your', 'graveyard') ? 'graveyard' : null),
    () => {
      if (!reader.words('on', 'the', 'bottom', 'of', 'your', 'library')) return null;
      if (reader.words('in', 'a', 'random', 'order')) return 'bottomRandom';
      // In any order, said or not: the owner orders cards put there together (CR 401.4).
      reader.try(() => reader.words('in', 'any', 'order'));
      return 'bottom';
    },
    () => {
      reader.word('back');
      if (!reader.words('on', 'top', 'of', 'your', 'library')) return null;
      reader.try(() => reader.words('in', 'any', 'order'));
      return 'top';
    },
  );

const cardWords: Readonly<Record<string, ScriptFilter>> = {
  artifact: { type: 'artifact' },
  creature: { type: 'creature' },
  enchantment: { type: 'enchantment' },
  instant: { type: 'instant' },
  sorcery: { type: 'sorcery' },
  land: { type: 'land' },
  planeswalker: { type: 'planeswalker' },
  battle: { type: 'battle' },
  // A permanent card is one of the permanent types (CR 110.4b).
  permanent: {
    or: ['artifact', 'creature', 'enchantment', 'land', 'planeswalker', 'battle'].map((type) => ({
      type,
    })),
  },
  noncreature: { not: { type: 'creature' } },
  nonland: { not: { type: 'land' } },
  nonartifact: { not: { type: 'artifact' } },
};

/**
 * "a creature card", "an instant or sorcery card", "a noncreature, nonland card", "a basic
 * Forest, Plains, or Island card", "a legendary creature card", "a Dragon creature card",
 * "an artifact card with mana value 3 or less" — a card in a library, by its types.
 *
 * Words side by side are all said of one card; a list with an "or" in it offers any of
 * its parts, and one of "non-" words joined by commas asks for all of them. Supertypes
 * before the list are said of every part ("basic" in "a basic Forest, Plains, or Island
 * card"). A capitalised word is a subtype, as Oracle text capitalises them (CR 205.3).
 * "Historic" and "named ~" are not read. "Card" or "cards", either.
 */
export const cardFilter = (reader: Reader): ScriptFilter | 'any' | null => {
  reader.anyWord('a', 'an');
  const shared: ScriptFilter[] = [];
  for (;;) {
    const word = reader.peek()?.word;
    if (word === undefined || !(supertypes as readonly string[]).includes(word)) break;
    reader.next();
    shared.push({ supertype: word });
  }
  const groups: ScriptFilter[] = [];
  let anyOr = false;
  while (reader.peek()?.word !== 'card' && reader.peek()?.word !== 'cards') {
    const words: ScriptFilter[] = [];
    for (;;) {
      const word = cardWord(reader);
      if (word === null) break;
      words.push(word);
    }
    if (words.length === 0) return null;
    groups.push(words.length === 1 ? (words[0] as ScriptFilter) : { and: words });
    const comma = reader.word(',');
    const or = reader.word('or');
    anyOr ||= or;
    if (!comma && !or) break;
  }
  if (reader.anyWord('card', 'cards') === null) return null;

  const parts = [
    ...shared,
    ...(groups.length === 0
      ? []
      : [groups.length === 1 ? (groups[0] as ScriptFilter) : { [anyOr ? 'or' : 'and']: groups }]),
  ];
  const most = reader.try(() => {
    if (!reader.word('with')) return null;
    const what = reader.words('mana', 'value') ? 'manaValue' : reader.anyWord('power', 'toughness');
    if (what === null) return null;
    const amount = reader.match(/\d+/);
    if (amount === null || !reader.words('or', 'less')) return null;
    return { [`${what}AtMost`]: Number(amount[0]) };
  });
  if (most !== null) parts.push(most);
  if (parts.length === 0) return 'any';
  return parts.length === 1 ? (parts[0] as ScriptFilter) : { and: parts };
};

const supertypes = ['basic', 'legendary', 'snow'];

const cardWord = (reader: Reader): ScriptFilter | null => {
  const token = reader.peek();
  if (token === null) return null;
  const kind = cardWords[token.word];
  if (kind !== undefined) {
    reader.next();
    return kind;
  }
  if (supertypes.includes(token.word)) {
    reader.next();
    return { supertype: token.word };
  }
  if (!/^[A-Z][a-z]+$/.test(token.text)) return null;
  reader.next();
  return { subtype: token.word };
};

// --- Searching ---

/**
 * "Search your library for a basic land card, put it onto the battlefield tapped, then
 * shuffle." (CR 701.23), the whole sentence: how many ("a", "up to two", "any number
 * of"), what kind, an optional "reveal it", where they go, and the shuffle — or "then
 * shuffle and put that card on top", which goes on top once the rest are shuffled. A
 * search of "their library" is the subject's own: "its controller may search their
 * library".
 */
export const search = (reader: Reader, bindings: Bindings): readonly ScriptEffect[] | null => {
  const who = reader.try(() => player(reader, bindings)) ?? bindings.subject ?? 'you';
  if (reader.anyWord('search', 'searches') === null) return null;
  if (reader.anyWord('your', 'their') === null || !reader.word('library')) {
    return reader.stopped('a search of somewhere other than the searcher’s own library');
  }
  if (!reader.word('for')) return null;

  let count: ScriptQuantity | null = 1;
  let upTo = false;
  if (reader.words('up', 'to')) {
    count = quantity(reader);
    upTo = true;
  } else if (reader.words('any', 'number', 'of')) {
    count = null;
  } else {
    count =
      reader.try(() => {
        const number = quantity(reader);
        // "a"/"an" are one, and left for the noun phrase to read again.
        return number;
      }) ?? 1;
  }
  if (upTo && count === null) return null;
  const what = cardFilter(reader);
  if (what === null) return reader.stopped('a kind of card this cannot read');

  reader.word(',');
  reader.try(() => (reader.word('reveal') && foundPronoun(reader) ? true : null));
  reader.word(',');
  const to = reader.first<Readonly<Record<string, unknown>>>(
    () => {
      if (!reader.words('then', 'shuffle', 'and', 'put') || !foundPronoun(reader)) return null;
      if (!reader.words('on', 'top')) return null;
      reader.try(() => reader.words('of', 'your', 'library'));
      return { kind: 'libraryTop' };
    },
    () => {
      if (!reader.word('put') || !foundPronoun(reader)) return null;
      const where = destination(reader);
      if (where === null) return null;
      reader.word(',');
      if (!reader.words('then', 'shuffle')) return null;
      reader.try(() => reader.anyWord('your', 'their') !== null && reader.word('library'));
      return where;
    },
  );
  if (to === null)
    return reader.stopped('a search that does not put what it finds anywhere this can read');
  return [
    {
      op: 'search',
      player: who,
      ...(count === null ? {} : { count }),
      ...(upTo ? { upTo: true } : {}),
      ...(what === 'any' ? {} : { filter: what }),
      to,
    },
  ];
};

/** "it", "them", "that card", "those cards": what a search found. */
const foundPronoun = (reader: Reader): boolean =>
  reader.anyWord('it', 'them') !== null ||
  reader.words('that', 'card') ||
  reader.words('those', 'cards') ||
  reader.words('the', 'card') ||
  reader.words('the', 'cards');
