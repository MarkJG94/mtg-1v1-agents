import { type ObjectId, type PlayerId, playerZone } from '@mtg/shared';
import type { ChooseCardsFromLibraryDecision, OrderCardsDecision } from '../decision.js';
import type { EventEmitter } from '../events/emitter.js';
import type { ManaCost } from '../mana/cost.js';
import { finishResolving } from '../stack.js';
import type { GameState } from '../state/game-state.js';
import { objectsIn, updateState } from '../state/update.js';
import { canPayMana, payMana } from './cast.js';
import { applyOp } from './effects.js';
import {
  type EffectContext,
  evaluateQuantity,
  holds,
  objectsMatching,
  resolvePlayers,
} from './evaluate.js';
import {
  answerOrder,
  answerTake,
  asLook,
  beginLook,
  continueLook,
  type Looking,
  lookers,
} from './looking.js';
import type { EffectOp } from './ops.js';

/**
 * Resolution as a program the game can stop in the middle of (ADR 0021).
 *
 * An ability's effects used to run as one call, start to finish, which left nowhere to put
 * the rest of them while a player answered a question: "you may draw a card", "target
 * player discards a card" (they choose which), a replacement effect whose controller must
 * pick which applies first. So the effects being run are kept in the state as a stack of
 * frames — the list, how far through it, and the context it runs in — exactly as a call
 * stack would keep them, but as data: a game paused here is cloned, replayed and searched
 * like any other.
 *
 * `sequence`, `forEach`, `if` and `may` push frames rather than recursing; every other op
 * runs as it always did. When the program runs out, the object leaves the stack
 * (`finishResolving`). Whether it fizzled was decided before the program began
 * (CR 608.2b), and is not asked again at the end.
 */

export interface EffectFrame {
  readonly effects: readonly EffectOp[];
  /** The next op to run. */
  readonly next: number;
  readonly context: EffectContext;
}

export interface Resolution {
  /** The stack object resolving, which leaves the stack once its program has run. */
  readonly object: ObjectId;
  /** Innermost last, as a call stack. */
  readonly frames: readonly EffectFrame[];
  /** A "may" waiting on its yes or no: what happens on a yes, and what a yes costs. */
  readonly asking: (Omit<EffectFrame, 'next'> & { readonly pay?: ManaCost }) | null;
  /** A look at the top of a library part-way through (`looking.ts`), run before any frame. */
  readonly looking: Looking | null;
}

/** Start resolving `object` with these effects, and run as far as the program goes. */
export const beginResolution = (
  state: GameState,
  emitter: EventEmitter,
  object: ObjectId,
  context: EffectContext,
  effects: readonly EffectOp[],
): GameState =>
  runResolution(
    updateState(state, {
      resolution: {
        object,
        frames: [{ effects, next: 0, context }],
        asking: null,
        looking: null,
      },
    }),
    emitter,
  );

/**
 * Run the program until it ends or something has to be answered. Answering — a yes or
 * no, a discard, a replacement choice — comes back here through `applyDecision`.
 */
export const runResolution = (state: GameState, emitter: EventEmitter): GameState => {
  let current = state;
  for (;;) {
    const resolution = current.resolution;
    if (resolution === null || current.result !== null) return current;
    // A replacement choice is a pending decision too, so this covers a batch paused mid-op.
    if (current.pendingDecision !== null) return current;

    // A look finishes before the op after it runs: it asks, or it leaves less to do.
    if (resolution.looking !== null) {
      current = continueLook(current, emitter, resolution.looking, withLooking);
      continue;
    }

    const top = resolution.frames.at(-1);
    if (top === undefined) {
      return finishResolving(
        updateState(current, { resolution: null }),
        emitter,
        resolution.object,
      );
    }
    const rest = resolution.frames.slice(0, -1);
    const op = top.effects[top.next];
    if (op === undefined) {
      current = withFrames(current, rest);
      continue;
    }
    current = withFrames(current, [...rest, { ...top, next: top.next + 1 }]);
    current = step(current, emitter, top.context, op);
  }
};

/** The answer to a "may": on a yes its effects run next, on a no they are skipped. */
export const answerMay = (
  state: GameState,
  emitter: EventEmitter,
  player: PlayerId,
  yes: boolean,
): GameState => {
  const resolution = state.resolution;
  if (resolution?.asking == null) throw new Error('no "may" is waiting on an answer');
  const { pay, ...asking } = resolution.asking;
  const frames = yes ? [...resolution.frames, { ...asking, next: 0 }] : resolution.frames;
  const answered = updateState(state, { resolution: { ...resolution, frames, asking: null } });
  // A yes to "you may pay" pays before anything it buys happens, by the player asked.
  const paid = yes && pay !== undefined ? payMana(answered, emitter, player, pay) : answered;
  return runResolution(paid, emitter);
};

