import type { Colour, ObjectId, PlayerId } from '@mtg/shared';
import type { Keywords } from './targeting.js';

/**
 * Continuous effects and the layer system (CR 613).
 *
 * Magic does not apply effects in the order they were created. It sorts them into seven
 * layers by *what they change* — control, then colour, then abilities, then power and
 * toughness — and applies every effect in one layer before any in the next. That is why a
 * creature given +2/+2 and then set to 1/1 ends up 3/3: setting happens in layer 7b and
 * modifying in 7c, whatever order the spells were cast in.
 *
 * Effects are described as data, never as functions, so they live in `GameState` and a
 * game stays a pure function of its seed and decisions.
 */

/** The seven layers, with layer 7's five sublayers (CR 613.4). */
export const layers = [
  '1-copy',
  '2-control',
  '3-text',
  '4-type',
  '5-colour',
  '6-ability',
  '7a-characteristicDefining',
  '7b-set',
  '7c-modify',
  '7d-counters',
  '7e-switch',
] as const;
export type Layer = (typeof layers)[number];

const layerOrder: ReadonlyMap<Layer, number> = new Map(layers.map((layer, i) => [layer, i]));

export const layerIndex = (layer: Layer): number => layerOrder.get(layer) ?? -1;

/** Keywords an effect can grant. The parameterised ones are not granted this way. */
export const grantableKeywords = [
  'flying',
  'reach',
  'menace',
  'vigilance',
  'haste',
  'defender',
  'firstStrike',
  'doubleStrike',
  'trample',
  'deathtouch',
  'lifelink',
  'indestructible',
  'shroud',
  'hexproof',
] as const;
export type GrantableKeyword = (typeof grantableKeywords)[number];

/** Which objects an effect applies to. Evaluated fresh at each layer (CR 613.6). */
export type EffectSelector =
  | { readonly kind: 'self' }
  | { readonly kind: 'object'; readonly object: ObjectId }
  | { readonly kind: 'allCreatures' }
  | { readonly kind: 'allPermanents' }
  | {
      readonly kind: 'creaturesControlledBy';
      /** `'sourceController'` follows the source if control of it changes. */
      readonly player: PlayerId | 'sourceController';
    };

export type EffectChange =
  /** Layer 2: control-changing (CR 613.1b). */
  | { readonly kind: 'changeControl'; readonly controller: PlayerId }
  /** Layer 4: becomes a creature, as Opalescence and friends do. */
  | {
      readonly kind: 'becomesCreature';
      readonly power: number;
      readonly toughness: number;
    }
  /** Layer 5: colour-changing, which matters for protection. */
  | { readonly kind: 'setColours'; readonly colours: readonly Colour[] }
  /** Layer 6: ability adding and removing. */
  | { readonly kind: 'addKeyword'; readonly keyword: GrantableKeyword }
  | { readonly kind: 'removeAllAbilities' }
  /** Layer 7b: setting power and toughness to a value. */
  | { readonly kind: 'setPowerToughness'; readonly power: number; readonly toughness: number }
  /** Layer 7c: modifying them by an amount. */
  | { readonly kind: 'modifyPowerToughness'; readonly power: number; readonly toughness: number }
  /** Layer 7e: switching them. */
  | { readonly kind: 'switchPowerToughness' };

export type EffectDuration =
  | { readonly kind: 'permanent' }
  | { readonly kind: 'untilEndOfTurn' }
  /** The usual duration for a static ability: it lasts while its source is in play. */
  | { readonly kind: 'whileSourceOnBattlefield' };

export interface ContinuousEffect {
  readonly id: number;
  readonly source: ObjectId;
  /** Decides the order within a layer (CR 613.7). */
  readonly timestamp: number;
  readonly layer: Layer;
  readonly affects: EffectSelector;
  readonly change: EffectChange;
  readonly duration: EffectDuration;
}

/** The layer a change belongs in. A change never sits in more than one. */
export const layerFor = (change: EffectChange): Layer => {
  switch (change.kind) {
    case 'changeControl':
      return '2-control';
    case 'becomesCreature':
      return '4-type';
    case 'setColours':
      return '5-colour';
    case 'addKeyword':
    case 'removeAllAbilities':
      return '6-ability';
    case 'setPowerToughness':
      return '7b-set';
    case 'modifyPowerToughness':
      return '7c-modify';
    case 'switchPowerToughness':
      return '7e-switch';
  }
};

/** Build an effect, putting it in the right layer for what it does. */
export const continuousEffect = (
  spec: Omit<ContinuousEffect, 'layer'> & { readonly layer?: Layer },
): ContinuousEffect => ({ ...spec, layer: spec.layer ?? layerFor(spec.change) });

/** Computed characteristics of one object, after every applicable effect. */
export interface Characteristics {
  readonly power: number | null;
  readonly toughness: number | null;
  readonly keywords: Keywords;
  readonly name: string | null;
  readonly legendary: boolean;
  readonly colours: readonly Colour[];
  readonly controller: PlayerId;
  readonly isCreature: boolean;
}

/** Whether an effect has run out (CR 613.6a). */
export const hasExpired = (effect: ContinuousEffect, turn: number, startedTurn: number): boolean =>
  effect.duration.kind === 'untilEndOfTurn' && turn > startedTurn;
