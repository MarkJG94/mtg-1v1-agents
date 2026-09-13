import type { ObjectId, OracleId, PlayerId, ZoneId } from '@mtg/shared';
import type { StackProperties } from '../stack.js';

/**
 * An object in a zone (CR 109): a card, a token, or a copy.
 *
 * Characteristics — name, types, colours, power, toughness, abilities — are
 * deliberately **not** stored here. They are computed by `characteristics(state, id)`
 * from the printed definition plus the layer system (roadmap 1.9), because a stored
 * copy would go stale the moment an anthem or a Blood Moon changed. What lives here is
 * only what the rules track per object and cannot be derived.
 */
export interface GameObject {
  readonly id: ObjectId;
  /** The card this object was printed from; looked up in the per-game definition table. */
  readonly definitionId: OracleId;
  /** Owner never changes; controller can (CR 108.3, 613.1b). */
  readonly owner: PlayerId;
  readonly controller: PlayerId;
  readonly zone: ZoneId;
  /** Timestamp for layer ordering (CR 613.7). Monotonic across the game. */
  readonly timestamp: number;
  readonly tapped: boolean;
  /** Counter kind → count. Absent means zero. */
  readonly counters: Readonly<Record<string, number>>;
  /** Damage marked this turn; cleared in cleanup (CR 514.2). */
  readonly damage: number;
  /** Aura/Equipment attachment (CR 301.5, 303.4). */
  readonly attachedTo: ObjectId | null;
  readonly attachments: readonly ObjectId[];
  /** Choices made for this object, e.g. a chosen colour or creature type. */
  readonly chosen: Readonly<Record<string, string>>;
  readonly token: boolean;
  /**
   * Set only while the object is on the stack: where it resolves to, and whether it has
   * split second. Cleared as it leaves.
   */
  readonly stack?: StackProperties | undefined;
  /**
   * Whether the object has been controlled by its controller since their turn began
   * (CR 302.6). Set when it enters the battlefield, cleared at untap.
   */
  readonly summoningSick: boolean;
}

export const countersOf = (object: GameObject, kind: string): number => object.counters[kind] ?? 0;

/** Setting a counter to zero removes the key, so object equality stays meaningful. */
export const withCounters = (object: GameObject, kind: string, count: number): GameObject => {
  if (!Number.isInteger(count)) throw new RangeError(`counter count must be an integer`);
  const counters = { ...object.counters };
  if (count === 0) delete counters[kind];
  else counters[kind] = count;
  return { ...object, counters };
};
