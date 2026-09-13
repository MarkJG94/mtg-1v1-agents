import type { ObjectId, PlayerId } from '@mtg/shared';
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
import { noKeywords } from './targeting.js';

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

/** Effects that are currently doing anything, ignoring those whose source has gone. */
export const activeEffects = (state: GameState): readonly ContinuousEffect[] =>
  state.effects.filter((effect) => {
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

/**
 * Apply every effect in one layer, in timestamp order (CR 613.7).
 *
 * Dependency (CR 613.8) is not handled here beyond the natural consequence of evaluating
 * each effect's selector against the state as it stands: an effect that stops applying
 * because an earlier one in the same layer removed what it looked at will already miss.
 * The cases that need true dependency ordering — Humility with Opalescence, Blood Moon
 * with the Urza lands — are noted in the roadmap as outstanding rather than silently
 * approximated.
 */
const applyLayer = (
  state: GameState,
  object: GameObject,
  working: Working,
  effects: readonly ContinuousEffect[],
): Working => {
  let current = working;

  for (const effect of effects) {
    const isCreature = current.power !== null && current.toughness !== null;
    if (!selectorMatches(state, effect, object, current.controller, isCreature)) continue;

    const change = effect.change;
    switch (change.kind) {
      case 'changeControl':
        current = { ...current, controller: change.controller };
        break;
      case 'becomesCreature':
        current = { ...current, power: change.power, toughness: change.toughness };
        break;
      case 'setColours':
        current = { ...current, colours: change.colours };
        break;
      case 'addKeyword':
        current = { ...current, keywords: { ...current.keywords, [change.keyword]: true } };
        break;
      case 'removeAllAbilities':
        // Humility's half: everything printed goes, and only later layers can add back.
        current = { ...current, keywords: noKeywords };
        break;
      case 'setPowerToughness':
        current = { ...current, power: change.power, toughness: change.toughness };
        break;
      case 'modifyPowerToughness':
        current = {
          ...current,
          power: (current.power ?? 0) + change.power,
          toughness: (current.toughness ?? 0) + change.toughness,
        };
        break;
      case 'switchPowerToughness':
        current = { ...current, power: current.toughness, toughness: current.power };
        break;
    }
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
