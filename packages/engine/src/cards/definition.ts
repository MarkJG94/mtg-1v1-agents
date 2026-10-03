import type { Colour, EventTarget, OracleId } from '@mtg/shared';
import type { EffectChange, EffectDuration, EffectSelector } from '../layers.js';
import type { ManaProduction } from '../mana/ability.js';
import type { ManaCost } from '../mana/cost.js';
import type { EventMatcher, ReplacementChange } from '../replacement.js';
import type { Keywords } from '../targeting.js';
import type { InterveningCondition, TriggerWhen } from '../triggers.js';
import type { EffectOp } from './ops.js';
import type { CardType, Filter, Supertype } from './vocabulary.js';

/**
 * What a card is and what it does (docs/03).
 *
 * A `CardDefinition` is the engine's own shape, with the mana cost already parsed and the
 * keywords already expanded. `@mtg/cards` owns the YAML and the zod schema and produces
 * these; the engine never parses anything, which is what keeps it free of dependencies.
 *
 * Definitions are immutable and shared: every copy of a card in a game points at the same
 * one, and objects carry only what makes them different from their definition.
 */

export interface TargetSpec {
  /** The name the effects refer to it by — `$t` in a script. */
  readonly id: string;
  readonly filter: Filter;
  /** How many objects this target takes. Defaults to one. */
  readonly count?: number;
  /** "Up to N": fewer is legal, including none (CR 601.2c). */
  readonly upTo?: boolean;
}

/** What activating an ability costs. Mana, the tap symbol, sacrificing itself. */
export interface AbilityCost {
  readonly mana?: ManaCost;
  readonly tap?: boolean;
  readonly sacrificeSelf?: boolean;
}

/** An instant or sorcery's effect; also what a permanent spell does on the way in. */
export interface SpellAbility {
  readonly kind: 'spell';
  readonly targets?: readonly TargetSpec[];
  readonly effects: readonly EffectOp[];
}

export interface TriggeredAbilityDef {
  readonly kind: 'triggered';
  readonly id: string;
  readonly when: TriggerWhen;
  readonly interveningIf?: InterveningCondition;
  readonly onceEachTurn?: boolean;
  readonly targets?: readonly TargetSpec[];
  readonly effects: readonly EffectOp[];
}

export interface ActivatedAbilityDef {
  readonly kind: 'activated';
  readonly id: string;
  readonly cost: AbilityCost;
  /** Sorcery-speed only, the way most "activate only as a sorcery" abilities read. */
  readonly sorceryOnly?: boolean;
  readonly targets?: readonly TargetSpec[];
  readonly effects: readonly EffectOp[];
}

/**
 * A static ability is a continuous effect that exists while its source does (CR 604.1),
 * so it is described exactly as the layer system describes one.
 */
export interface StaticAbilityDef {
  readonly kind: 'static';
  readonly affects: EffectSelector;
  readonly change: EffectChange;
  /** Defaults to lasting while the source is on the battlefield. */
  readonly duration?: EffectDuration;
}

export interface ManaAbilityDef {
  readonly kind: 'mana';
  readonly id: string;
  readonly requiresTap?: boolean;
  readonly modes: readonly (readonly ManaProduction[])[];
}

export interface LoyaltyAbilityDef {
  readonly kind: 'loyalty';
  readonly id: string;
  /** Signed as printed: `+2` adds two counters, `-3` removes three (CR 606.2). */
  readonly cost: number;
  readonly targets?: readonly TargetSpec[];
  readonly effects: readonly EffectOp[];
}

export interface ReplacementAbilityDef {
  readonly kind: 'replacement';
  readonly id: string;
  readonly applies: EventMatcher;
  readonly change: ReplacementChange;
  /** CR 616.1a: an effect about its own source applies before anything else. */
  readonly selfReplacement?: boolean;
}

