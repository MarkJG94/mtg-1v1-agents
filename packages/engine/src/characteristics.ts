import type { ObjectId, PlayerId } from '@mtg/shared';
import { staticEffects } from './cards/statics.js';
import { noKeywords } from './keywords.js';
import {
  type Characteristics,
  type ContinuousEffect,
  type EffectSelector,
  type Layer,
  layerFor,
  layers,
} from './layers.js';
import type { GameState } from './state/game-state.js';
import type { GameObject } from './state/object.js';
import { updateState } from './state/update.js';

/**
 * `characteristics(state, id)` — what an object actually is right now (CR 613).
 *
 * Nothing reads power, toughness or keywords off a `GameObject` any more. The object
 * holds only its printed values; everything an effect could have changed is computed by
 * walking the layers in order. That is the difference between a Grizzly Bears that a
 * Glorious Anthem makes a 3/3 and one that merely remembers being 2/2.
 *
 * Results are memoised per state, which is safe because a `GameState` is immutable: the
 * same state always computes the same answer. Any change goes through the update helpers,
 * which produce a new state object and so a new cache entry.
 */

const cache = new WeakMap<GameState, Map<ObjectId, Characteristics>>();

export const counterCount = (object: GameObject, kind: string): number =>
  object.counters[kind] ?? 0;

/**
 * Effects that are currently doing anything, ignoring those whose source has gone.
 *
 * Two sources: effects the game registered — a pump spell's, a counter's — and the ones
 * the static abilities of permanents in play are making right now, which are derived
 * rather than stored (see `cards/statics.ts`).
 */
export const activeEffects = (state: GameState): readonly ContinuousEffect[] =>
  [...state.effects, ...staticEffects(state)].filter((effect) => {
    if (effect.duration.kind !== 'whileSourceOnBattlefield') return true;
    return state.objects.get(effect.source)?.zone === 'battlefield';
  });

const selectorMatches = (
  state: GameState,
  effect: ContinuousEffect,
  target: GameObject,
  controllerOfTarget: PlayerId,
  isCreature: boolean,
): boolean => {
  const selector: EffectSelector = effect.affects;
  switch (selector.kind) {
    case 'self':
      return target.id === effect.source;
    case 'object':
      return target.id === selector.object;
    case 'allPermanents':
      return target.zone === 'battlefield';
    case 'allCreatures':
      return target.zone === 'battlefield' && isCreature;
    case 'creaturesControlledBy': {
      if (target.zone !== 'battlefield' || !isCreature) return false;
      const wanted =
        selector.player === 'sourceController'
          ? (state.objects.get(effect.source)?.controller ?? null)
          : selector.player;
      return wanted !== null && controllerOfTarget === wanted;
    }
  }
};

/** Working set of characteristics as the layers are applied one after another. */
interface Working {
  power: number | null;
  toughness: number | null;
  keywords: Keywords;
  name: string | null;
  legendary: boolean;
  colours: readonly Colour[];
  controller: PlayerId;
}

type Keywords = Characteristics['keywords'];
type Colour = Characteristics['colours'][number];

const printedOf = (object: GameObject): Working => ({
  power: object.power,
  toughness: object.toughness,
  keywords: object.keywords,
  name: object.name,
  legendary: object.legendary,
  colours: object.colours,
  controller: object.controller,
});

const appliesTo = (
  state: GameState,
  effect: ContinuousEffect,
  object: GameObject,
  working: Working,
): boolean =>
  selectorMatches(
    state,
    effect,
    object,
    working.controller,
    working.power !== null && working.toughness !== null,
  );

