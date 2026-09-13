import type { Colour, EventTarget, ObjectId, PlayerId } from '@mtg/shared';
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

export interface Keywords {
  // --- Evasion and targeting ---
  /** CR 702.18: can't be the target of spells or abilities at all, even its controller's. */
  readonly shroud: boolean;
  /** CR 702.11: can't be targeted by spells or abilities an opponent controls. */
  readonly hexproof: boolean;
  /** CR 702.16: can't be targeted by sources of these colours. */
  readonly protectionFrom: readonly Colour[];
  /**
   * CR 702.21: not a targeting restriction at all — an opponent may still target it, but
   * their spell is countered unless they pay this. Reported rather than forbidden.
   */
  readonly ward: ManaCost | null;

  // --- Combat (CR 506-511). Evergreen keywords only; see docs/02 for the v1 scope. ---
  /** CR 702.9: can only be blocked by creatures with flying or reach. */
  readonly flying: boolean;
  /** CR 702.17: can block a creature with flying. */
  readonly reach: boolean;
  /** CR 702.110: can't be blocked except by two or more creatures. */
  readonly menace: boolean;
  /** CR 702.20: attacking doesn't cause it to tap. */
  readonly vigilance: boolean;
  /** CR 702.10: ignores summoning sickness. */
  readonly haste: boolean;
  /** CR 702.3: can't attack. */
  readonly defender: boolean;
  /** CR 702.7: deals its combat damage in the first-strike step. */
  readonly firstStrike: boolean;
  /** CR 702.4: deals combat damage in both damage steps. */
  readonly doubleStrike: boolean;
  /** CR 702.19: excess damage over lethal can be assigned to the defending player. */
  readonly trample: boolean;
  /** CR 702.2: any non-zero damage it deals to a creature is lethal. */
  readonly deathtouch: boolean;
  /** CR 702.15: damage it deals also gains its controller that much life. */
  readonly lifelink: boolean;
  /** CR 702.12: not destroyed by lethal damage or "destroy" effects. */
  readonly indestructible: boolean;
}

export const noKeywords: Keywords = Object.freeze({
  shroud: false,
  hexproof: false,
  protectionFrom: Object.freeze([]),
  ward: null,
  flying: false,
  reach: false,
  menace: false,
  vigilance: false,
  haste: false,
  defender: false,
  firstStrike: false,
  doubleStrike: false,
  trample: false,
  deathtouch: false,
  lifelink: false,
  indestructible: false,
});

/** Build a keyword set, naming only what differs from none of them. */
export const keywords = (some: Partial<Keywords> = {}): Keywords => ({ ...noKeywords, ...some });

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

/** The keywords currently applying to a target, whether an object or a player. */
export const keywordsOf = (state: GameState, target: EventTarget): Keywords | null => {
  if (target.kind === 'player') return state.players[target.player].keywords;
  return state.objects.get(target.object)?.keywords ?? null;
};

/** Who controls the target: a player controls themselves. */
export const controllerOfTarget = (state: GameState, target: EventTarget): PlayerId | null => {
  if (target.kind === 'player') return target.player;
  return state.objects.get(target.object)?.controller ?? null;
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
