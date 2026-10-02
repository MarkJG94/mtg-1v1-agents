import { type PlayerId, playerIds } from '../game/player.js';
import type { GameEndReason } from '../game/result.js';
import type { Step } from '../game/steps.js';
import { allZoneIds, playerZone, type ZoneId } from '../game/zones.js';
import type { ObjectId } from '../ids.js';
import type { EventTarget, GameEvent } from './events.js';

/**
 * The log's consumer (docs/06 "Event log format", docs/08 "Rendering"): a game's board
 * rebuilt from its events alone, with neither the engine nor the cards in the loop.
 *
 * It is what the replay viewer draws, and what docs/09's `replay(log) == state` holds
 * against the engine: everything the log says a board *is* — where each object is,
 * tapped or not, its counters and marked damage, who attacks and who blocks, life and
 * poison, the turn, the step, the result — folds out of the events here.
 *
 * What the log does not say, this cannot know: the order of a shuffled library, the
 * mana in a pool, what continuous effects do to power and toughness, who controls a
 * permanent whose control changed, and what an Aura is attached to.
 */

export interface BoardObject {
  readonly id: ObjectId;
  readonly zone: ZoneId;
  readonly tapped: boolean;
  /** Counter kind → how many; a kind at zero is absent. */
  readonly counters: Readonly<Record<string, number>>;
  /** Damage dealt to it this turn; marked on creatures, cleared in cleanup (CR 514.2). */
  readonly damage: number;
  readonly deathtouched: boolean;
  /** What it attacks, from the declaration until combat ends (CR 506.4). */
  readonly attacking: EventTarget | null;
  /** The attackers it blocks (CR 509.1). */
  readonly blocking: readonly ObjectId[];
  /** An activated or triggered ability on the stack, an object in its own right (CR 113.7). */
  readonly ability: boolean;
}

export interface BoardPlayer {
  readonly life: number;
  readonly poison: number;
  readonly mulligans: number;
}

export interface Board {
  /** How many of the game's events have been folded in. */
  readonly applied: number;
  readonly turn: number;
  readonly step: Step | null;
  readonly activePlayer: PlayerId | null;
  readonly onPlay: PlayerId | null;
  readonly players: Readonly<Record<PlayerId, BoardPlayer>>;
  readonly objects: ReadonlyMap<ObjectId, BoardObject>;
  /** Each zone's objects in the order the log puts them there; a stack's last is its top. */
  readonly zones: Readonly<Record<ZoneId, readonly ObjectId[]>>;
  readonly result: { readonly winner: PlayerId | null; readonly reason: GameEndReason } | null;
}

const emptyZones = (): Record<ZoneId, ObjectId[]> =>
  Object.fromEntries(allZoneIds.map((zone) => [zone, []])) as unknown as Record<ZoneId, ObjectId[]>;

export const emptyBoard: Board = {
  applied: 0,
  turn: 0,
  step: null,
  activePlayer: null,
  onPlay: null,
  players: {
    A: { life: 0, poison: 0, mulligans: 0 },
    B: { life: 0, poison: 0, mulligans: 0 },
  },
  objects: new Map(),
  zones: emptyZones(),
  result: null,
};

const freshObject = (id: ObjectId, zone: ZoneId): BoardObject => ({
  id,
  zone,
  tapped: false,
  counters: {},
  damage: 0,
  deathtouched: false,
  attacking: null,
  blocking: [],
  ability: false,
});

/** A board being folded: copy-on-write, so the board it started from is never touched. */
class Draft {
  private objects: Map<ObjectId, BoardObject> | null = null;
  private zones: Record<ZoneId, readonly ObjectId[]> | null = null;
  private players: Record<PlayerId, BoardPlayer> | null = null;
  rest: Omit<Board, 'objects' | 'zones' | 'players'>;

  constructor(private readonly base: Board) {
    const { objects: _objects, zones: _zones, players: _players, ...rest } = base;
    this.rest = rest;
  }

  object(id: ObjectId): BoardObject | undefined {
    return (this.objects ?? this.base.objects).get(id);
  }

  setObject(object: BoardObject): void {
    this.objects ??= new Map(this.base.objects);
    this.objects.set(object.id, object);
  }

  patch(id: ObjectId, patch: Partial<Omit<BoardObject, 'id'>>): void {
    const object = this.object(id);
    if (object !== undefined) this.setObject({ ...object, ...patch });
  }

