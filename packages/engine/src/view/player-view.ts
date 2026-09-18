import type { Colour, GameResult, ObjectId, OracleId, PlayerId, Step, ZoneId } from '@mtg/shared';
import type { CardType } from '../cards/vocabulary.js';
import type { Keywords } from '../keywords.js';
import type { ManaType } from '../mana/pool.js';

/**
 * What one player can see (docs/04 "Play agent").
 *
 * The engine's `GameState` is the whole truth — both hands, both library orders, every
 * card face down in exile. An agent handed one of those would be cheating whether or not
 * it meant to, and nothing in a thousand-game run would ever say so: it would simply win
 * more. So an agent is never handed one. It is handed one of these, which is built from
 * the state by `viewFor` and holds only what the rules let this player know.
 *
 * **The hiding is in the types, not in a convention.** The opponent's side has no `hand`
 * field to read, rather than a `hand` that happens to be empty, and neither side has a
 * library at all. A future agent cannot reach for what it should not see, because there
 * is nothing there to reach for and the compiler says so.
 *
 * Everything here is plain data with no methods and no back-reference to the state it
 * came from, which is the other half of the same idea: a view cannot be unwrapped.
 */

/** An object as the viewer can see it, with the layer system already applied. */
export interface VisibleObject {
  readonly id: ObjectId;
  readonly oracleId: OracleId;
  readonly zone: ZoneId;
  /** Owner never changes; controller can (CR 108.3, 613.1b), and this is the current one. */
  readonly owner: PlayerId;
  readonly controller: PlayerId;

  // --- Current characteristics (CR 613), not printed ones ---
  readonly name: string | null;
  readonly isCreature: boolean;
  readonly power: number | null;
  readonly toughness: number | null;
  readonly colours: readonly Colour[];
  readonly keywords: Keywords;
  readonly legendary: boolean;

  /**
   * The printed card's types, which the layer vocabulary cannot yet change beyond
   * "becomes a creature" — and that shows up in `isCreature` rather than here. Kept
   * separate from the characteristics above so a reader is never misled about which is
   * which.
   */
  readonly types: readonly CardType[];
  /** The printed mana value, for curve and castability terms in an evaluator. */
  readonly manaValue: number;
  /**
   * The colours in this card's mana cost, which is what deciding whether a hand is
   * castable actually needs — a card's own colour is not the same thing, and a land's is
   * neither (a Forest is colourless and taps for green).
   */
  readonly costColours: readonly Colour[];
  /**
   * Every mana type this permanent's own mana abilities could make (CR 605), as the union
   * over their modes. Public: what a land taps for is written on it. Empty for anything
   * that makes no mana, which is most cards.
   */
  readonly producesMana: readonly ManaType[];

  // --- Per-object rules state ---
  readonly tapped: boolean;
  readonly damage: number;
  readonly counters: Readonly<Record<string, number>>;
  /** Loyalty counters remaining, or `null` for anything that is not a planeswalker. */
  readonly loyalty: number | null;
  readonly summoningSick: boolean;
  readonly token: boolean;
  readonly attachedTo: ObjectId | null;
  readonly attachments: readonly ObjectId[];
}

/** What is visible about either player, whichever side of the table they are on. */
export interface SideView {
  readonly player: PlayerId;
  readonly life: number;
  readonly poison: number;
  readonly handSize: number;
  /**
   * A count and never the cards. Nobody knows a library's order, not even its owner
   * (CR 401.2) — a view that showed the viewer their own would be a view that let an
   * agent draw perfectly, which is a different game.
   */
  readonly librarySize: number;
  readonly graveyard: readonly ObjectId[];
  /** Permanents this player controls right now, which is a characteristic (CR 613.1b). */
  readonly battlefield: readonly ObjectId[];
  readonly landsPlayedThisTurn: number;
  readonly maxLandsPerTurn: number;
  /** Unspent mana, as counts by type — the pool's spend restrictions are not modelled here. */
  readonly manaPool: Readonly<Record<string, number>>;
}

/** The viewer's own side, which is the only one whose hand can be read. */
export interface OwnSideView extends SideView {
  readonly hand: readonly ObjectId[];
}

/**
 * The opponent's side. There is deliberately **no `hand` field**: the size is public
 * (CR 400.2) and the contents are not, and the absence is what stops an agent asking.
 */
export type OpponentSideView = SideView;

/** Combat as both players can see it (CR 506-511), which is all of it. */
export interface CombatView {
  readonly attackers: readonly {
    readonly attacker: ObjectId;
    readonly defendingPlayer: PlayerId | null;
    readonly defendingPlaneswalker: ObjectId | null;
    readonly blockedBy: readonly ObjectId[];
    readonly blocked: boolean;
  }[];
  readonly firstStrikeDone: boolean;
}

export interface PlayerView {
  /** Whose view this is. Everything below is from this player's seat. */
  readonly viewer: PlayerId;
  readonly turn: number;
  readonly step: Step;
  readonly activePlayer: PlayerId;
  readonly priority: PlayerId | null;

  readonly you: OwnSideView;
  readonly opponent: OpponentSideView;

  /**
   * Every object the viewer can see, by id. A hidden card has no entry at all — an
   * opponent's hand is `handSize` and nothing more — so an id that is missing here is a
   * card this player does not know about, rather than one that does not exist.
   */
  readonly objects: ReadonlyMap<ObjectId, VisibleObject>;

  // --- Shared zones, which are public (CR 400.2) ---
  readonly battlefield: readonly ObjectId[];
  /** Bottom first, the way the engine stores it; the last entry resolves next. */
  readonly stack: readonly ObjectId[];
  readonly exile: readonly ObjectId[];

  readonly combat: CombatView | null;
  readonly result: GameResult | null;
}

/** The object behind an id, or `null` if this player cannot see it. */
export const seen = (view: PlayerView, id: ObjectId): VisibleObject | null =>
  view.objects.get(id) ?? null;

/** Every visible object in a zone, in the zone's own order. */
export const objectsSeenIn = (
  view: PlayerView,
  ids: readonly ObjectId[],
): readonly VisibleObject[] =>
  ids.flatMap((id) => {
    const object = view.objects.get(id);
    return object === undefined ? [] : [object];
  });
