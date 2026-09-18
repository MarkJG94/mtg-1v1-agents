import { type EventTarget, isMainPhase, type ObjectId, type PlayerId } from '@mtg/shared';
import { counterCount, currentLoyalty, isPlaneswalker } from './characteristics.js';
import type { EventEmitter } from './events/emitter.js';
import { isStackEmpty, putActivatedAbilityOnStack } from './stack.js';
import type { GameState } from './state/game-state.js';
import { withCounters } from './state/object.js';
import { getObject, objectsIn, updateObject, updateState } from './state/update.js';

/**
 * Planeswalkers (CR 306) and their loyalty abilities (CR 606).
 *
 * Three things make a planeswalker different from any other permanent, and all three are
 * about loyalty counters rather than about a card type:
 *
 * - It arrives with loyalty counters equal to its printed loyalty (CR 306.5b). That is
 *   seeded into the "enters the battlefield" event in `resolveTopOfStack`, not set
 *   afterwards, so a replacement effect such as Doubling Season can double it.
 * - Damage dealt to it removes that many loyalty counters instead of being marked
 *   (CR 306.8), which `performEvents` does.
 * - It dies to a state-based action at zero loyalty (CR 704.5i), which `sba.ts` does.
 *
 * What lives here is the fourth: activating a loyalty ability. The cost is putting
 * counters on or taking them off, and the timing is the tightest in the game — sorcery
 * speed, and at most one per planeswalker per turn.
 */

export interface LoyaltyAbility {
  /** Identifies the ability so a card script can attach what it actually does. */
  readonly id: string;
  /**
   * Signed, as it is printed: `+2` puts two loyalty counters on, `-3` removes three
   * (CR 606.2). Zero is a legal cost and costs nothing.
   */
  readonly cost: number;
}

export class IllegalLoyaltyActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalLoyaltyActivationError';
  }
}

/**
 * Whether a loyalty ability may be activated right now (CR 606.3).
 *
 * Returns the reason it may not, rather than a bare `false`, because `legalActions` and
 * the activation itself must agree exactly — the one invariant docs/09 asks of legality
 * is that the engine never rejects an action it offered.
 */
export const whyNotActivateLoyalty = (
  state: GameState,
  player: PlayerId,
  source: ObjectId,
  abilityId: string,
): string | null => {
  const object = state.objects.get(source);
  if (!object) return `there is no object ${source}`;
  if (object.zone !== 'battlefield') return `object ${source} is not on the battlefield`;
  if (!isPlaneswalker(state, source)) return `object ${source} is not a planeswalker`;
  if (object.controller !== player) return `${player} does not control object ${source}`;

  const ability = object.loyaltyAbilities.find((candidate) => candidate.id === abilityId);
  if (!ability) return `object ${source} has no loyalty ability "${abilityId}"`;

  // CR 606.3: sorcery speed, and only on your own turn.
  if (state.priority !== player) return `${player} does not have priority`;
  if (state.activePlayer !== player) return 'a loyalty ability can only be activated on your turn';
  if (!isMainPhase(state.step)) return 'a loyalty ability can only be activated in a main phase';
  if (!isStackEmpty(state)) return 'a loyalty ability can only be activated with an empty stack';

  // CR 606.3: once per permanent per turn, whoever controlled it at the time.
  if (state.loyaltyActivatedThisTurn.includes(source)) {
    return `object ${source} has already had a loyalty ability activated this turn`;
  }

  // A cost that removes counters cannot be paid with fewer than that many (CR 606.3).
  if (ability.cost < 0 && currentLoyalty(state, source) < -ability.cost) {
    return `object ${source} has ${currentLoyalty(state, source)} loyalty, not enough to pay ${ability.cost}`;
  }

  return null;
};

export const canActivateLoyalty = (
  state: GameState,
  player: PlayerId,
  source: ObjectId,
  abilityId: string,
): boolean => whyNotActivateLoyalty(state, player, source, abilityId) === null;

export interface ActivatableLoyaltyAbility {
  readonly source: ObjectId;
  readonly ability: LoyaltyAbility;
}

/**
 * Every loyalty ability this player could activate right now.
 *
 * The timing conditions are asked first, before anything is walked. CR 606.3 gives a
 * loyalty ability the timing of a sorcery, and that is a fact about the *turn*, not about
 * any permanent: outside your own main phase with an empty stack, no planeswalker you
 * control has an activatable ability and there is nothing on the battlefield worth
 * looking at. `legalActions` calls this on every priority grant, and four grants in five
 * are in a step where the answer cannot be anything but none.
 */
export const legalLoyaltyAbilities = (
  state: GameState,
  player: PlayerId,
): readonly ActivatableLoyaltyAbility[] => {
  if (state.priority !== player) return [];
  if (state.activePlayer !== player) return [];
  if (!isMainPhase(state.step)) return [];
  if (!isStackEmpty(state)) return [];

  const found: ActivatableLoyaltyAbility[] = [];
  for (const id of objectsIn(state, 'battlefield')) {
    for (const ability of getObject(state, id).loyaltyAbilities) {
      if (canActivateLoyalty(state, player, id, ability.id)) found.push({ source: id, ability });
    }
  }
  return found;
};

/**
 * Activate a loyalty ability (CR 606.2-3): pay the cost in loyalty counters, put the
 * ability on the stack, and take priority back (CR 117.3c).
 *
 * The cost is paid on activation, not on resolution, so an ultimate that empties a
 * planeswalker's loyalty kills it to a state-based action while its ability is still on
 * the stack — and the ability resolves anyway. Paying is a *cost*, so effects that
 * multiply counters an effect would place (Doubling Season) do not touch it, which is why
 * this writes the counters directly rather than proposing an `addCounters` event.
 */
export const activateLoyaltyAbility = (
  state: GameState,
  emitter: EventEmitter,
  player: PlayerId,
  source: ObjectId,
  abilityId: string,
  /** Targets chosen as the ability is activated (CR 601.2c, through CR 602.2b). */
  targets: readonly EventTarget[] = [],
): GameState => {
  const problem = whyNotActivateLoyalty(state, player, source, abilityId);
  if (problem !== null) throw new IllegalLoyaltyActivationError(problem);

  const object = getObject(state, source);
  const ability = object.loyaltyAbilities.find((candidate) => candidate.id === abilityId);
  if (!ability) throw new IllegalLoyaltyActivationError(`no loyalty ability "${abilityId}"`);

  const from = counterCount(object, 'loyalty');
  const to = Math.max(0, from + ability.cost);

  let next = updateObject(state, source, {
    counters: withCounters(object, 'loyalty', to).counters,
  });
  if (to !== from) {
    emitter.emit(next, { type: 'counterChange', object: source, counter: 'loyalty', from, to });
  }

  next = updateState(next, {
    loyaltyActivatedThisTurn: [...next.loyaltyActivatedThisTurn, source],
  });

  return putActivatedAbilityOnStack(next, emitter, {
    abilityId,
    source,
    controller: player,
    definitionId: object.definitionId,
    targets,
  });
};
