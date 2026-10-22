import { type ObjectId, type PlayerId, playerZone } from '@mtg/shared';
import {
  type ChooseCardsFromLibraryDecision,
  type OrderCardsDecision,
  UnexpectedDecisionError,
} from '../decision.js';
import type { EventEmitter } from '../events/emitter.js';
import { runBatch } from '../events/perform.js';
import type { RulesEvent } from '../events/rules-event.js';
import { rngFromState } from '../rng.js';
import type { GameState } from '../state/game-state.js';
import { objectsIn, setZone, updateState } from '../state/update.js';
import { type EffectContext, evaluateQuantity, matchesFilter, resolvePlayers } from './evaluate.js';
import type { EffectOp, LookDestination, LookRest } from './ops.js';

/**
 * Looking at the top of a library and doing something with what is there: "look at the
 * top three cards of your library, put one into your hand and the rest on the bottom in
 * any order", and the two keyword actions built the same way, scry (CR 701.22a) and
 * surveil (CR 701.25a).
 *
 * It is two questions, asked in turn, as the resolution program stops for them
 * (ADR 0021): which of the cards to take, and then — when the rest go back in an order of
 * the player's choosing and there is more than one — what order. Between the two the
 * cards taken have already gone, so a replacement effect on them is applied, and may
 * itself stop the program, before the rest are put anywhere. Until then the cards are
 * still in the library (CR 401.2); only the player looking at them knows what they are,
 * which is why the view shows them to that player while they are asked about them.
 */

/** A look part-way through: what is left to do with the cards still being looked at. */
export interface Looking {
  readonly player: PlayerId;
  /** The cards being looked at and not yet taken, top first. */
  readonly cards: readonly ObjectId[];
  /** What may still be taken from among them; null once that is settled. */
  readonly take: {
    readonly from: readonly ObjectId[];
    readonly min: number;
    readonly max: number;
    readonly to: LookDestination;
  } | null;
  readonly rest: LookRest;
  /** Cards a search put on top, to stay there once the rest are shuffled. */
  readonly onTop?: readonly ObjectId[];
}

type LookOp = Extract<EffectOp, { op: 'lookAtTop' }>;

/** Scry and surveil are a look whose taken cards go to the bottom or the graveyard. */
export const asLook = (op: Extract<EffectOp, { op: 'scry' | 'surveil' }>): LookOp => ({
  op: 'lookAtTop',
  player: op.player,
  count: op.count,
  take: op.count,
  upTo: true,
  to: op.op === 'scry' ? { kind: 'libraryBottom' } : { kind: 'graveyard' },
  rest: 'top',
});

/**
 * Begin a look: the top cards (all of them, with fewer left than asked for), and which of
 * them could be taken. Null when there is nothing to look at.
 */
export const beginLook = (
  state: GameState,
  context: EffectContext,
  player: PlayerId,
  op: LookOp,
): Looking | null => {
  const library = objectsIn(state, playerZone(player, 'library'));
  const cards = library.slice(0, Math.max(0, evaluateQuantity(state, context, op.count)));
  if (cards.length === 0) return null;

  let take: Looking['take'] = null;
  if (op.take !== undefined && op.to !== undefined) {
    const { filter } = op;
    const from =
      filter === undefined
        ? cards
        : cards.filter((object) =>
            matchesFilter(state, context, filter, { kind: 'object', object }),
          );
    const max = Math.min(from.length, Math.max(0, evaluateQuantity(state, context, op.take)));
    if (max > 0) take = { from, min: op.upTo === true ? 0 : max, max, to: op.to };
  }
  return { player, cards, take, rest: op.rest };
};

/**
 * Begin a search (CR 701.23): every card in the library is looked at, the ones the filter
 * allows may be taken, and the rest are shuffled — so even an empty library, or one with
 * nothing to find, is still shuffled.
 */
