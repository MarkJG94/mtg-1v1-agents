import {
  allZoneIds,
  asObjectId,
  type Colour,
  type ObjectId,
  type OracleId,
  type PlayerId,
  playerIds,
  type ZoneId,
} from '@mtg/shared';
import type { LoyaltyAbility } from '../planeswalker.js';
import { type Keywords, noKeywords } from '../targeting.js';
import type { TriggeredAbility } from '../triggers.js';
import type { GameState, PlayerState } from './game-state.js';
import type { GameObject } from './object.js';

/**
 * Structural-sharing updates.
 *
 * The search AI clones states constantly for lookahead, so updates copy only the spine
 * they touch: changing one object's damage rewrites the objects map and that one
 * object, and leaves every other object, every zone array and every player untouched by
 * reference. Nothing here mutates its input.
 *
 * All of them bump `version`, which is the memoisation key for derived characteristics.
 * Mutating a `GameState` directly would leave that key stale, so these helpers — not
 * object spreads at the call site — are the only supported way to change state.
 *
 * `objects` is a plain `ReadonlyMap` copied on write. That is O(objects) per update,
 * which is fine at Magic's scale (a two-player game holds a few hundred objects) but is
 * the first thing to revisit if the 1.14 benchmarks miss the 5 ms/game target; every
 * read and write goes through this module, so the representation can change here alone.
 */

type StatePatch = Partial<Omit<GameState, 'version'>>;

/** Apply a patch and bump the version. The base of every other helper here. */
export const updateState = (state: GameState, patch: StatePatch): GameState => ({
  ...state,
  ...patch,
  version: state.version + 1,
});

// --- Reading ---

export class UnknownObjectError extends Error {
  constructor(readonly objectId: ObjectId) {
    super(`no object ${objectId} in this game`);
    this.name = 'UnknownObjectError';
  }
}

export const findObject = (state: GameState, id: ObjectId): GameObject | undefined =>
  state.objects.get(id);

/** Throws if the object is unknown; use `findObject` when absence is expected. */
export const getObject = (state: GameState, id: ObjectId): GameObject => {
  const object = state.objects.get(id);
  if (!object) throw new UnknownObjectError(id);
  return object;
};

export const objectsIn = (state: GameState, zone: ZoneId): readonly ObjectId[] => state.zones[zone];

export const zoneSize = (state: GameState, zone: ZoneId): number => state.zones[zone].length;

// --- Objects ---

export const updateObject = (
  state: GameState,
  id: ObjectId,
  patch: Partial<Omit<GameObject, 'id'>>,
): GameState => updateObjects(state, [[id, patch]]);

/**
 * Patch several objects with a single map copy. Prefer this to a loop of
 * `updateObject` when one rules action touches many objects, such as untapping
 * everything a player controls or dealing combat damage.
 */
export const updateObjects = (
  state: GameState,
  patches: Iterable<readonly [ObjectId, Partial<Omit<GameObject, 'id'>>]>,
): GameState => {
  const entries = [...patches];
  if (entries.length === 0) return state;

  const objects = new Map(state.objects);
  for (const [id, patch] of entries) {
    const existing = objects.get(id);
    if (!existing) throw new UnknownObjectError(id);
    // `id` is stripped by the patch type, so an object can never change identity.
    objects.set(id, { ...existing, ...patch, id });
  }
  return updateState(state, { objects });
};

export interface NewObjectSpec {
  readonly definitionId: OracleId;
  readonly owner: PlayerId;
  readonly zone: ZoneId;
  /** Defaults to the owner. */
  readonly controller?: PlayerId;
  readonly token?: boolean;
  readonly keywords?: Keywords;
  readonly power?: number;
  readonly toughness?: number;
  readonly loyalty?: number;
  readonly name?: string;
  readonly legendary?: boolean;
  readonly colours?: readonly Colour[];
  readonly attachment?: 'aura' | 'equipment';
  readonly triggers?: readonly TriggeredAbility[];
  readonly loyaltyAbilities?: readonly LoyaltyAbility[];
  /** Where in the destination zone; defaults to the end of the array. */
  readonly position?: ZonePosition;
}

