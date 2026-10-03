import type { Colour, ObjectId, PlayerId, ZoneId } from '@mtg/shared';
import type { GrantableKeyword } from '../layers.js';

/**
 * The closed vocabulary a card script is written in (docs/03 "Vocabulary").
 *
 * Three small languages, and every one of them is *data*: a filter says which objects an
 * ability is about, a quantity says how many, and a selector says which object or player
 * an op acts on. None of them is a function, so a card's behaviour serialises, clones and
 * replays with the rest of the state — the rule in CLAUDE.md that keeps a game a pure
 * function of its seed and its decisions.
 *
 * Closed is the point. The parser in 2.4 can only emit what is in here, the validator can
 * check a script against it, and anything a card needs that this cannot say is a gap the
 * coverage report will name rather than a hole a clever script can paper over.
 */

export type CardType =
  | 'artifact'
  | 'battle'
  | 'creature'
  | 'enchantment'
  | 'instant'
  | 'land'
  | 'planeswalker'
  | 'sorcery';

export const cardTypes: readonly CardType[] = [
  'artifact',
  'battle',
  'creature',
  'enchantment',
  'instant',
  'land',
  'planeswalker',
  'sorcery',
];

export type Supertype = 'basic' | 'legendary' | 'snow' | 'world';

export const supertypes: readonly Supertype[] = ['basic', 'legendary', 'snow', 'world'];

/** A permanent type is one that stays on the battlefield (CR 110.1). */
export const isPermanentType = (type: CardType): boolean =>
  type !== 'instant' && type !== 'sorcery';

// --- Filters ---

/**
 * A structured predicate over objects and players. `any` is Magic's "any target":
 * a creature, a player, a planeswalker or a battle (CR 115.4).
 */
export type Filter =
  | { readonly kind: 'any' }
  | { readonly kind: 'player' }
  | { readonly kind: 'creature' }
  | { readonly kind: 'permanent' }
  | { readonly kind: 'planeswalker' }
  /** An object on the stack, which is what a counterspell targets. */
  | { readonly kind: 'spell' }
  | { readonly kind: 'type'; readonly type: CardType }
  | { readonly kind: 'subtype'; readonly subtype: string }
  | { readonly kind: 'colour'; readonly colour: Colour }
  | { readonly kind: 'controlledBy'; readonly player: PlayerRelation }
  | { readonly kind: 'inZone'; readonly zone: ZoneId }
  | { readonly kind: 'tapped'; readonly tapped: boolean }
  | { readonly kind: 'attacking' }
  | { readonly kind: 'blocking' }
  | { readonly kind: 'hasKeyword'; readonly keyword: GrantableKeyword }
  | { readonly kind: 'powerAtLeast'; readonly amount: number }
  | { readonly kind: 'powerAtMost'; readonly amount: number }
  | { readonly kind: 'toughnessAtMost'; readonly amount: number }
  | { readonly kind: 'manaValueAtMost'; readonly amount: number }
  | { readonly kind: 'token'; readonly token: boolean }
  | { readonly kind: 'named'; readonly name: string }
  | { readonly kind: 'not'; readonly filter: Filter }
  | { readonly kind: 'and'; readonly filters: readonly Filter[] }
  | { readonly kind: 'or'; readonly filters: readonly Filter[] };

/** Whose things, relative to the ability's controller. */
export type PlayerRelation = 'you' | 'opponent' | 'any';

// --- Selectors ---

/** Which object an op acts on. Resolved against the effect context as the op runs. */
export type ObjectSelector =
  /** The ability's own source — `~` in a script. */
  | { readonly kind: 'source' }
  /** A target chosen as the spell or ability was put on the stack, by its script id. */
  | { readonly kind: 'target'; readonly id: string }
  /** The object the enclosing `forEach` is currently on. */
  | { readonly kind: 'each' }
  /** A specific object, which only an effect built by the engine itself uses. */
  | { readonly kind: 'object'; readonly object: ObjectId };

export type PlayerSelector =
  | { readonly kind: 'you' }
  | { readonly kind: 'opponent' }
  /** Both players, one after the other in turn order (APNAP, CR 101.4). */
  | { readonly kind: 'each' }
  | { readonly kind: 'target'; readonly id: string }
  | { readonly kind: 'controllerOf'; readonly object: ObjectSelector }
  | { readonly kind: 'player'; readonly player: PlayerId };

/** Damage and a few other ops take either kind, the way "any target" does. */
export type TargetSelector =
  | { readonly kind: 'object'; readonly object: ObjectSelector }
  | { readonly kind: 'player'; readonly player: PlayerSelector }
  /** Whatever the named target turned out to be — a creature, a player, a walker. */
  | { readonly kind: 'chosen'; readonly id: string };

// --- Quantities ---

/**
 * A number, or something the game has to be asked for. `x` is the X the spell was cast
 * with; the rest are the everyday "equal to" phrases.
 */
export type Quantity =
  | number
  | { readonly kind: 'x' }
  | { readonly kind: 'count'; readonly of: Filter }
  | { readonly kind: 'cardsInHand'; readonly player: PlayerSelector }
  | { readonly kind: 'lifeTotal'; readonly player: PlayerSelector }
  | { readonly kind: 'powerOf'; readonly object: ObjectSelector }
  | { readonly kind: 'toughnessOf'; readonly object: ObjectSelector }
  | { readonly kind: 'countersOn'; readonly object: ObjectSelector; readonly counter: string }
  | { readonly kind: 'add'; readonly left: Quantity; readonly right: Quantity }
  | { readonly kind: 'sub'; readonly left: Quantity; readonly right: Quantity }
  | { readonly kind: 'mul'; readonly left: Quantity; readonly right: Quantity };

// --- Conditions ---

/**
 * What an `if` op and an ability's intervening-if clause test. Kept separate from
 * `Filter` because a condition is about the game, not about one object.
 */
export type Condition =
  | { readonly kind: 'atLeast'; readonly amount: Quantity; readonly than: Quantity }
  | { readonly kind: 'equal'; readonly amount: Quantity; readonly than: Quantity }
  | { readonly kind: 'exists'; readonly filter: Filter }
  | { readonly kind: 'notExists'; readonly filter: Filter }
  | { readonly kind: 'not'; readonly condition: Condition }
  | { readonly kind: 'and'; readonly conditions: readonly Condition[] }
  | { readonly kind: 'or'; readonly conditions: readonly Condition[] };
