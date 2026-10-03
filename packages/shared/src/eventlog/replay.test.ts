import { describe, expect, it } from 'vitest';
import type { Step } from '../game/steps.js';
import { asObjectId, type ObjectId } from '../ids.js';
import type { GameEvent, GameEventBody } from './events.js';
import { applyEvent, Replay, replayEvents } from './replay.js';

/**
 * The log's consumer (docs/06, docs/08 "Rendering"). The engine-level check that a folded
 * log equals the engine's own board after every decision is `replay-check` in
 * @mtg/engine/testing, over random games of the fuzz cards and of the whole bootstrap
 * set; these are the rules no random game is sure to reach.
 */

const id = (n: number): ObjectId => asObjectId(n);
let seq = 0;
const at =
  (turn: number, step: Step) =>
  (body: GameEventBody): GameEvent =>
    ({ seq: seq++, turn, step, ...body }) as GameEvent;

const start = at(
  0,
  'untap',
)({
  type: 'gameStart',
  onPlay: 'A',
  chosenBy: null,
  startingLife: 20,
  decks: {
    A: { library: [id(1), id(2), id(3)], hand: [id(4), id(5)] },
    B: { library: [id(11), id(12)], hand: [id(13)] },
  },
});

/** A's creature, object 4, cast and on the battlefield in A's first main phase. */
const creatureOut = [
  start,
  at(1, 'untap')({ type: 'turnStart', activePlayer: 'A' }),
  at(1, 'precombatMain')({ type: 'cast', player: 'A', object: id(4), targets: [] }),
  at(1, 'precombatMain')({ type: 'putOnStack', object: id(4) }),
  at(1, 'precombatMain')({ type: 'resolve', object: id(4) }),
  at(
    1,
    'precombatMain',
  )({
    type: 'moveZone',
    object: id(4),
    from: 'stack',
    to: 'battlefield',
    cause: 'resolve',
  }),
];