export const beginSearch = (
  state: GameState,
  context: EffectContext,
  player: PlayerId,
  op: Extract<EffectOp, { op: 'search' }>,
): Looking => {
  const cards = objectsIn(state, playerZone(player, 'library'));
  const { filter } = op;
  const from =
    filter === undefined
      ? cards
      : cards.filter((object) => matchesFilter(state, context, filter, { kind: 'object', object }));
  const wanted =
    op.count === undefined ? from.length : Math.max(0, evaluateQuantity(state, context, op.count));
  const max = Math.min(from.length, wanted);
  // A stated quality may go unfound (CR 701.23b); "a card" must be found (CR 701.23c).
  const optional = op.upTo === true || filter !== undefined || op.count === undefined;
  return {
    player,
    cards,
    take: max > 0 ? { from, min: optional ? 0 : max, max, to: op.to } : null,
    rest: 'shuffle',
  };
};

/** The players a look is for, in turn: "each player scries 1" is each of them (CR 101.4). */
export const lookers = (
  state: GameState,
  context: EffectContext,
  op: LookOp,
): readonly PlayerId[] => resolvePlayers(state, context, op.player) as readonly PlayerId[];

/**
 * Take the look one step further: ask what to take, take it when there is no choice, or
 * put the rest where they go — asking their order when that is the player's to choose.
 * Always either asks something or leaves less to do, so a caller can loop on it.
 */
export const continueLook = (
  state: GameState,
  emitter: EventEmitter,
  looking: Looking,
  setLooking: (state: GameState, looking: Looking | null) => GameState,
): GameState => {
  const { take } = looking;
  if (take !== null) {
    // Every card that could be taken, and all of them must be: nothing to ask.
    if (take.min === take.from.length)
      return takeCards(state, emitter, looking, take.from, setLooking);
    const decision: ChooseCardsFromLibraryDecision = {
      kind: 'chooseCardsFromLibrary',
      player: looking.player,
      looking: looking.cards,
      from: take.from,
      min: take.min,
      max: take.max,
      to: take.to.kind,
      rest: looking.rest,
    };
    return updateState(state, { pendingDecision: decision });
  }

  // Only what is still on the library: a replacement may have moved a card since.
  const library = playerZone(looking.player, 'library');
  const still = new Set(objectsIn(state, library));
  const rest = looking.cards.filter((card) => still.has(card));
  const done = setLooking(state, null);
  if (looking.rest === 'shuffle') return shuffleUnder(done, looking.player, looking.onTop ?? []);
  if (rest.length === 0) return done;

  switch (looking.rest) {
    case 'graveyard':
      return runBatch(
        done,
        emitter,
        { kind: 'plain' },
        rest.map(
          (object): RulesEvent => ({
            kind: 'moveZone',
            object,
            from: library,
            to: playerZone(looking.player, 'graveyard'),
            cause: 'effect',
            destruction: false,
          }),
        ),
      );
    case 'bottomRandom': {
      const rng = rngFromState(done.rng);
      const order = rng.shuffled(rest);
      return updateState(placeOnLibrary(done, looking.player, order, 'bottom'), {
        rng: rng.save(),
      });
    }
    case 'top':
    case 'bottom': {
      const where = looking.rest;
      if (rest.length === 1) return placeOnLibrary(done, looking.player, rest, where);
      const decision: OrderCardsDecision = {
        kind: 'orderCards',
        player: looking.player,
        cards: rest,
        to: where === 'top' ? 'libraryTop' : 'libraryBottom',
      };
      // Still looking until the order is given.
      return updateState(setLooking(state, { ...looking, cards: rest }), {
        pendingDecision: decision,
      });
    }
  }
};

/** The answer to which cards to take. */
export const answerTake = (
  state: GameState,
  emitter: EventEmitter,
  looking: Looking,
  decision: ChooseCardsFromLibraryDecision,
  chosen: readonly ObjectId[],
  setLooking: (state: GameState, looking: Looking | null) => GameState,
): GameState => {
  if (chosen.length < decision.min || chosen.length > decision.max) {
    throw new UnexpectedDecisionError(
      `expected between ${decision.min} and ${decision.max} card(s), got ${chosen.length}`,
    );
  }
  const allowed = new Set(decision.from);
  for (const id of chosen) {
    if (!allowed.delete(id)) {
      throw new UnexpectedDecisionError(`card ${id} is not one that may be chosen, or is twice`);
    }
  }
  return takeCards(state, emitter, looking, chosen, setLooking);
};

