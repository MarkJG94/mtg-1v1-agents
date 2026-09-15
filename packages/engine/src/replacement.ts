import type { CounterKind, EventTarget, ObjectId, PlayerId, ZoneId } from '@mtg/shared';
import { opponentOf } from '@mtg/shared';
import { staticReplacements } from './cards/statics.js';
import type { CombatState } from './combat.js';
import { affectedPlayer, type RulesEvent } from './events/rules-event.js';
import type { GameState } from './state/game-state.js';
import { updateObject, updateState } from './state/update.js';

/**
 * Replacement and prevention effects (CR 614–616).
 *
 * A replacement effect watches for an event and changes it before it happens. "If a
 * creature would die, exile it instead", "this enters tapped", "prevent the next 3 damage
 * that would be dealt to you" are all the same machine: an event is proposed, every
 * applicable effect gets a look at it, and what comes out the other end is what actually
 * happens. Prevention effects (CR 615) are a species of replacement — they replace some
 * or all of a damage event with nothing — so they live here rather than in a system of
 * their own.
 *
 * Three rules shape the loop and are easy to get wrong:
 *
 * - **An effect never applies twice to the same event** (CR 614.5). Without this,
 *   "if a creature would die, return it to your hand instead" would loop forever, since
 *   its own output is another event of the kind it watches for.
 * - **Self-replacement goes first** (CR 616.1a): an effect from the very object the event
 *   is about, modifying how that object arrives or leaves, is applied before any outside
 *   effect gets a say.
 * - **When more than one still applies, the affected player chooses** (CR 616.1) — the
 *   damaged player, the dying creature's controller — and then the loop starts over,
 *   because the choice may have changed what applies.
 *
 * Like continuous effects, these are data rather than functions, so they live in
 * `GameState` and a game stays a pure function of its seed and decisions. Card scripts in
 * roadmap 2.1 build them; the pipeline here does not change.
 */

// --- Describing an effect ---

/** `'source'` and `'sourceController'` follow the effect's own source object. */
export type PlayerRef = PlayerId | 'sourceController' | 'sourceOpponent' | 'any';
export type ObjectRef = ObjectId | 'source' | 'any';

/** Which events an effect watches for. One matcher kind per kind of event. */
export type EventMatcher =
  | { readonly kind: 'damageToPlayer'; readonly player: PlayerRef; readonly combatOnly?: boolean }
  | { readonly kind: 'damageToObject'; readonly object: ObjectRef; readonly combatOnly?: boolean }
  | { readonly kind: 'draw'; readonly player: PlayerRef }
  | { readonly kind: 'entersBattlefield'; readonly object: ObjectRef }
  | {
      readonly kind: 'movesToZone';
      readonly object: ObjectRef;
      readonly from?: ZoneId;
      readonly to: ZoneId;
      /** Only destruction (CR 701.7), which is what a regeneration shield replaces. */
      readonly destructionOnly?: boolean;
    }
  | {
      readonly kind: 'lifeChange';
      readonly player: PlayerRef;
      readonly direction: 'gain' | 'lose';
    }
  | {
      readonly kind: 'addCounters';
      readonly object: ObjectRef;
      readonly counter?: CounterKind;
      /** Also watch the counters a permanent enters the battlefield with (CR 614.1c). */
      readonly onEntry?: boolean;
    };

export type ReplacementChange =
  /** CR 615. A numeric amount is a shield that is used up as it absorbs damage. */
  | { readonly kind: 'preventDamage'; readonly amount: number | 'all' }
  /** "Deals double damage", "deals 1 less damage". */
  | { readonly kind: 'modifyDamage'; readonly multiply?: number; readonly add?: number }
  /** "Damage that would be dealt to you is dealt to this creature instead." */
  | { readonly kind: 'redirectDamage'; readonly to: EventTarget }
  /** CR 614.1c, the "as this enters" family. */
  | { readonly kind: 'entersTapped' }
  | {
      readonly kind: 'entersWithCounters';
      readonly counter: CounterKind;
      readonly amount: number;
    }
  /** "If it would die, exile it instead." */
  | { readonly kind: 'moveToZoneInstead'; readonly to: ZoneId }
  /** CR 701.15: tap it, remove it from combat, remove its damage, and it does not die. */
  | { readonly kind: 'regenerate' }
  | { readonly kind: 'modifyLife'; readonly multiply?: number; readonly add?: number }
  | { readonly kind: 'modifyCounters'; readonly multiply?: number; readonly add?: number }
  /** "Instead, nothing happens." Also how a skipped draw is expressed. */
  | { readonly kind: 'skip' };

