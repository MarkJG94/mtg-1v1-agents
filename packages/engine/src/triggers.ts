import { type ObjectId, opponentOf, type PlayerId, type Step } from '@mtg/shared';
import type { GameState } from './state/game-state.js';
import type { GameObject } from './state/object.js';
import { getObject, objectsIn, updateState } from './state/update.js';
import { noKeywords } from './targeting.js';

/**
 * Triggered abilities (CR 603).
 *
 * A trigger is not a thing a player does. It fires on its own the moment its event
 * happens, waits until a player would next receive priority, and only then goes on the
 * stack (CR 603.3). That gap is the whole of why this is a pipeline rather than a
 * function call: the creature that died is already in the graveyard by the time its
 * "when this dies" ability goes on the stack, so the ability has to remember what it was.
 *
 * Abilities are described as data so they can live in `GameState` and a game stays a pure
 * function of its decisions. Card scripts in roadmap 2.1 supply the descriptions and
 * attach behaviour to `id`; the pipeline here does not change.
 */

/** What makes an ability trigger. */
export type TriggerWhen =
  | { readonly kind: 'selfEntersBattlefield' }
  | { readonly kind: 'anotherEntersBattlefield' }
  | { readonly kind: 'selfDies' }
  | { readonly kind: 'anotherDies' }
  | { readonly kind: 'selfAttacks' }
  | { readonly kind: 'selfBlocks' }
  | { readonly kind: 'beginningOfUpkeep'; readonly whose: 'self' | 'any' }
  | { readonly kind: 'beginningOfEndStep'; readonly whose: 'self' | 'any' };

/**
 * An intervening-if clause (CR 603.4): the "if" in "at the beginning of your upkeep, if
 * you have 5 or less life, ...". Checked twice — once when the ability would go on the
 * stack, and again as it resolves — and the ability does nothing if it is false either
 * time. Data rather than a predicate so it can sit in the state; 2.1 widens the union.
 */
export type InterveningCondition =
  | { readonly kind: 'always' }
  | { readonly kind: 'controllerLifeAtMost'; readonly amount: number }
  | { readonly kind: 'controllerLifeAtLeast'; readonly amount: number }
  | { readonly kind: 'sourceIsTapped' }
  | { readonly kind: 'controllerControlsAtLeast'; readonly count: number };

export interface TriggeredAbility {
  /** Identifies the ability so a card script can attach what it actually does. */
  readonly id: string;
  readonly when: TriggerWhen;
  readonly interveningIf?: InterveningCondition;
  /** CR 603.3: some abilities trigger only once in a turn. */
  readonly onceEachTurn?: boolean;
}

/**
 * A trigger that has fired and is waiting to go on the stack.
 *
 * `lastKnown` is the point of the whole structure: a dies trigger's source has left the
 * battlefield, so anything the ability needs to know about it — its power, its counters,
 * what it was attached to — must be captured as it was (CR 603.10, "last known
 * information"), not looked up later.
 */
export interface TriggerInstance {
  readonly abilityId: string;
  readonly source: ObjectId;
  readonly controller: PlayerId;
  readonly lastKnown: GameObject;
  readonly interveningIf: InterveningCondition;
}

/** A trigger set up by an effect to fire later, e.g. "at the beginning of the next end step". */
export interface DelayedTrigger {
  readonly abilityId: string;
  readonly source: ObjectId;
  readonly controller: PlayerId;
  readonly when: TriggerWhen;
  /** Delayed triggers usually fire once and are then gone (CR 603.7b). */
  readonly once: boolean;
}

// --- Conditions ---

export const evaluateCondition = (
  state: GameState,
  condition: InterveningCondition,
  instance: { readonly controller: PlayerId; readonly lastKnown: GameObject },
): boolean => {
  switch (condition.kind) {
    case 'always':
      return true;
    case 'controllerLifeAtMost':
      return state.players[instance.controller].life <= condition.amount;
    case 'controllerLifeAtLeast':
      return state.players[instance.controller].life >= condition.amount;
    case 'sourceIsTapped':
      return state.objects.get(instance.lastKnown.id)?.tapped ?? instance.lastKnown.tapped;
    case 'controllerControlsAtLeast':
      return (
        objectsIn(state, 'battlefield').filter(
          (id) => getObject(state, id).controller === instance.controller,
        ).length >= condition.count
      );
  }
};

