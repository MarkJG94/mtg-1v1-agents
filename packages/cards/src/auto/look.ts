import { type Bindings, player, quantity, type ScriptFilter } from './phrases.js';
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
  const what = cardFilter(reader, many ? 'cards' : 'card');
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
 * "a creature card", "an instant or sorcery card", "a noncreature, nonland card", "a Human
 * card", "an Elf, Warrior, or Tyvar card", "a creature card with power 3 or less" — a
 * card in a library, by its types. A list with an "or" in it offers any of them, and one
 * of "non-" words joined by commas asks for all; a capitalised word is a subtype, as
 * Oracle text capitalises them (CR 205.3). Supertypes ("legendary") and "historic" are
 * not read. `noun` is "cards" after "any number of".
 */
export const cardFilter = (
  reader: Reader,
  noun: 'card' | 'cards' = 'card',
): ScriptFilter | 'any' | null => {
  if (noun === 'card') reader.anyWord('a', 'an');
  if (reader.word(noun)) return 'any';
  const kinds: ScriptFilter[] = [];
  let anyOr = false;
  for (;;) {
    const kind = cardWord(reader);
    if (kind === null) return null;
    kinds.push(kind);
    const comma = reader.word(',');
    const or = reader.word('or');
    anyOr ||= or;
    if (!comma && !or) break;
  }
  if (!reader.word(noun)) return null;
  const head: ScriptFilter =
    kinds.length === 1 ? (kinds[0] as ScriptFilter) : { [anyOr ? 'or' : 'and']: kinds };
  const most = reader.try(() => {
    if (!reader.word('with')) return null;
    const what = reader.anyWord('power', 'toughness');
    if (what === null) return null;
    const amount = reader.match(/\d+/);
    if (amount === null || !reader.words('or', 'less')) return null;
    return { [`${what}AtMost`]: Number(amount[0]) };
  });
  return most === null ? head : { and: [head, most] };
};

const cardWord = (reader: Reader): ScriptFilter | null => {
  const token = reader.peek();
  if (token === null) return null;
  const kind = cardWords[token.word];
  if (kind !== undefined) {
    reader.next();
    return kind;
  }
  if (!/^[A-Z][a-z]+$/.test(token.text)) return null;
  reader.next();
  return { subtype: token.word };
};
