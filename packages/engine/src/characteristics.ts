import type { GameObject } from './state/object.js';

/**
 * Derived characteristics.
 *
 * Today this is one slice of what the layer system will do in roadmap 1.9: applying
 * +1/+1 and -1/-1 counters to power and toughness, which is layer 7c (CR 613.4c). It
 * lives behind functions rather than being read off the object directly, so when 1.9
 * arrives with the full layer stack — and `characteristics(state, id)` memoised per state
 * version — the callers here do not change.
 *
 * State-based actions cannot be written without this: a 2/2 carrying a -1/-1 counter is a
 * 1/1, and whether 1 damage is lethal depends on knowing that.
 */

export const counterCount = (object: GameObject, kind: string): number =>
  object.counters[kind] ?? 0;

/** Treated as a creature while card types wait on roadmap 2.1. */
export const isCreature = (object: GameObject): boolean =>
  object.power !== null && object.toughness !== null;

/** Whether this is a planeswalker, which is what makes the loyalty SBA apply. */
export const isPlaneswalker = (object: GameObject): boolean => object.loyalty !== null;

const counterAdjustment = (object: GameObject): number =>
  counterCount(object, '+1/+1') - counterCount(object, '-1/-1');

export const effectivePower = (object: GameObject): number =>
  object.power === null ? 0 : object.power + counterAdjustment(object);

export const effectiveToughness = (object: GameObject): number =>
  object.toughness === null ? 0 : object.toughness + counterAdjustment(object);

/**
 * Toughness left before marked damage becomes lethal. Damage stays marked until cleanup
 * (CR 514.2), so it accumulates across a turn.
 */
export const remainingToughness = (object: GameObject): number =>
  effectiveToughness(object) - object.damage;

/** A planeswalker's loyalty is simply the number of loyalty counters on it (CR 306.5b). */
export const currentLoyalty = (object: GameObject): number => counterCount(object, 'loyalty');