export type ReplacementDuration =
  | { readonly kind: 'permanent' }
  | { readonly kind: 'untilEndOfTurn' }
  | { readonly kind: 'whileSourceOnBattlefield' };

export interface ReplacementEffect {
  readonly id: number;
  readonly source: ObjectId;
  readonly controller: PlayerId;
  readonly applies: EventMatcher;
  readonly change: ReplacementChange;
  readonly duration: ReplacementDuration;
  /**
   * CR 616.1a: an effect that modifies how its own source enters or leaves applies
   * before any effect from elsewhere. "This enters tapped" is the everyday case.
   */
  readonly selfReplacement?: boolean;
  /**
   * How many more times this can apply before it is gone, for the "the next time..."
   * family (CR 701.15). Absent means it never runs out. A numeric `preventDamage`
   * shield shrinks its own amount instead and needs no `uses`.
   */
  readonly uses?: number;
}

// --- Creating and retiring ---

export type ReplacementSpec = Omit<ReplacementEffect, 'id'>;

/** Add a replacement effect. Ids are shared with continuous effects so logs never clash. */
export const addReplacement = (
  state: GameState,
  spec: ReplacementSpec,
): { readonly state: GameState; readonly effect: ReplacementEffect } => {
  const effect: ReplacementEffect = { ...spec, id: state.nextEffectId };
  return {
    state: updateState(state, {
      replacements: [...state.replacements, effect],
      nextEffectId: state.nextEffectId + 1,
    }),
    effect,
  };
};

export const removeReplacement = (state: GameState, id: number): GameState =>
  updateState(state, { replacements: state.replacements.filter((effect) => effect.id !== id) });

/** Replacements currently in force, ignoring those whose source has left the battlefield. */
export const activeReplacements = (state: GameState): readonly ReplacementEffect[] =>
  [...state.replacements, ...staticReplacements(state)].filter((effect) => {
    if (effect.duration.kind !== 'whileSourceOnBattlefield') return true;
    return state.objects.get(effect.source)?.zone === 'battlefield';
  });

/**
 * Drop "until end of turn" replacements, including unused regeneration shields
 * (CR 701.15b). Called from cleanup alongside the continuous-effect equivalent.
 */
export const expireEndOfTurnReplacements = (state: GameState): GameState => {
  const remaining = state.replacements.filter(
    (effect) => effect.duration.kind !== 'untilEndOfTurn',
  );
  return remaining.length === state.replacements.length
    ? state
    : updateState(state, { replacements: remaining });
};

// --- Matching ---

const resolvePlayerRef = (
  state: GameState,
  effect: ReplacementEffect,
  ref: PlayerRef,
  player: PlayerId,
): boolean => {
  switch (ref) {
    case 'any':
      return true;
    case 'sourceController':
      return player === (state.objects.get(effect.source)?.controller ?? effect.controller);
    case 'sourceOpponent':
      return (
        player === opponentOf(state.objects.get(effect.source)?.controller ?? effect.controller)
      );
    default:
      return player === ref;
  }
};

const resolveObjectRef = (effect: ReplacementEffect, ref: ObjectRef, object: ObjectId): boolean =>
  ref === 'any' ? true : ref === 'source' ? object === effect.source : object === ref;

