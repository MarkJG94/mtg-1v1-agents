import type { Colour } from '@mtg/shared';
import type { GrantableKeyword } from '../layers.js';
import type { ManaProduction } from '../mana/ability.js';
import type { ManaCost } from '../mana/cost.js';
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
 * **The ops that ask.** Most ops run to completion without asking anybody anything. The
 * few that need a choice during resolution — `may`, `discard`, `lookAtTop`, `search`,
 * `scry`, `surveil` — are run by the resolution program (ADR 0021), which stops for the answer and
 * carries on after it. Modes and "unless that player pays" are the next ones on it.
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

/**
 * Where the cards a `lookAtTop` or a `search` takes go. `libraryTop` is a search's "then
 * shuffle and put that card on top": on top once the rest are shuffled.
 */
export type LookDestination =
  | { readonly kind: 'hand' }
  | { readonly kind: 'graveyard' }
  | { readonly kind: 'libraryBottom' }
  | { readonly kind: 'libraryTop' }
  | { readonly kind: 'battlefield'; readonly tapped?: boolean };

/**
 * Where the cards a `lookAtTop` does not take go: back on top or on the bottom in an
 * order the player chooses, on the bottom in a random order, or into the graveyard. A
 * search's are wherever they were in the library, which is then shuffled (`shuffle`).
 */
export type LookRest = 'top' | 'bottom' | 'bottomRandom' | 'graveyard' | 'shuffle';

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
  /**
   * "Target player discards two cards": the player discarding chooses which (CR 701.9b),
   * so resolution waits on their `discard` decision. Each player in turn, for "each player
   * discards a card" (CR 101.4).
   */
  | { readonly op: 'discard'; readonly player: PlayerSelector; readonly count: Quantity }
  | { readonly op: 'destroy'; readonly object: ObjectSelector }
  | { readonly op: 'exile'; readonly object: ObjectSelector }
  | { readonly op: 'bounce'; readonly object: ObjectSelector }
  | { readonly op: 'sacrifice'; readonly object: ObjectSelector }
  | { readonly op: 'moveZone'; readonly object: ObjectSelector; readonly to: Destination }
  | { readonly op: 'shuffle'; readonly player: PlayerSelector }
  /**
   * "Look at the top three cards of your library. Put one of them into your hand and the
   * rest on the bottom of your library in any order." The player whose library it is
   * looks and chooses, as the resolution program asks them to (ADR 0021): first which
   * cards to `take` to `to`, then, if the rest go back in an order of their choosing,
   * what order. The cards stay in the library while they are looked at (CR 401.2).
   */
  | {
      readonly op: 'lookAtTop';
      readonly player: PlayerSelector;
      readonly count: Quantity;
      /** How many to take out from among them: exactly that many, or at most with `upTo`. */
      readonly take?: Quantity;
      readonly upTo?: boolean;
      /** What a taken card has to be — "a creature card from among them". Any card when absent. */
      readonly filter?: Filter;
      /** Where the taken cards go. Required with `take`. */
      readonly to?: LookDestination;
      readonly rest: LookRest;
    }
  /**
   * "Search your library for a basic land card, put it onto the battlefield tapped, then
   * shuffle" (CR 701.23): the player looks through the whole library, takes cards to
   * `to`, and the library is shuffled. A search for a stated quality — anything with a
   * `filter` — may find fewer than asked, or none (CR 701.23b); a search for a bare
   * number of cards must find them while there are any (CR 701.23c), unless `upTo`.
   */
  | {
      readonly op: 'search';
      readonly player: PlayerSelector;
      /** How many to find; any number when absent. */
      readonly count?: Quantity;
      readonly upTo?: boolean;
      readonly filter?: Filter;
      readonly to: LookDestination;
    }
  /**
   * Scry N (CR 701.22a): look at the top N, put any number on the bottom in any order and
   * the rest on top in any order.
   */
  | { readonly op: 'scry'; readonly player: PlayerSelector; readonly count: Quantity }
  /**
   * Surveil N (CR 701.25a): look at the top N, put any number into the graveyard and the
   * rest on top in any order.
   */
  | { readonly op: 'surveil'; readonly player: PlayerSelector; readonly count: Quantity }
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
  /**
   * "You may draw a card": the player chooses, as the ability resolves, whether `effects`
   * happen (CR 608.2d). "If you do, …" after it is part of `effects`, since it happens
   * exactly when they do.
   */
  | {
      readonly op: 'may';
      readonly player: PlayerSelector;
      readonly effects: readonly EffectOp[];
      /**
       * "You may pay {2}. If you do, …": the mana a yes costs, paid as the ability
       * resolves (CR 117.12, 605.3a). A player who could not pay it is not asked.
       */
      readonly pay?: ManaCost;
    }
  | { readonly op: 'forEach'; readonly of: Filter; readonly effects: readonly EffectOp[] }
  | {
      readonly op: 'if';
      readonly condition: Condition;
      /**
       * Named `thenDo` rather than `then`, which a script may still write: an object with
       * a `then` property is a thenable, and anything that awaited one of these — or put
       * it through `Promise.resolve` — would call it.
       */
      readonly thenDo: readonly EffectOp[];
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
  'discard',
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
  'lookAtTop',
  'may',
  'mill',
  'moveZone',
  'poison',
  'preventDamage',
  'pump',
  'regenerate',
  'removeAbilities',
  'removeCounters',
  'sacrifice',
  'scry',
  'search',
  'sequence',
  'setColours',
  'setPowerToughness',
  'shuffle',
  'surveil',
  'switchPowerToughness',
  'tap',
  'untap',
  'winGame',
] as const satisfies readonly OpName[];

/** Whether the engine implements an op by this name. */
export const isKnownOp = (name: string): name is OpName =>
  (opNames as readonly string[]).includes(name);
