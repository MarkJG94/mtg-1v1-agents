import type { Colour } from '@mtg/shared';
import type { GrantableKeyword } from '../layers.js';
import type { ManaProduction } from '../mana/ability.js';
import type {
  CardType,
  Condition,
  Filter,
  ObjectSelector,
  PlayerSelector,
  Quantity,
  TargetSelector,
} from './vocabulary.js';

/**
 * Effect ops: the closed set of things a card can do (docs/03 "Effect ops").
 *
 * Each op is implemented once, in `effects.ts`, and every card that does that thing uses
 * the same implementation. A card is data; this is the instruction set it is written in.
 *
 * Nothing here changes state directly. An op proposes `RulesEvent`s and hands them to
 * `runBatch`, so replacement effects get their say (ADR 0004) — which is why "deals 3
 * damage" works with a prevention shield without either knowing about the other.
 *
 * **What is deliberately not here yet.** Every op below runs to completion without asking
 * anybody anything. The ops that need a choice *during* resolution — search a library,
 * scry, "you may", modal spells, "unless that player pays" — need the effect pipeline to
 * pause and resume the way a replacement batch does, and that is its own piece of work.
 * They are listed in docs/03 and in the roadmap note for 2.1 rather than half-built here.
 */

/** Where a `moveZone` puts something. Relative to the object's owner, as the rules are. */
export type Destination =
  | { readonly kind: 'graveyard' }
  | { readonly kind: 'hand' }
  | { readonly kind: 'exile' }
  | {
      readonly kind: 'battlefield';
      readonly tapped?: boolean;
      readonly controller?: PlayerSelector;
    }
  | { readonly kind: 'libraryTop' }
  | { readonly kind: 'libraryBottom' };

/** How long a continuous effect an op creates lasts. Most are until end of turn. */
export type OpDuration = 'untilEndOfTurn' | 'permanent' | 'whileSourceOnBattlefield';

export interface TokenSpec {
  readonly name: string;
  readonly types: readonly CardType[];
  /**
   * Carried for the log and the viewer. A filter cannot read them yet: types live on card
   * definitions and a token has none of its own, which is a gap to close when a card in
   * the bootstrap set actually asks "target Soldier".
   */
  readonly subtypes?: readonly string[];
  readonly colours?: readonly Colour[];
  readonly power?: number;
  readonly toughness?: number;
  readonly keywords?: readonly GrantableKeyword[];
}