  /** Take an object out of the game: an ability that resolved, a token that ceased. */
  remove(id: ObjectId): void {
    const object = this.object(id);
    if (object === undefined) return;
    this.setZone(
      object.zone,
      this.zone(object.zone).filter((each) => each !== id),
    );
    this.objects ??= new Map(this.base.objects);
    this.objects.delete(id);
  }

  zone(zone: ZoneId): readonly ObjectId[] {
    return (this.zones ?? this.base.zones)[zone];
  }

  setZone(zone: ZoneId, ids: readonly ObjectId[]): void {
    this.zones ??= { ...this.base.zones };
    this.zones[zone] = ids;
  }

  player(player: PlayerId): BoardPlayer {
    return (this.players ?? this.base.players)[player];
  }

  patchPlayer(player: PlayerId, patch: Partial<BoardPlayer>): void {
    this.players ??= { ...this.base.players };
    this.players[player] = { ...this.player(player), ...patch };
  }

  /**
   * Move an object to the end of a zone, making it if no event has named it before. An
   * object that changes zones becomes a new object with no memory of the old one
   * (CR 400.7): untapped, uncountered, undamaged, out of combat.
   */
  move(id: ObjectId, to: ZoneId): void {
    const object = this.object(id);
    if (object !== undefined) {
      this.setZone(
        object.zone,
        this.zone(object.zone).filter((each) => each !== id),
      );
    }
    this.setZone(to, [...this.zone(to).filter((each) => each !== id), id]);
    const moved = object !== undefined && object.zone !== to;
    this.setObject(
      object === undefined || moved
        ? { ...freshObject(id, to), ability: object?.ability ?? false }
        : { ...object, zone: to },
    );
  }

  /** Every object in a zone, with a patch applied. */
  patchZone(zone: ZoneId, patch: (object: BoardObject) => Partial<Omit<BoardObject, 'id'>>) {
    for (const id of this.zone(zone)) {
      const object = this.object(id);
      if (object !== undefined) this.setObject({ ...object, ...patch(object) });
    }
  }

  done(): Board {
    return {
      ...this.rest,
      players: this.players ?? this.base.players,
      objects: this.objects ?? this.base.objects,
      zones: this.zones ?? this.base.zones,
    };
  }
}

const withCount = (
  counters: Readonly<Record<string, number>>,
  kind: string,
  count: number,
): Record<string, number> => {
  const next = { ...counters };
  if (count > 0) next[kind] = count;
  else delete next[kind];
  return next;
};