/** Whether this effect watches for this event. */
export const matches = (
  state: GameState,
  effect: ReplacementEffect,
  event: RulesEvent,
): boolean => {
  const matcher = effect.applies;
  switch (matcher.kind) {
    case 'damageToPlayer':
      return (
        event.kind === 'damage' &&
        event.target.kind === 'player' &&
        (!matcher.combatOnly || event.combat) &&
        resolvePlayerRef(state, effect, matcher.player, event.target.player)
      );
    case 'damageToObject':
      return (
        event.kind === 'damage' &&
        event.target.kind === 'object' &&
        (!matcher.combatOnly || event.combat) &&
        resolveObjectRef(effect, matcher.object, event.target.object)
      );
    case 'draw':
      return event.kind === 'draw' && resolvePlayerRef(state, effect, matcher.player, event.player);
    case 'entersBattlefield':
      return (
        event.kind === 'entersBattlefield' && resolveObjectRef(effect, matcher.object, event.object)
      );
    case 'movesToZone':
      return (
        event.kind === 'moveZone' &&
        event.to === matcher.to &&
        (matcher.from === undefined || event.from === matcher.from) &&
        (!matcher.destructionOnly || event.destruction) &&
        resolveObjectRef(effect, matcher.object, event.object)
      );
    case 'lifeChange':
      return (
        event.kind === (matcher.direction === 'gain' ? 'gainLife' : 'loseLife') &&
        resolvePlayerRef(state, effect, matcher.player, event.player)
      );
    case 'addCounters':
      if (event.kind === 'entersBattlefield') {
        // Counters a permanent enters with are counters being placed, so an effect that
        // watches for them sees this too — but only when the event actually has some.
        return (
          matcher.onEntry === true &&
          Object.keys(event.counters).length > 0 &&
          (matcher.counter === undefined || event.counters[matcher.counter] !== undefined) &&
          resolveObjectRef(effect, matcher.object, event.object)
        );
      }
      return (
        event.kind === 'addCounters' &&
        (matcher.counter === undefined || event.counter === matcher.counter) &&
        resolveObjectRef(effect, matcher.object, event.object)
      );
  }
};

// --- Applying one effect ---

const scale = (amount: number, multiply: number | undefined, add: number | undefined): number =>
  Math.max(0, Math.round(amount * (multiply ?? 1)) + (add ?? 0));

/** Take a creature out of combat (CR 506.4), which regeneration does. */
const withoutInCombat = (combat: CombatState | null, id: ObjectId): CombatState | null => {
  if (!combat) return null;
  return {
    ...combat,
    attackers: combat.attackers
      .filter((entry) => entry.attacker !== id)
      .map((entry) =>
        entry.blockedBy.includes(id)
          ? { ...entry, blockedBy: entry.blockedBy.filter((blocker) => blocker !== id) }
          : entry,
      ),
  };
};

/**
 * Whatever an effect leaves behind: the state it changed on the way, and the events that
 * take the original's place. Zero events means the original has been replaced by nothing.
 */
interface Applied {
  readonly state: GameState;
  readonly events: readonly RulesEvent[];
}

/** Rewrite or retire the effect itself after it has applied. */
const consume = (
  state: GameState,
  effect: ReplacementEffect,
  patch?: Partial<ReplacementEffect>,
): GameState => {
  const uses = effect.uses === undefined ? undefined : effect.uses - 1;
  if (uses !== undefined && uses <= 0) return removeReplacement(state, effect.id);

  // An effect with no shield and no use count is unchanged by applying. Rewriting it
  // anyway would bump the state version and throw away the characteristics memo.
  if (uses === undefined && patch === undefined) return state;

  const updated: ReplacementEffect = {
    ...effect,
    ...patch,
    ...(uses === undefined ? {} : { uses }),
  };
  return updateState(state, {
    replacements: state.replacements.map((candidate) =>
      candidate.id === effect.id ? updated : candidate,
    ),
  });
};