export type EffectOp =
  // --- Damage and life ---
  | {
      readonly op: 'damage';
      readonly to: TargetSelector;
      readonly amount: Quantity;
      /** Defaults to the ability's source, which is what deals the damage. */
      readonly from?: ObjectSelector;
    }
  | { readonly op: 'gainLife'; readonly player: PlayerSelector; readonly amount: Quantity }
  | { readonly op: 'loseLife'; readonly player: PlayerSelector; readonly amount: Quantity }
  | { readonly op: 'poison'; readonly player: PlayerSelector; readonly amount: Quantity }
  /** Two creatures deal damage equal to their power to each other (CR 701.13). */
  | { readonly op: 'fight'; readonly first: ObjectSelector; readonly second: ObjectSelector }

  // --- Cards and zones ---
  | { readonly op: 'draw'; readonly player: PlayerSelector; readonly count: Quantity }
  | { readonly op: 'mill'; readonly player: PlayerSelector; readonly count: Quantity }
  | { readonly op: 'discardAtRandom'; readonly player: PlayerSelector; readonly count: Quantity }
  | { readonly op: 'destroy'; readonly object: ObjectSelector }
  | { readonly op: 'exile'; readonly object: ObjectSelector }
  | { readonly op: 'bounce'; readonly object: ObjectSelector }
  | { readonly op: 'sacrifice'; readonly object: ObjectSelector }
  | { readonly op: 'moveZone'; readonly object: ObjectSelector; readonly to: Destination }
  | { readonly op: 'shuffle'; readonly player: PlayerSelector }
  | {
      readonly op: 'createToken';
      readonly controller: PlayerSelector;
      readonly token: TokenSpec;
      readonly count?: Quantity;
    }

  // --- Permanents ---
  | { readonly op: 'tap'; readonly object: ObjectSelector }
  | { readonly op: 'untap'; readonly object: ObjectSelector }
  | {
      readonly op: 'addCounters';
      readonly object: ObjectSelector;
      readonly counter: string;
      readonly amount: Quantity;
    }
  | {
      readonly op: 'removeCounters';
      readonly object: ObjectSelector;
      readonly counter: string;
      readonly amount: Quantity;
    }
  | {
      readonly op: 'attach';
      readonly attachment: ObjectSelector;
      readonly to: ObjectSelector;
    }

  // --- Continuous effects (CR 613) ---
  | {
      readonly op: 'pump';
      readonly object: ObjectSelector;
      readonly power: Quantity;
      readonly toughness: Quantity;
      readonly duration?: OpDuration;
    }
  | {
      readonly op: 'setPowerToughness';
      readonly object: ObjectSelector;
      readonly power: Quantity;
      readonly toughness: Quantity;
      readonly duration?: OpDuration;
    }
  | {
      readonly op: 'switchPowerToughness';
      readonly object: ObjectSelector;
      readonly duration?: OpDuration;
    }
  | {
      readonly op: 'grantKeyword';
      readonly object: ObjectSelector;
      readonly keyword: GrantableKeyword;
      readonly duration?: OpDuration;
    }
  | {
      readonly op: 'removeAbilities';
      readonly object: ObjectSelector;
      readonly duration?: OpDuration;
    }
  | {
      readonly op: 'becomesCreature';
      readonly object: ObjectSelector;
      readonly power: Quantity;
      readonly toughness: Quantity;
      readonly duration?: OpDuration;
    }
  | {
      readonly op: 'setColours';
      readonly object: ObjectSelector;
      readonly colours: readonly Colour[];
      readonly duration?: OpDuration;
    }
  | {
      readonly op: 'gainControl';
      readonly object: ObjectSelector;
      readonly player: PlayerSelector;
      readonly duration?: OpDuration;
    }

  // --- Replacement and prevention (CR 614-616) ---
  | {
      readonly op: 'preventDamage';
      readonly to: TargetSelector;
      readonly amount: Quantity | 'all';
      readonly duration?: OpDuration;
    }
  | { readonly op: 'regenerate'; readonly object: ObjectSelector }

  // --- The stack and the turn ---
  | { readonly op: 'counter'; readonly object: ObjectSelector }
  | {
      readonly op: 'addMana';
      readonly player: PlayerSelector;
      readonly produce: readonly ManaProduction[];
    }
  | { readonly op: 'extraTurn'; readonly player: PlayerSelector }
  | { readonly op: 'winGame'; readonly player: PlayerSelector }
  | { readonly op: 'loseGame'; readonly player: PlayerSelector }
  /** Set up one of this card's own triggered abilities to fire later (CR 603.7). */
  | {
      readonly op: 'delayedTrigger';
      readonly ability: string;
      readonly once?: boolean;
    }

  // --- Control flow ---
  | { readonly op: 'sequence'; readonly effects: readonly EffectOp[] }
  | { readonly op: 'forEach'; readonly of: Filter; readonly effects: readonly EffectOp[] }
  | {
      readonly op: 'if';
      readonly condition: Condition;
      readonly then: readonly EffectOp[];
      readonly otherwise?: readonly EffectOp[];
    };

export type OpName = EffectOp['op'];

/**
 * Every op this engine implements.
 *
 * The validator (roadmap 2.2) checks a script against this rather than against a list it
 * keeps itself, so a script can never name an op the engine has not got — the failure
 * docs/03 asks to be impossible.
 */
export const opNames = [
  'addCounters',
  'addMana',
  'attach',
  'becomesCreature',
  'bounce',
  'counter',
  'createToken',
  'damage',
  'delayedTrigger',
  'destroy',
  'discardAtRandom',
  'draw',
  'exile',
  'extraTurn',
  'fight',
  'forEach',
  'gainControl',
  'gainLife',
  'grantKeyword',
  'if',
  'loseGame',
  'loseLife',
  'mill',
  'moveZone',
  'poison',
  'preventDamage',
  'pump',
  'regenerate',
  'removeAbilities',
  'removeCounters',
  'sacrifice',
  'sequence',
  'setColours',
  'setPowerToughness',
  'shuffle',
  'switchPowerToughness',
  'tap',
  'untap',
  'winGame',
] as const satisfies readonly OpName[];

/** Whether the engine implements an op by this name. */
export const isKnownOp = (name: string): name is OpName =>
  (opNames as readonly string[]).includes(name);