/** Apply one effect's change to the working characteristics. */
const applyOne = (working: Working, effect: ContinuousEffect): Working => {
  const change = effect.change;
  switch (change.kind) {
    case 'changeControl':
      return { ...working, controller: change.controller };
    case 'becomesCreature':
      return { ...working, power: change.power, toughness: change.toughness };
    case 'setColours':
      return { ...working, colours: change.colours };
    case 'addKeyword':
      return { ...working, keywords: { ...working.keywords, [change.keyword]: true } };
    case 'removeAllAbilities':
      // Humility's half: everything printed goes, and only later effects can add back.
      return { ...working, keywords: noKeywords };
    case 'setPowerToughness':
      return { ...working, power: change.power, toughness: change.toughness };
    case 'modifyPowerToughness':
      return {
        ...working,
        power: (working.power ?? 0) + change.power,
        toughness: (working.toughness ?? 0) + change.toughness,
      };
    case 'switchPowerToughness':
      return { ...working, power: working.toughness, toughness: working.power };
  }
};

/**
 * Whether `effect` depends on `other` (CR 613.8a): would applying `other` first change
 * what `effect` applies to, or what it does?
 *
 * "What it applies to" is the case that bites, and it is detectable: apply `other`, then
 * ask again whether `effect` still picks this object out. Opalescence and Humility are
 * exactly this — one makes enchantments into creatures, and whether the other's "all
 * creatures" catches them depends on whether it went first.
 *
 * "What it does" cannot currently change, because every change in the vocabulary is a
 * fixed value or amount rather than something read off the board. When 2.1 adds a change
 * whose result depends on the game state, this is the one function that needs widening.
 */
const dependsOn = (
  state: GameState,
  object: GameObject,
  working: Working,
  effect: ContinuousEffect,
  other: ContinuousEffect,
): boolean => {
  if (!appliesTo(state, other, object, working)) return false;

  const before = appliesTo(state, effect, object, working);
  const after = appliesTo(state, effect, object, applyOne(working, other));
  return before !== after;
};

/**
 * Choose which effect to apply next (CR 613.8b): the first, in timestamp order, that
 * depends on none of the others still waiting. A cycle — every remaining effect depending
 * on another — falls back to timestamp order, which is exactly what the rule says to do.
 */
const pickNext = (
  state: GameState,
  object: GameObject,
  working: Working,
  remaining: readonly ContinuousEffect[],
): number => {
  for (let i = 0; i < remaining.length; i += 1) {
    const candidate = remaining[i];
    if (!candidate) continue;
    const dependent = remaining.some(
      (other, j) => j !== i && dependsOn(state, object, working, candidate, other),
    );
    if (!dependent) return i;
  }
  return 0;
};

/**
 * Apply every effect in one layer. Effects that do not depend on each other go in
 * timestamp order (CR 613.7); where one depends on another, the independent one goes
 * first (CR 613.8b).
 */
const applyLayer = (
  state: GameState,
  object: GameObject,
  working: Working,
  effects: readonly ContinuousEffect[],
): Working => {
  let current = working;
  const remaining = [...effects].sort((a, b) => a.timestamp - b.timestamp);

  while (remaining.length > 0) {
    const index = pickNext(state, object, current, remaining);
    const [next] = remaining.splice(index, 1);
    if (!next) break;
    if (appliesTo(state, next, object, current)) current = applyOne(current, next);
  }

  return current;
};

const computeFor = (state: GameState, object: GameObject): Characteristics => {
  const applicable = activeEffects(state);
  let working = printedOf(object);

  for (const layer of layers) {
    if (layer === '7d-counters') {
      // Counters are layer 7d, and are not effects: they are read off the object itself.
      const adjustment = counterCount(object, '+1/+1') - counterCount(object, '-1/-1');
      if (adjustment !== 0 && working.power !== null && working.toughness !== null) {
        working = {
          ...working,
          power: working.power + adjustment,
          toughness: working.toughness + adjustment,
        };
      }
      continue;
    }

    const inLayer = applicable
      .filter((effect) => effect.layer === layer)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (inLayer.length === 0) continue;

    working = applyLayer(state, object, working, inLayer);
  }

  return {
    power: working.power,
    toughness: working.toughness,
    keywords: working.keywords,
    name: working.name,
    legendary: working.legendary,
    colours: working.colours,
    controller: working.controller,
    isCreature: working.power !== null && working.toughness !== null,
  };
};

