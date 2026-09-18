import type { Colour, EventTarget, ObjectId, PlayerId } from '@mtg/shared';
import { characteristicsOf } from './characteristics.js';
import type { Keywords } from './keywords.js';
import type { ManaCost } from './mana/cost.js';
import type { GameState } from './state/game-state.js';

/**
 * Targeting legality (CR 115) and the evasion keywords that govern it.
 *
 * The keywords live on the object for now. Characteristics are meant to be *computed*
 * from a card's printed values through the layer system rather than stored (docs/02), so
 * when roadmap 1.9 lands this becomes the per-object cache that `characteristics()` fills
 * and 2.1 seeds from card scripts. Everything below reads through `keywordsOf`, so that
 * swap touches one function.
 */

export type { Keywords } from './keywords.js';
export { keywords, noKeywords } from './keywords.js';

/** What is doing the targeting. Colours matter because protection is colour-based. */
export interface TargetSource {
  readonly controller: PlayerId;
  readonly colours: readonly Colour[];
}

export type TargetLegality =
  | { readonly legal: true; readonly ward: ManaCost | null }
  | {
      readonly legal: false;
      readonly reason: 'shroud' | 'hexproof' | 'protection' | 'gone';
    };

const legalWith = (ward: ManaCost | null): TargetLegality => ({ legal: true, ward });

/**
 * The keywords currently applying to a target, whether an object or a player. For an
 * object this is the computed value, so an effect granting hexproof genuinely protects it.
 */
export const keywordsOf = (state: GameState, target: EventTarget): Keywords | null => {
  if (target.kind === 'player') return state.players[target.player].keywords;
  return state.objects.has(target.object) ? characteristicsOf(state, target.object).keywords : null;
};

/** Who controls the target: a player controls themselves. Control can be changed (layer 2). */
export const controllerOfTarget = (state: GameState, target: EventTarget): PlayerId | null => {
  if (target.kind === 'player') return target.player;
  return state.objects.has(target.object)
    ? characteristicsOf(state, target.object).controller
    : null;
};

/**
 * Whether `source`'s controller may choose `target` (CR 115.4). Ward does not make a
 * target illegal, so a legal result carries the ward cost the caster will owe.
 */
export const canBeTargeted = (
  state: GameState,
  target: EventTarget,
  source: TargetSource,
): TargetLegality => {
  const keywords = keywordsOf(state, target);
  const controller = controllerOfTarget(state, target);
  if (!keywords || !controller) return { legal: false, reason: 'gone' };

  // Shroud stops everyone, including the permanent's own controller.
  if (keywords.shroud) return { legal: false, reason: 'shroud' };

  const opposing = controller !== source.controller;
  if (keywords.hexproof && opposing) return { legal: false, reason: 'hexproof' };

  if (keywords.protectionFrom.some((colour) => source.colours.includes(colour))) {
    return { legal: false, reason: 'protection' };
  }

  // Ward only triggers on an opponent's spell or ability (CR 702.21a).
  return legalWith(opposing ? keywords.ward : null);
};

export const isLegalTarget = (
  state: GameState,
  target: EventTarget,
  source: TargetSource,
): boolean => canBeTargeted(state, target, source).legal;

/** Filter a set of candidates down to those that may legally be targeted. */
export const legalTargetsAmong = (
  state: GameState,
  candidates: readonly EventTarget[],
  source: TargetSource,
): readonly EventTarget[] =>
  candidates.filter((candidate) => isLegalTarget(state, candidate, source));

/** Every object on the battlefield plus both players, the usual candidate set. */
export const allTargets = (state: GameState): readonly EventTarget[] => [
  ...state.zones.battlefield.map((object): EventTarget => ({ kind: 'object', object })),
  { kind: 'player', player: 'A' },
  { kind: 'player', player: 'B' },
];

/** The total ward cost an opponent must pay to target all of these. */
export const wardCostsFor = (
  state: GameState,
  targets: readonly EventTarget[],
  source: TargetSource,
): readonly ManaCost[] => {
  const costs: ManaCost[] = [];
  for (const target of targets) {
    const legality = canBeTargeted(state, target, source);
    if (legality.legal && legality.ward) costs.push(legality.ward);
  }
  return costs;
};

/** Convenience for the common case of targeting one object. */
export const objectTarget = (object: ObjectId): EventTarget => ({ kind: 'object', object });
export const playerTarget = (player: PlayerId): EventTarget => ({ kind: 'player', player });