const applyChange = (state: GameState, effect: ReplacementEffect, event: RulesEvent): Applied => {
  const change = effect.change;

  switch (change.kind) {
    case 'skip':
      return { state: consume(state, effect), events: [] };

    case 'preventDamage': {
      if (event.kind !== 'damage') break;
      if (change.amount === 'all') {
        return { state: consume(state, effect), events: [] };
      }
      const prevented = Math.min(change.amount, event.amount);
      const left = change.amount - prevented;
      // CR 615.7: a shield shrinks by what it absorbed and is gone once empty.
      const next =
        left > 0
          ? consume(state, effect, { change: { kind: 'preventDamage', amount: left } })
          : removeReplacement(state, effect.id);
      const remaining = event.amount - prevented;
      return { state: next, events: remaining > 0 ? [{ ...event, amount: remaining }] : [] };
    }

    case 'modifyDamage': {
      if (event.kind !== 'damage') break;
      const amount = scale(event.amount, change.multiply, change.add);
      return {
        state: consume(state, effect),
        events: amount > 0 ? [{ ...event, amount }] : [],
      };
    }

    case 'redirectDamage': {
      if (event.kind !== 'damage') break;
      return { state: consume(state, effect), events: [{ ...event, target: change.to }] };
    }

    case 'entersTapped': {
      if (event.kind !== 'entersBattlefield') break;
      return { state: consume(state, effect), events: [{ ...event, tapped: true }] };
    }

    case 'entersWithCounters': {
      if (event.kind !== 'entersBattlefield') break;
      const counters = {
        ...event.counters,
        [change.counter]: (event.counters[change.counter] ?? 0) + change.amount,
      };
      return { state: consume(state, effect), events: [{ ...event, counters }] };
    }

    case 'moveToZoneInstead': {
      if (event.kind !== 'moveZone') break;
      return {
        state: consume(state, effect),
        // Going somewhere else instead is no longer destruction (CR 614.1).
        events: [{ ...event, to: change.to, cause: 'effect', destruction: false }],
      };
    }

    case 'regenerate': {
      if (event.kind !== 'moveZone') break;
      const regenerated = updateObject(consume(state, effect), event.object, {
        tapped: true,
        damage: 0,
        deathtouched: false,
      });
      return {
        state: updateState(regenerated, {
          combat: withoutInCombat(regenerated.combat, event.object),
        }),
        events: [],
      };
    }

    case 'modifyLife': {
      if (event.kind !== 'gainLife' && event.kind !== 'loseLife') break;
      const amount = scale(event.amount, change.multiply, change.add);
      return {
        state: consume(state, effect),
        events: amount > 0 ? [{ ...event, amount }] : [],
      };
    }

    case 'modifyCounters': {
      // Doubling Season's shape. It applies to counters placed on a permanent *as it
      // enters* too, which is how it doubles a planeswalker's starting loyalty
      // (CR 306.5b, 614.1c) — so this reads both kinds of event.
      if (event.kind === 'entersBattlefield') {
        const counters = Object.fromEntries(
          Object.entries(event.counters).map(([counter, amount]) => [
            counter,
            scale(amount, change.multiply, change.add),
          ]),
        );
        return { state: consume(state, effect), events: [{ ...event, counters }] };
      }
      if (event.kind !== 'addCounters') break;
      const amount = scale(event.amount, change.multiply, change.add);
      return {
        state: consume(state, effect),
        events: amount > 0 ? [{ ...event, amount }] : [],
      };
    }
  }

  // The matcher and the change disagree about what kind of event this is, which is a
  // malformed effect. Leave the event alone rather than silently doing the wrong thing.
  return { state: consume(state, effect), events: [event] };
};

// --- The loop ---

/** An event still to be replaced, with the effects that have already had their turn. */
export interface PendingEvent {
  readonly event: RulesEvent;
  /** CR 614.5: effect ids that may not apply to this event again. */
  readonly applied: readonly number[];
}

/**
 * What to do once every event in the batch has been through replacement. A closed union
 * rather than a callback, so a paused batch is plain data that a replay can reproduce.
 */
export type EventBatch =
  | { readonly kind: 'plain' }
  | { readonly kind: 'combatDamage'; readonly firstStrike: boolean };

/** A batch stopped part-way because a player has to choose (CR 616.1). */
export interface ReplacementProgress {
  readonly batch: EventBatch;
  /** Events that are finished with; they happen once the whole batch is resolved. */
  readonly resolved: readonly RulesEvent[];
  /** Still to go. The first is the one the pending choice is about. */
  readonly queue: readonly PendingEvent[];
  readonly player: PlayerId;
  readonly options: readonly number[];
}