/** What this object currently is, after every continuous effect that applies to it. */
export const characteristics = (state: GameState, id: ObjectId): Characteristics | null => {
  const object = state.objects.get(id);
  if (!object) return null;

  let perState = cache.get(state);
  if (!perState) {
    perState = new Map();
    cache.set(state, perState);
  }

  const cached = perState.get(id);
  if (cached) return cached;

  const computed = computeFor(state, object);
  perState.set(id, computed);
  return computed;
};

const missing: Characteristics = {
  power: null,
  toughness: null,
  keywords: noKeywords,
  name: null,
  legendary: false,
  colours: [],
  controller: 'A',
  isCreature: false,
};

/** Characteristics of an object that is expected to exist; empty ones if it does not. */
export const characteristicsOf = (state: GameState, id: ObjectId): Characteristics =>
  characteristics(state, id) ?? missing;

// --- The shorthands the rest of the engine uses ---

export const keywordsOfObject = (state: GameState, id: ObjectId): Keywords =>
  characteristicsOf(state, id).keywords;

export const isCreature = (state: GameState, id: ObjectId): boolean =>
  characteristicsOf(state, id).isCreature;

export const isPlaneswalker = (state: GameState, id: ObjectId): boolean =>
  state.objects.get(id)?.loyalty !== null && state.objects.get(id) !== undefined;

export const powerOf = (state: GameState, id: ObjectId): number =>
  characteristicsOf(state, id).power ?? 0;

export const toughnessOf = (state: GameState, id: ObjectId): number =>
  characteristicsOf(state, id).toughness ?? 0;

export const controllerOf = (state: GameState, id: ObjectId): PlayerId =>
  characteristicsOf(state, id).controller;

/**
 * Toughness left before marked damage becomes lethal. Damage stays marked until cleanup
 * (CR 514.2), so it accumulates across a turn.
 */
export const remainingToughness = (state: GameState, id: ObjectId): number =>
  toughnessOf(state, id) - (state.objects.get(id)?.damage ?? 0);

/** A planeswalker's loyalty is the number of loyalty counters on it (CR 306.5b). */
export const currentLoyalty = (state: GameState, id: ObjectId): number => {
  const object = state.objects.get(id);
  return object ? counterCount(object, 'loyalty') : 0;
};

// --- Creating and retiring effects ---

/**
 * Add a continuous effect. The timestamp comes from the state's running counter, which is
 * what decides order within a layer (CR 613.7), so effects created later win ties.
 */
export const addEffect = (
  state: GameState,
  spec: Omit<ContinuousEffect, 'id' | 'timestamp' | 'layer'> & { readonly layer?: Layer },
): { readonly state: GameState; readonly effect: ContinuousEffect } => {
  const effect: ContinuousEffect = {
    ...spec,
    id: state.nextEffectId,
    timestamp: state.nextTimestamp,
    layer: spec.layer ?? layerFor(spec.change),
  };

  return {
    state: updateState(state, {
      effects: [...state.effects, effect],
      nextEffectId: state.nextEffectId + 1,
      nextTimestamp: state.nextTimestamp + 1,
    }),
    effect,
  };
};

export const removeEffect = (state: GameState, id: number): GameState =>
  updateState(state, { effects: state.effects.filter((effect) => effect.id !== id) });

/**
 * Drop "until end of turn" effects, which happens as the turn ends in cleanup
 * (CR 514.2). Effects tied to a source still being on the battlefield need no cleanup:
 * `activeEffects` simply stops counting them.
 */
export const expireEndOfTurnEffects = (state: GameState): GameState => {
  const remaining = state.effects.filter((effect) => effect.duration.kind !== 'untilEndOfTurn');
  return remaining.length === state.effects.length
    ? state
    : updateState(state, { effects: remaining });
};