// --- Detection ---

const matchesZoneChange = (
  when: TriggerWhen,
  watcher: ObjectId,
  moved: ObjectId,
  kind: 'enters' | 'dies',
): boolean => {
  const self = watcher === moved;
  switch (when.kind) {
    case 'selfEntersBattlefield':
      return kind === 'enters' && self;
    case 'anotherEntersBattlefield':
      return kind === 'enters' && !self;
    case 'selfDies':
      return kind === 'dies' && self;
    case 'anotherDies':
      return kind === 'dies' && !self;
    default:
      return false;
  }
};

const instanceFor = (watcher: GameObject, ability: TriggeredAbility): TriggerInstance => ({
  abilityId: ability.id,
  source: watcher.id,
  controller: watcher.controller,
  lastKnown: watcher,
  interveningIf: ability.interveningIf ?? { kind: 'always' },
});

const firedKey = (source: ObjectId, abilityId: string): string => `${source}:${abilityId}`;

const notYetFired = (state: GameState, ability: TriggeredAbility, source: ObjectId): boolean =>
  ability.onceEachTurn !== true ||
  !state.triggersFiredThisTurn.includes(firedKey(source, ability.id));

/**
 * Triggers fired by an object entering the battlefield or dying.
 *
 * `movedSnapshot` is the object as it was *before* the move, which is what a dies trigger
 * on the moved object itself must remember.
 */
export const triggersFromZoneChange = (
  state: GameState,
  moved: ObjectId,
  movedSnapshot: GameObject,
  kind: 'enters' | 'dies',
): readonly TriggerInstance[] => {
  const found: TriggerInstance[] = [];

  // Watchers still on the battlefield see "another creature" events.
  for (const id of objectsIn(state, 'battlefield')) {
    const watcher = getObject(state, id);
    for (const ability of watcher.triggers) {
      if (id === moved) continue;
      if (!matchesZoneChange(ability.when, id, moved, kind)) continue;
      if (!notYetFired(state, ability, id)) continue;
      found.push(instanceFor(watcher, ability));
    }
  }

  // The moved object's own triggers use the snapshot, since it may have left.
  for (const ability of movedSnapshot.triggers) {
    if (!matchesZoneChange(ability.when, moved, moved, kind)) continue;
    if (!notYetFired(state, ability, moved)) continue;
    found.push(instanceFor(movedSnapshot, ability));
  }

  return found;
};

/** Triggers fired by a creature being declared as an attacker (CR 508.2). */
export const triggersFromAttack = (
  state: GameState,
  attacker: ObjectId,
): readonly TriggerInstance[] => {
  const object = state.objects.get(attacker);
  if (!object) return [];
  return object.triggers
    .filter(
      (ability) => ability.when.kind === 'selfAttacks' && notYetFired(state, ability, attacker),
    )
    .map((ability) => instanceFor(object, ability));
};

/** Triggers fired by a creature being declared as a blocker. */
export const triggersFromBlock = (
  state: GameState,
  blocker: ObjectId,
): readonly TriggerInstance[] => {
  const object = state.objects.get(blocker);
  if (!object) return [];
  return object.triggers
    .filter((ability) => ability.when.kind === 'selfBlocks' && notYetFired(state, ability, blocker))
    .map((ability) => instanceFor(object, ability));
};

const stepMatches = (when: TriggerWhen, step: Step): boolean =>
  (when.kind === 'beginningOfUpkeep' && step === 'upkeep') ||
  (when.kind === 'beginningOfEndStep' && step === 'end');

const whoseMatches = (when: TriggerWhen, controller: PlayerId, activePlayer: PlayerId): boolean => {
  if (when.kind !== 'beginningOfUpkeep' && when.kind !== 'beginningOfEndStep') return false;
  return when.whose === 'any' || controller === activePlayer;
};