/** The answer to what order the rest go back in. */
export const answerOrder = (
  state: GameState,
  looking: Looking,
  decision: OrderCardsDecision,
  order: readonly ObjectId[],
  setLooking: (state: GameState, looking: Looking | null) => GameState,
): GameState => {
  const expected = new Set(decision.cards);
  if (order.length !== expected.size || !order.every((id) => expected.delete(id))) {
    throw new UnexpectedDecisionError('the order must name every card being put back, once each');
  }
  const where = decision.to === 'libraryTop' ? 'top' : 'bottom';
  return placeOnLibrary(setLooking(state, null), looking.player, order, where);
};

/**
 * Take the chosen cards to where they go, and leave the rest to be put back. The look is
 * updated first, so that a replacement stopping the move mid-way resumes into the rest.
 */
const takeCards = (
  state: GameState,
  emitter: EventEmitter,
  looking: Looking,
  chosen: readonly ObjectId[],
  setLooking: (state: GameState, looking: Looking | null) => GameState,
): GameState => {
  const taken = new Set(chosen);
  const to = looking.take?.to;
  const next = setLooking(state, {
    ...looking,
    cards: looking.cards.filter((card) => !taken.has(card)),
    take: null,
    // A card put on top stays there through a shuffle that ends a search.
    ...(to?.kind === 'libraryTop' ? { onTop: chosen } : {}),
  });
  if (chosen.length === 0 || to === undefined) return next;

  const library = playerZone(looking.player, 'library');
  switch (to.kind) {
    case 'libraryBottom':
      return placeOnLibrary(next, looking.player, chosen, 'bottom');
    case 'libraryTop':
      return placeOnLibrary(next, looking.player, chosen, 'top');
    case 'battlefield':
      return runBatch(
        next,
        emitter,
        { kind: 'plain' },
        chosen.map(
          (object): RulesEvent => ({
            kind: 'entersBattlefield',
            object,
            from: library,
            tapped: to.tapped === true,
            counters: {},
          }),
        ),
      );
    case 'hand':
    case 'graveyard':
      return runBatch(
        next,
        emitter,
        { kind: 'plain' },
        chosen.map(
          (object): RulesEvent => ({
            kind: 'moveZone',
            object,
            from: library,
            to: playerZone(looking.player, to.kind),
            cause: 'effect',
            destruction: false,
          }),
        ),
      );
  }
};

/**
 * Shuffle a library (CR 701.24a), all but the cards given, which go on top of it in that
 * order: "shuffle and put that card on top".
 */
const shuffleUnder = (
  state: GameState,
  player: PlayerId,
  onTop: readonly ObjectId[],
): GameState => {
  const zone = playerZone(player, 'library');
  const kept = new Set(onTop);
  const rng = rngFromState(state.rng);
  const shuffled = rng.shuffled(objectsIn(state, zone).filter((card) => !kept.has(card)));
  const top = onTop.filter((card) => objectsIn(state, zone).includes(card));
  return updateState(setZone(state, zone, [...top, ...shuffled]), { rng: rng.save() });
};

/**
 * Put cards that are already in the library on its top or its bottom, in this order —
 * the first nearest the top either way, the order being the owner's to choose (CR 401.4).
 * Moving within a library is not a zone change, so it reorders the zone rather than
 * proposing an event.
 */
export const placeOnLibrary = (
  state: GameState,
  player: PlayerId,
  cards: readonly ObjectId[],
  where: 'top' | 'bottom',
): GameState => {
  const zone = playerZone(player, 'library');
  const moving = new Set(cards);
  const others = objectsIn(state, zone).filter((card) => !moving.has(card));
  return setZone(state, zone, where === 'top' ? [...cards, ...others] : [...others, ...cards]);
};