export type CardAbility =
  | SpellAbility
  | TriggeredAbilityDef
  | ActivatedAbilityDef
  | StaticAbilityDef
  | ManaAbilityDef
  | LoyaltyAbilityDef
  | ReplacementAbilityDef;

export interface CardDefinition {
  readonly oracleId: OracleId;
  readonly name: string;
  readonly manaCost: ManaCost;
  readonly types: readonly CardType[];
  readonly supertypes?: readonly Supertype[];
  readonly subtypes?: readonly string[];
  readonly colours: readonly Colour[];
  readonly power?: number;
  readonly toughness?: number;
  readonly loyalty?: number;
  /** Printed keywords, already expanded from the card's keyword line. */
  readonly keywords?: Keywords;
  /**
   * CR 702.8. Kept here rather than in `Keywords` because flash is about *when* a card
   * can be cast, not about how a permanent behaves once it is out — nothing in the layer
   * system or in combat ever asks about it.
   */
  readonly flash?: boolean;
  /** CR 702.61: while this is on the stack, nothing else can be cast or activated. */
  readonly splitSecond?: boolean;
  readonly abilities: readonly CardAbility[];
}

// --- Reading a definition ---

export const hasType = (definition: CardDefinition, type: CardType): boolean =>
  definition.types.includes(type);

/** A permanent spell becomes a permanent; an instant or sorcery does not (CR 110.1). */
export const isPermanentCard = (definition: CardDefinition): boolean =>
  definition.types.some((type) => type !== 'instant' && type !== 'sorcery');

export const isLegendary = (definition: CardDefinition): boolean =>
  definition.supertypes?.includes('legendary') ?? false;

/**
 * Whether the card can only be cast in your own main phase with an empty stack
 * (CR 307.1, 302.1). Instants and anything with flash are the exceptions.
 */
export const isSorcerySpeed = (definition: CardDefinition): boolean =>
  !hasType(definition, 'instant') && definition.flash !== true;

export const spellAbilityOf = (definition: CardDefinition): SpellAbility | undefined =>
  definition.abilities.find((ability): ability is SpellAbility => ability.kind === 'spell');

export const abilitiesOfKind = <K extends CardAbility['kind']>(
  definition: CardDefinition,
  kind: K,
): readonly Extract<CardAbility, { kind: K }>[] =>
  definition.abilities.filter(
    (ability): ability is Extract<CardAbility, { kind: K }> => ability.kind === kind,
  );

/** An ability of this card by its script id, whatever kind it is. */
export const abilityById = (definition: CardDefinition, id: string): CardAbility | undefined =>
  definition.abilities.find((ability) => 'id' in ability && ability.id === id);

/** The effects an ability runs, or none for the kinds that do not run effects. */
export const effectsOf = (ability: CardAbility): readonly EffectOp[] =>
  'effects' in ability ? ability.effects : [];

/** The targets an ability takes, or none. */
export const targetsOf = (ability: CardAbility): readonly TargetSpec[] =>
  'targets' in ability ? (ability.targets ?? []) : [];

/**
 * Match a flat list of targets back to the ability's named ones.
 *
 * They were chosen in the order the ability declares them, so they are handed back out
 * the same way: the first spec takes its `count`, the next takes the ones after that. An
 * "up to" spec takes what is left rather than demanding its full number. Casting reads
 * this to check each target against the spec that asked for it, and resolution reads it
 * to hand `$id` to the effects, which is why the two can never disagree about which
 * target was which.
 */
export const bindTargets = (
  specs: readonly TargetSpec[],
  chosen: readonly EventTarget[],
): Record<string, readonly EventTarget[]> => {
  const bound: Record<string, readonly EventTarget[]> = {};
  let index = 0;

  for (const spec of specs) {
    const wanted = spec.count ?? 1;
    const take = spec.upTo === true ? Math.min(wanted, chosen.length - index) : wanted;
    bound[spec.id] = chosen.slice(index, index + Math.max(0, take));
    index += Math.max(0, take);
  }

  return bound;
};