/** Create an object, assigning it the next id and timestamp, and put it in its zone. */
export const createObject = (
  state: GameState,
  spec: NewObjectSpec,
): { readonly state: GameState; readonly object: GameObject } => {
  const id = asObjectId(state.nextObjectId);
  const object: GameObject = {
    id,
    definitionId: spec.definitionId,
    owner: spec.owner,
    controller: spec.controller ?? spec.owner,
    zone: spec.zone,
    timestamp: state.nextTimestamp,
    tapped: false,
    counters: {},
    damage: 0,
    attachedTo: null,
    attachments: [],
    chosen: {},
    token: spec.token ?? false,
    keywords: spec.keywords ?? noKeywords,
    power: spec.power ?? null,
    toughness: spec.toughness ?? null,
    loyalty: spec.loyalty ?? null,
    name: spec.name ?? null,
    legendary: spec.legendary ?? false,
    colours: spec.colours ?? [],
    attachment: spec.attachment ?? null,
    deathtouched: false,
    triggers: spec.triggers ?? [],
    loyaltyAbilities: spec.loyaltyAbilities ?? [],
    summoningSick: false,
  };

  const objects = new Map(state.objects);
  objects.set(id, object);

  const next = updateState(state, {
    objects,
    zones: withInserted(state.zones, spec.zone, id, spec.position ?? 'end'),
    nextObjectId: state.nextObjectId + 1,
    nextTimestamp: state.nextTimestamp + 1,
  });

  return { state: next, object };
};

/**
 * Remove an object from the game entirely. Only correct for things that cease to exist
 * — a token that has left the battlefield (CR 111.7), or a copy on the stack that has
 * resolved. Cards move between zones with `moveObject` instead; they never vanish.
 */
export const destroyObject = (state: GameState, id: ObjectId): GameState => {
  const object = getObject(state, id);
  const objects = new Map(state.objects);
  objects.delete(id);
  return updateState(state, {
    objects,
    zones: withRemoved(state.zones, object.zone, id),
  });
};

// --- Zones ---

/**
 * Where in a zone's array to insert. Array order is the zone's own order: index 0 is
 * the **top** of a library and the **bottom** of the stack, so `'start'` means "top of
 * library" and `'end'` means "top of stack" / "bottom of library".
 */
export type ZonePosition = 'start' | 'end' | number;

const insertAt = (
  ids: readonly ObjectId[],
  id: ObjectId,
  position: ZonePosition,
): readonly ObjectId[] => {
  if (position === 'end') return [...ids, id];
  if (position === 'start') return [id, ...ids];
  if (!Number.isInteger(position) || position < 0 || position > ids.length) {
    throw new RangeError(`zone position ${position} is out of range for a zone of ${ids.length}`);
  }
  return [...ids.slice(0, position), id, ...ids.slice(position)];
};

const withInserted = (
  zones: GameState['zones'],
  zone: ZoneId,
  id: ObjectId,
  position: ZonePosition,
): GameState['zones'] => ({ ...zones, [zone]: insertAt(zones[zone], id, position) });

const withRemoved = (
  zones: GameState['zones'],
  zone: ZoneId,
  id: ObjectId,
): GameState['zones'] => ({ ...zones, [zone]: zones[zone].filter((other) => other !== id) });

/**
 * Move an object to another zone, keeping `object.zone` and the zone arrays in step.
 *
 * The object keeps its id. Under CR 400.7 a card that changes zones usually becomes a
 * *new* object with no memory of the old one; modelling that — resetting counters and
 * damage, and the exceptions that do carry over — belongs with state-based actions and
 * triggers in roadmap 1.7/1.8, and the event log already has a `becomes` field for it.
 */
export const moveObject = (
  state: GameState,
  id: ObjectId,
  to: ZoneId,
  position: ZonePosition = 'end',
): GameState => {
  const object = getObject(state, id);
  if (object.zone === to && position === 'end') {
    // Still a move within the same zone: send it to the end rather than no-op silently.
    const zones = withInserted(withRemoved(state.zones, to, id), to, id, 'end');
    return updateState(state, { zones });
  }

  const zones = withInserted(withRemoved(state.zones, object.zone, id), to, id, position);
  const objects = new Map(state.objects);
  objects.set(id, { ...object, zone: to });
  return updateState(state, { objects, zones });
};