/** The answer to which of the cards looked at to take. */
export const answerChooseCards = (
  state: GameState,
  emitter: EventEmitter,
  decision: ChooseCardsFromLibraryDecision,
  cards: readonly ObjectId[],
): GameState => {
  const looking = state.resolution?.looking;
  if (looking == null) throw new Error('nothing is being looked at');
  return runResolution(answerTake(state, emitter, looking, decision, cards, withLooking), emitter);
};

/** The answer to what order the cards looked at go back in. */
export const answerOrderCards = (
  state: GameState,
  emitter: EventEmitter,
  decision: OrderCardsDecision,
  order: readonly ObjectId[],
): GameState => {
  const looking = state.resolution?.looking;
  if (looking == null) throw new Error('nothing is being looked at');
  return runResolution(answerOrder(state, looking, decision, order, withLooking), emitter);
};

const withLooking = (state: GameState, looking: Looking | null): GameState => {
  const resolution = state.resolution;
  return resolution === null
    ? state
    : updateState(state, { resolution: { ...resolution, looking } });
};

const withFrames = (state: GameState, frames: readonly EffectFrame[]): GameState => {
  const resolution = state.resolution;
  return resolution === null
    ? state
    : updateState(state, { resolution: { ...resolution, frames } });
};

const push = (state: GameState, frames: readonly EffectFrame[]): GameState => {
  const resolution = state.resolution;
  if (resolution === null || frames.length === 0) return state;
  return updateState(state, {
    resolution: { ...resolution, frames: [...resolution.frames, ...frames] },
  });
};

/** One op: control flow pushes frames, a question pauses, and anything else just runs. */
const step = (
  state: GameState,
  emitter: EventEmitter,
  context: EffectContext,
  op: EffectOp,
): GameState => {
  switch (op.op) {
    case 'sequence':
      return push(state, [{ effects: op.effects, next: 0, context }]);

    case 'forEach': {
      // The objects are the ones that match now (CR 608.2c), each run in turn, so the
      // first is pushed last and runs first.
      const each = objectsMatching(state, context, op.of);
      return push(
        state,
        [...each].reverse().map((object) => ({
          effects: op.effects,
          next: 0,
          context: { ...context, each: object },
        })),
      );
    }

    case 'if':
      return push(state, [
        {
          effects: holds(state, context, op.condition) ? op.thenDo : (op.otherwise ?? []),
          next: 0,
          context,
        },
      ]);

    case 'may': {
      const [player] = resolvePlayers(state, context, op.player);
      const resolution = state.resolution;
      if (player === undefined || resolution === null) return state;
      // A payment nobody can make is not a question: the answer is no (CR 117.12).
      if (op.pay !== undefined && !canPayMana(state, player, op.pay)) return state;
      return updateState(state, {
        resolution: {
          ...resolution,
          asking: {
            effects: op.effects,
            context,
            ...(op.pay === undefined ? {} : { pay: op.pay }),
          },
        },
        pendingDecision: { kind: 'yesNo', player, source: context.source, options: [true, false] },
      });
    }

    case 'discard':
      return discard(state, context, op);

    case 'scry':
    case 'surveil':
      return look(state, context, asLook(op));

    case 'lookAtTop':
      return look(state, context, op);

    default:
      return applyOp(state, emitter, context, op);
  }
};

/**
 * "Discards N cards", chosen by the player discarding (CR 701.9b). With more than one
 * player, each in turn as a frame of their own (CR 101.4); with fewer cards in hand than
 * asked for, all of them; with none, nothing to ask.
 */
const discard = (
  state: GameState,
  context: EffectContext,
  op: Extract<EffectOp, { op: 'discard' }>,
): GameState => {
  const players = resolvePlayers(state, context, op.player);
  if (players.length > 1) {
    return push(state, [
      {
        effects: players.map(
          (player): EffectOp => ({
            op: 'discard',
            player: { kind: 'player', player },
            count: op.count,
          }),
        ),
        next: 0,
        context,
      },
    ]);
  }
  const [player] = players;
  if (player === undefined) return state;
  const hand = objectsIn(state, playerZone(player, 'hand'));
  const count = Math.min(hand.length, Math.max(0, evaluateQuantity(state, context, op.count)));
  if (count === 0) return state;
  return updateState(state, {
    pendingDecision: { kind: 'discard', player: player as PlayerId, count, from: hand },
  });
};

/**
 * "Look at the top N cards of your library …", scry and surveil: started here and run by
 * `runResolution` until it is done (`looking.ts`). With more than one player, each in
 * turn as a frame of their own, as a discard is.
 */
const look = (
  state: GameState,
  context: EffectContext,
  op: Extract<EffectOp, { op: 'lookAtTop' }>,
): GameState => {
  const players = lookers(state, context, op);
  if (players.length > 1) {
    return push(state, [
      {
        effects: players.map((player): EffectOp => ({ ...op, player: { kind: 'player', player } })),
        next: 0,
        context,
      },
    ]);
  }
  const [player] = players;
  if (player === undefined) return state;
  const looking = beginLook(state, context, player, op);
  return looking === null ? state : withLooking(state, looking);
};