/** Triggers fired by a step beginning, such as "at the beginning of your upkeep". */
export const triggersFromStep = (state: GameState, step: Step): readonly TriggerInstance[] => {
  const found: TriggerInstance[] = [];
  for (const id of objectsIn(state, 'battlefield')) {
    const object = getObject(state, id);
    for (const ability of object.triggers) {
      if (!stepMatches(ability.when, step)) continue;
      if (!whoseMatches(ability.when, object.controller, state.activePlayer)) continue;
      if (!notYetFired(state, ability, id)) continue;
      found.push(instanceFor(object, ability));
    }
  }
  return found;
};

/** Delayed triggers waiting on this step, and the ones that survive to wait again. */
export const fireDelayedTriggers = (
  state: GameState,
  step: Step,
): {
  readonly fired: readonly TriggerInstance[];
  readonly remaining: readonly DelayedTrigger[];
} => {
  const fired: TriggerInstance[] = [];
  const remaining: DelayedTrigger[] = [];

  for (const delayed of state.delayedTriggers) {
    const matches =
      stepMatches(delayed.when, step) &&
      whoseMatches(delayed.when, delayed.controller, state.activePlayer);
    if (!matches) {
      remaining.push(delayed);
      continue;
    }

    const source = state.objects.get(delayed.source);
    fired.push({
      abilityId: delayed.abilityId,
      source: delayed.source,
      controller: delayed.controller,
      // A delayed trigger can outlive its source, so fall back to a stand-in.
      lastKnown: source ?? standInFor(delayed),
      interveningIf: { kind: 'always' },
    });
    if (!delayed.once) remaining.push(delayed);
  }

  return { fired, remaining };
};

/**
 * A minimal object standing in for a delayed trigger's source that has left the game.
 * Only its identity and controller are ever read.
 */
const standInFor = (delayed: DelayedTrigger): GameObject => ({
  id: delayed.source,
  definitionId: '' as GameObject['definitionId'],
  owner: delayed.controller,
  controller: delayed.controller,
  zone: 'exile',
  timestamp: 0,
  tapped: false,
  counters: {},
  damage: 0,
  attachedTo: null,
  attachments: [],
  chosen: {},
  token: false,
  keywords: noKeywords,
  power: null,
  toughness: null,
  loyalty: null,
  name: null,
  legendary: false,
  colours: [],
  attachment: null,
  deathtouched: false,
  triggers: [],
  loyaltyAbilities: [],
  summoningSick: false,
});

// --- Queueing ---

/** Add fired triggers to the queue that empties next time a player would get priority. */
export const queueTriggers = (state: GameState, fired: readonly TriggerInstance[]): GameState => {
  if (fired.length === 0) return state;

  const firedKeys = fired
    .filter((instance) => instance.abilityId !== '')
    .map((instance) => firedKey(instance.source, instance.abilityId));

  return updateState(state, {
    pendingTriggers: [...state.pendingTriggers, ...fired],
    triggersFiredThisTurn: [...state.triggersFiredThisTurn, ...firedKeys],
  });
};

/** Add a delayed trigger, set up by an effect to fire at some later step (CR 603.7). */
export const addDelayedTrigger = (state: GameState, delayed: DelayedTrigger): GameState =>
  updateState(state, { delayedTriggers: [...state.delayedTriggers, delayed] });

/**
 * Split the queue by controller in APNAP order (CR 603.3b): the active player's triggers
 * go on the stack first, then the non-active player's — so the non-active player's
 * resolve first, the stack being what it is.
 */
export const triggersInApnapOrder = (
  state: GameState,
): {
  readonly active: readonly TriggerInstance[];
  readonly nonActive: readonly TriggerInstance[];
} => {
  const active = state.pendingTriggers.filter((t) => t.controller === state.activePlayer);
  const nonActive = state.pendingTriggers.filter(
    (t) => t.controller === opponentOf(state.activePlayer),
  );
  return { active, nonActive };
};