/**
 * Compare as multisets, not as sets: `[a, a]` against `[a, b]` has the right length and
 * every element of the first does appear in the second, so a set-wise check would accept
 * it and silently duplicate one card while losing another.
 */
const isPermutationOf = (ids: readonly ObjectId[], existing: readonly ObjectId[]): boolean => {
  if (ids.length !== existing.length) return false;

  const remaining = new Map<ObjectId, number>();
  for (const id of existing) remaining.set(id, (remaining.get(id) ?? 0) + 1);

  for (const id of ids) {
    const count = remaining.get(id);
    if (count === undefined) return false;
    if (count === 1) remaining.delete(id);
    else remaining.set(id, count - 1);
  }
  return remaining.size === 0;
};

/** Replace a zone's contents wholesale, e.g. after a shuffle. */
export const setZone = (state: GameState, zone: ZoneId, ids: readonly ObjectId[]): GameState => {
  if (!isPermutationOf(ids, state.zones[zone])) {
    throw new RangeError(`setZone on ${zone} must be a permutation of its current contents`);
  }
  return updateState(state, { zones: { ...state.zones, [zone]: [...ids] } });
};

// --- Players ---

export const updatePlayer = (
  state: GameState,
  player: PlayerId,
  patch: Partial<PlayerState>,
): GameState =>
  updateState(state, {
    players: { ...state.players, [player]: { ...state.players[player], ...patch } },
  });

// --- Invariants ---

/**
 * Check the structural invariants the fuzzer asserts after every step (docs/09).
 * Returns a list of human-readable problems; empty means the state is well formed.
 * Cheap enough for tests, too slow for the hot path.
 *
 * These are the *structural* ones — objects in exactly one zone, filed under their own
 * id, nothing negative. The rules invariants that need the layer system and the
 * state-based actions to have run (nothing on the battlefield with toughness at or below
 * zero, no two same-name legends under one controller) live in `@mtg/engine/testing`,
 * because checking them from here would make this module depend on half the engine.
 */
export const checkStateInvariants = (state: GameState): string[] => {
  const problems: string[] = [];
  const seen = new Map<ObjectId, ZoneId>();

  for (const zone of allZoneIds) {
    for (const id of state.zones[zone]) {
      const previous = seen.get(id);
      if (previous !== undefined) {
        problems.push(`object ${id} is in both ${previous} and ${zone}`);
        continue;
      }
      seen.set(id, zone);

      const object = state.objects.get(id);
      if (!object) problems.push(`zone ${zone} holds unknown object ${id}`);
      else if (object.zone !== zone) {
        problems.push(`object ${id} says it is in ${object.zone} but sits in ${zone}`);
      }
    }
  }

  for (const [id, object] of state.objects) {
    if (!seen.has(id)) problems.push(`object ${id} is in no zone (claims ${object.zone})`);
    if (object.id !== id) problems.push(`object ${id} is filed under the wrong key`);
    if (object.damage < 0) problems.push(`object ${id} has negative damage`);
    if (id >= state.nextObjectId) problems.push(`object ${id} was issued beyond nextObjectId`);
    for (const [kind, count] of Object.entries(object.counters)) {
      if (count < 0) problems.push(`object ${id} has ${count} ${kind} counters`);
      if (count === 0) problems.push(`object ${id} keeps a zero entry for ${kind} counters`);
    }
  }

  for (const player of playerIds) {
    const seat = state.players[player];
    if (seat.poison < 0) problems.push(`${player} has negative poison`);
    if (seat.landsPlayedThisTurn < 0) problems.push(`${player} has played a negative land count`);
  }

  // A decision nobody can answer is an engine hang wearing a decision's clothes.
  const decision = state.pendingDecision;
  if (decision && state.result !== null) {
    problems.push(`the game is over but a ${decision.kind} decision is still pending`);
  }
  if (decision && 'options' in decision && decision.options.length === 0) {
    problems.push(`the pending ${decision.kind} decision offers no options`);
  }

  return problems;
};

/** Throw if the state is malformed. Used by tests and the fuzzer. */
export const assertStateInvariants = (state: GameState): void => {
  const problems = checkStateInvariants(state);
  if (problems.length > 0) {
    throw new Error(`game state invariants violated:\n  ${problems.join('\n  ')}`);
  }
};