/** Fold one event into a board. Pure: the board it is given is unchanged. */
export const applyEvent = (board: Board, event: GameEvent): Board => {
  const draft = new Draft(board);
  draft.rest = { ...draft.rest, applied: board.applied + 1, turn: event.turn, step: event.step };

  switch (event.type) {
    case 'gameStart': {
      // The opening deal is the board's starting point: whatever came before is replaced.
      for (const player of playerIds) {
        for (const kind of ['library', 'hand'] as const) {
          const zone = playerZone(player, kind);
          for (const id of draft.zone(zone)) draft.remove(id);
          const ids = event.decks[player][kind];
          for (const id of ids) draft.move(id, zone);
        }
        draft.patchPlayer(player, { life: event.startingLife, poison: 0, mulligans: 0 });
      }
      draft.rest = { ...draft.rest, onPlay: event.onPlay };
      break;
    }
    case 'mulligan':
      draft.patchPlayer(event.player, { mulligans: draft.player(event.player).mulligans + 1 });
      break;
    case 'keep':
      for (const id of event.bottomed) draft.move(id, playerZone(event.player, 'library'));
      break;
    case 'turnStart':
      draft.rest = { ...draft.rest, activePlayer: event.activePlayer };
      draft.patchZone('battlefield', () => ({ attacking: null, blocking: [] }));
      break;
    case 'stepStart':
      if (event.step === 'endCombat') {
        draft.patchZone('battlefield', () => ({ attacking: null, blocking: [] }));
      }
      if (event.step === 'cleanup') {
        draft.patchZone('battlefield', () => ({ damage: 0, deathtouched: false }));
      }
      break;
    case 'draw':
      draft.move(event.object, playerZone(event.player, 'hand'));
      break;
    case 'putOnStack': {
      // A spell's cast is followed at once by this; an ability is an object nothing has
      // named before it goes on the stack.
      const known = draft.object(event.object) !== undefined;
      draft.move(event.object, 'stack');
      if (!known) draft.patch(event.object, { ability: true });
      break;
    }
    case 'resolve':
      // An ability leaves the game as it resolves (CR 608.2m); a spell's move follows.
      if (draft.object(event.object)?.ability === true) draft.remove(event.object);
      break;
    case 'moveZone':
      draft.move(event.object, event.to);
      break;
    case 'tap':
      draft.patch(event.object, { tapped: true });
      break;
    case 'untap':
      draft.patch(event.object, { tapped: false });
      break;
    case 'counterChange': {
      const object = draft.object(event.object);
      if (object !== undefined) {
        draft.patch(event.object, {
          counters: withCount(object.counters, event.counter, event.to),
        });
      }
      break;
    }
    case 'damage': {
      if (event.target.kind !== 'object') break;
      const object = draft.object(event.target.object);
      if (object !== undefined) {
        draft.patch(object.id, {
          damage: object.damage + event.amount,
          deathtouched: object.deathtouched || event.deathtouch === true,
        });
      }
      break;
    }
    case 'lifeChange':
      draft.patchPlayer(event.player, { life: event.to });
      break;
    case 'poisonChange':
      draft.patchPlayer(event.player, { poison: event.to });
      break;
    case 'attack':
      draft.patch(event.attacker, { attacking: event.defender });
      break;
    case 'block':
      draft.patch(event.blocker, { blocking: [...event.blocking] });
      break;
    case 'sba':
      if (event.kind === 'tokenNotOnBattlefield') {
        for (const id of event.objects) draft.remove(id);
      }
      if (event.kind === 'counterAnnihilation') {
        // +1/+1 and -1/-1 counters cancel one for one (CR 704.5q); the log says which
        // object, and the arithmetic is the rule's.
        for (const id of event.objects) {
          const object = draft.object(id);
          if (object === undefined) continue;
          const plus = object.counters['+1/+1'] ?? 0;
          const minus = object.counters['-1/-1'] ?? 0;
          const cancelled = Math.min(plus, minus);
          draft.patch(id, {
            counters: withCount(
              withCount(object.counters, '+1/+1', plus - cancelled),
              '-1/-1',
              minus - cancelled,
            ),
          });
        }
      }
      break;
    case 'gameEnd':
      draft.rest = { ...draft.rest, result: { winner: event.winner, reason: event.reason } };
      break;
    default:
      break;
  }
  return draft.done();
};

/** Fold a whole run of events. */
export const replayEvents = (events: readonly GameEvent[], from: Board = emptyBoard): Board =>
  events.reduce(applyEvent, from);

/**
 * A game's events with a board kept at the start of every turn, so any point in the game
 * is at most a turn's folding away — what lets a viewer scrub backwards as fast as
 * forwards (docs/08 "Rendering"). Events can keep arriving, for a game being played.
 */
export class Replay {
  private readonly events: GameEvent[] = [];
  /** `[index, board]`: the board before event `index`, at each turn's start. */
  private readonly snapshots: (readonly [number, Board])[] = [[0, emptyBoard]];
  private last: Board = emptyBoard;

  constructor(events: readonly GameEvent[] = []) {
    this.push(events);
  }

  push(events: readonly GameEvent[]): void {
    for (const event of events) {
      if (event.type === 'turnStart') this.snapshots.push([this.events.length, this.last]);
      this.events.push(event);
      this.last = applyEvent(this.last, event);
    }
  }

  get length(): number {
    return this.events.length;
  }

  get all(): readonly GameEvent[] {
    return this.events;
  }

  /** The board after the first `count` events. */
  boardAt(count: number): Board {
    const target = Math.max(0, Math.min(count, this.events.length));
    if (target === this.events.length) return this.last;
    let start: readonly [number, Board] = [0, emptyBoard];
    for (const snapshot of this.snapshots) {
      if (snapshot[0] > target) break;
      start = snapshot;
    }
    return replayEvents(this.events.slice(start[0], target), start[1]);
  }

  /** Where each turn begins: the index of its `turnStart` event. */
  turnStarts(): { readonly turn: number; readonly index: number }[] {
    return this.events.flatMap((event, index) =>
      event.type === 'turnStart' ? [{ turn: event.turn, index }] : [],
    );
  }
}