describe('a board folded from its log', () => {
  it('deals the opening hands and life the game started with', () => {
    const board = replayEvents([start]);
    expect(board.zones['A:hand']).toEqual([4, 5]);
    expect(board.zones['A:library']).toEqual([1, 2, 3]);
    expect(board.zones['B:hand']).toEqual([13]);
    expect(board.players.A.life).toBe(20);
    expect(board.onPlay).toBe('A');
  });

  it('puts a spell on the stack, then where it resolves to, with the turn and step it is in', () => {
    const board = replayEvents(creatureOut);
    expect(board.zones.stack).toEqual([]);
    expect(board.zones.battlefield).toEqual([4]);
    expect(board.zones['A:hand']).toEqual([5]);
    expect([board.turn, board.step, board.activePlayer]).toEqual([1, 'precombatMain', 'A']);
  });

  it('keeps life and poison as the log says (CR 122.1)', () => {
    const board = replayEvents([
      start,
      at(1, 'precombatMain')({ type: 'lifeChange', player: 'B', from: 20, to: 17, reason: 'x' }),
      at(1, 'precombatMain')({ type: 'poisonChange', player: 'B', from: 0, to: 3 }),
    ]);
    expect(board.players.B).toMatchObject({ life: 17, poison: 3 });
    expect(board.players.A).toMatchObject({ life: 20, poison: 0 });
  });

  it('cancels +1/+1 against -1/-1 counters one for one (CR 704.5q)', () => {
    const board = replayEvents([
      ...creatureOut,
      at(
        1,
        'precombatMain',
      )({
        type: 'counterChange',
        object: id(4),
        counter: '+1/+1',
        from: 0,
        to: 3,
      }),
      at(
        1,
        'precombatMain',
      )({
        type: 'counterChange',
        object: id(4),
        counter: '-1/-1',
        from: 0,
        to: 1,
      }),
      at(1, 'precombatMain')({ type: 'sba', kind: 'counterAnnihilation', objects: [id(4)] }),
    ]);
    expect(board.objects.get(id(4))?.counters).toEqual({ '+1/+1': 2 });
  });

  it('marks damage until cleanup, and remembers deathtouch with it (CR 514.2, 702.2b)', () => {
    const hit = replayEvents([
      ...creatureOut,
      at(
        1,
        'precombatMain',
      )({
        type: 'damage',
        source: id(13),
        target: { kind: 'object', object: id(4) },
        amount: 2,
        combat: false,
        deathtouch: true,
      }),
    ]);
    expect(hit.objects.get(id(4))).toMatchObject({ damage: 2, deathtouched: true });
    const cleaned = applyEvent(hit, at(1, 'cleanup')({ type: 'stepStart' }));
    expect(cleaned.objects.get(id(4))).toMatchObject({ damage: 0, deathtouched: false });
  });

  it('forgets a permanent that changes zones (CR 400.7)', () => {
    const board = replayEvents([
      ...creatureOut,
      at(1, 'precombatMain')({ type: 'tap', object: id(4) }),
      at(
        1,
        'precombatMain',
      )({
        type: 'counterChange',
        object: id(4),
        counter: '+1/+1',
        from: 0,
        to: 1,
      }),
      at(
        1,
        'precombatMain',
      )({
        type: 'moveZone',
        object: id(4),
        from: 'battlefield',
        to: 'A:hand',
        cause: 'return',
      }),
    ]);
    expect(board.objects.get(id(4))).toMatchObject({ zone: 'A:hand', tapped: false });
    expect(board.objects.get(id(4))?.counters).toEqual({});
  });

  it('knows an ability on the stack as one, and takes it out of the game as it resolves', () => {
    const ability = id(99);
    const onStack = replayEvents([
      ...creatureOut,
      at(1, 'precombatMain')({ type: 'trigger', controller: 'A', source: id(4), abilityIndex: 0 }),
      at(1, 'precombatMain')({ type: 'putOnStack', object: ability }),
    ]);
    expect(onStack.objects.get(ability)).toMatchObject({ zone: 'stack', ability: true });
    expect(onStack.objects.get(id(4))?.ability).toBe(false);
    const resolved = applyEvent(
      onStack,
      at(1, 'precombatMain')({ type: 'resolve', object: ability }),
    );
    expect(resolved.objects.has(ability)).toBe(false);
    expect(resolved.zones.stack).toEqual([]);
  });

  it('lets a token cease to exist once it has left the battlefield (CR 111.7)', () => {
    const token = id(50);
    const board = replayEvents([
      ...creatureOut,
      at(
        1,
        'precombatMain',
      )({
        type: 'moveZone',
        object: token,
        from: 'battlefield',
        to: 'battlefield',
        cause: 'resolve',
      }),
      at(
        1,
        'precombatMain',
      )({
        type: 'moveZone',
        object: token,
        from: 'battlefield',
        to: 'B:graveyard',
        cause: 'destroy',
      }),
      at(1, 'precombatMain')({ type: 'sba', kind: 'tokenNotOnBattlefield', objects: [token] }),
    ]);
    expect(board.objects.has(token)).toBe(false);
    expect(board.zones['B:graveyard']).toEqual([]);
  });

  it('marks attackers and blockers until combat ends (CR 506.4)', () => {
    const fought = replayEvents([
      ...creatureOut,
      at(
        1,
        'declareAttackers',
      )({
        type: 'attack',
        attacker: id(4),
        defender: { kind: 'player', player: 'B' },
      }),
      at(1, 'declareBlockers')({ type: 'block', blocker: id(13), blocking: [id(4)] }),
    ]);
    expect(fought.objects.get(id(4))?.attacking).toEqual({ kind: 'player', player: 'B' });
    const over = applyEvent(fought, at(1, 'endCombat')({ type: 'stepStart' }));
    expect(over.objects.get(id(4))?.attacking).toBeNull();
  });

  it('never changes the board it was given', () => {
    const before = replayEvents(creatureOut);
    const snapshot = JSON.stringify([...before.objects], null, 0);
    applyEvent(before, at(1, 'precombatMain')({ type: 'tap', object: id(4) }));
    expect(JSON.stringify([...before.objects], null, 0)).toBe(snapshot);
  });
});

describe('a replay, scrubbed', () => {
  const events = [
    ...creatureOut,
    at(2, 'untap')({ type: 'turnStart', activePlayer: 'B' }),
    at(2, 'draw')({ type: 'draw', player: 'B', object: id(11) }),
    at(3, 'untap')({ type: 'turnStart', activePlayer: 'A' }),
    at(3, 'precombatMain')({ type: 'tap', object: id(4) }),
    at(3, 'precombatMain')({ type: 'gameEnd', winner: 'A', reason: 'life' }),
  ];

  it('gives the same board at every point as folding from the start', () => {
    const replay = new Replay(events);
    for (let count = 0; count <= events.length; count += 1) {
      expect(replay.boardAt(count)).toEqual(replayEvents(events.slice(0, count)));
    }
  });

  it('takes events as they arrive, and says where each turn begins', () => {
    const replay = new Replay(events.slice(0, 4));
    replay.push(events.slice(4));
    expect(replay.length).toBe(events.length);
    expect(replay.turnStarts()).toEqual([
      { turn: 1, index: 1 },
      { turn: 2, index: 6 },
      { turn: 3, index: 8 },
    ]);
    expect(replay.boardAt(events.length).result).toEqual({ winner: 'A', reason: 'life' });
  });
});