export type BatchResult =
  | { readonly kind: 'ready'; readonly state: GameState; readonly events: readonly RulesEvent[] }
  /** The state carries a `chooseReplacement` decision and the progress to resume from. */
  | { readonly kind: 'waiting'; readonly state: GameState };

const controllerLookup =
  (state: GameState) =>
  (id: ObjectId): PlayerId =>
    state.objects.get(id)?.controller ?? state.activePlayer;

/**
 * Effects that could still apply to this event, self-replacement first (CR 616.1a).
 * Returns the self-replacement effects alone when there are any, because none of the
 * others may apply until every one of those has.
 */
export const applicableReplacements = (
  state: GameState,
  pending: PendingEvent,
): readonly ReplacementEffect[] => {
  const candidates = activeReplacements(state).filter(
    (effect) => !pending.applied.includes(effect.id) && matches(state, effect, pending.event),
  );
  const self = candidates.filter((effect) => effect.selfReplacement === true);
  return self.length > 0 ? self : candidates;
};

const afterApplying = (
  applied: Applied,
  effect: ReplacementEffect,
  from: PendingEvent,
): {
  readonly state: GameState;
  readonly queue: readonly PendingEvent[];
} => ({
  state: applied.state,
  queue: applied.events.map((event) => ({
    event,
    applied: [...from.applied, effect.id],
  })),
});

const runLoop = (
  state: GameState,
  batch: EventBatch,
  resolved: readonly RulesEvent[],
  queue: readonly PendingEvent[],
  limit = 200,
): BatchResult => {
  let current = state;
  const done = [...resolved];
  let pending = [...queue];

  for (let guard = 0; guard < limit; guard += 1) {
    const head = pending[0];
    if (head === undefined) return { kind: 'ready', state: current, events: done };

    const candidates = applicableReplacements(current, head);
    const only = candidates[0];

    if (only === undefined) {
      done.push(head.event);
      pending = pending.slice(1);
      continue;
    }

    if (candidates.length === 1) {
      const next = afterApplying(applyChange(current, only, head.event), only, head);
      current = next.state;
      pending = [...next.queue, ...pending.slice(1)];
      continue;
    }

    const player = affectedPlayer(head.event, controllerLookup(current));
    const options = candidates.map((candidate) => candidate.id);
    return {
      kind: 'waiting',
      state: updateState(current, {
        pendingReplacement: { batch, resolved: done, queue: pending, player, options },
        pendingDecision: {
          kind: 'chooseReplacement',
          player,
          options,
          event: head.event,
        },
      }),
    };
  }

  throw new Error(`replacement effects did not settle within ${limit} applications`);
};

/** Run a batch of proposed events past every applicable replacement effect. */
export const resolveReplacements = (
  state: GameState,
  batch: EventBatch,
  events: readonly RulesEvent[],
): BatchResult =>
  runLoop(
    state,
    batch,
    [],
    events.map((event) => ({ event, applied: [] })),
  );

export class UnknownReplacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownReplacementError';
  }
}

/** Continue a batch that stopped for a choice, applying the effect the player picked. */
export const resumeReplacements = (
  state: GameState,
  progress: ReplacementProgress,
  chosen: number,
): BatchResult => {
  if (!progress.options.includes(chosen)) {
    throw new UnknownReplacementError(
      `replacement effect ${chosen} is not one of the ${progress.options.length} that apply`,
    );
  }

  const head = progress.queue[0];
  if (head === undefined) {
    throw new UnknownReplacementError('the paused batch has no event left to replace');
  }

  const effect = activeReplacements(state).find((candidate) => candidate.id === chosen);
  if (!effect) throw new UnknownReplacementError(`no replacement effect ${chosen} is in force`);

  const next = afterApplying(applyChange(state, effect, head.event), effect, head);
  return runLoop(next.state, progress.batch, progress.resolved, [
    ...next.queue,
    ...progress.queue.slice(1),
  ]);
};
