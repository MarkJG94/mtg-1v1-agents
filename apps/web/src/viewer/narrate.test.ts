import type { GameEvent, GameEventBody, ObjectId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { faceOf, cards as fixtureCards, gameEvents, gameObjects } from '../test/fixtures.js';
import { type GameCards, namesFor } from './model.js';
import { Narrator } from './narrate.js';

/** The ticker's play-by-play (docs/08 "Game viewer"). */

const faces = new Map(Object.values(fixtureCards).map((card) => [card.oracleId, faceOf(card)]));
const fixture: GameCards = {
  identities: new Map(gameObjects.map((object) => [object.id, object])),
  faces,
};

const tell = (events: readonly GameEvent[], reveal = false, cards: GameCards = fixture) => {
  const narrator = new Narrator(namesFor(cards), { reveal: (player) => player === 'A' || reveal });
  narrator.push(events);
  return narrator.lines;
};

const texts = (events: readonly GameEvent[], reveal = false) =>
  tell(events, reveal).map((line) => line.text);

describe('the play-by-play of a game', () => {
  it('tells what a person would, and leaves out what the board shows on its own', () => {
    expect(texts(gameEvents)).toEqual([
      'B chooses to draw, so A plays first',
      'A keeps 3',
      'B keeps 2',
      'Turn 1 — A',
      'A plays Mountain',
      'A casts Goblin Guide',
      'Goblin Guide resolves',
      'Goblin Guide attacks B',
      'Goblin Guide deals 2 damage to B',
      'Turn 2 — B',
      'B draws a card',
      'B casts Shock targeting Goblin Guide',
      'Shock resolves',
      'Shock deals 2 damage to Goblin Guide',
      'Goblin Guide dies',
      'Turn 3 — A',
      'A draws Chain Lightning',
      'A casts Chain Lightning targeting B',
      'B responds with Pyroblast targeting Chain Lightning',
      'Pyroblast resolves',
      'Chain Lightning is countered by Pyroblast',
      'A casts Lightning Bolt targeting B',
      'Lightning Bolt resolves',
      'Lightning Bolt deals 3 damage to B',
      'A wins by concession',
    ]);
  });

  it('leaves the opening hands’ dealing to the keep, and tells who chose what', () => {
    let seq = 0;
    const deal = (player: 'A' | 'B', object: number): GameEvent =>
      ({ seq: seq++, turn: 0, step: 'untap', type: 'draw', player, object }) as GameEvent;
    const start = gameEvents[0] as GameEvent;
    expect(texts([deal('A', 4), deal('B', 13), start, deal('A', 5)], true)).toEqual([
      'B chooses to draw, so A plays first',
    ]);
    expect(texts([{ ...start, chosenBy: 'A' } as GameEvent])).toEqual(['A chooses to play first']);
  });

  it('names what B draws only when hidden information is revealed', () => {
    expect(texts(gameEvents, true)).toContain('B draws Forest');
    expect(texts(gameEvents, false)).toContain('B draws a card');
  });

  it('keeps each line’s event, so the ticker knows where the transport is', () => {
    const lines = tell(gameEvents);
    for (const line of lines) {
      expect(gameEvents[line.index]?.turn).toBe(line.turn);
    }
    const shock = lines.find((line) => line.text.startsWith('B casts Shock'));
    expect(gameEvents[shock?.index ?? -1]).toMatchObject({ type: 'cast', object: 13 });
  });

  it('puts a decision’s score on the action it led to, and on nothing else', () => {
    const scored = tell(gameEvents).filter((line) => line.score !== undefined);
    expect(scored.map((line) => [line.text, line.score])).toEqual([
      ['A plays Mountain', 2],
      ['A casts Goblin Guide', 3],
      ['B casts Shock targeting Goblin Guide', -1.5],
    ]);
  });
});

describe('telling the less common events', () => {
  let seq = 0;
  const at = (body: GameEventBody): GameEvent =>
    ({ seq: seq++, turn: 4, step: 'precombatMain', ...body }) as GameEvent;
  const ability = 90 as ObjectId;
  const token = 91 as ObjectId;
  const cards: GameCards = {
    identities: new Map([
      ...fixture.identities,
      [ability, { id: ability, oracleId: 'goblin' as never, owner: 'A', ability: true }],
      [
        token,
        {
          id: token,
          oracleId: 'goblin' as never,
          owner: 'A',
          token: true,
          name: 'Goblin',
          power: 1,
          toughness: 1,
        },
      ],
    ]),
    faces,
  };

  it('tells an ability put on the stack, and not a mana ability, which never is', () => {
    const lines = tell(
      [
        ...gameEvents.slice(0, 1),
        at({ type: 'decision', player: 'A', kind: 'priority', chosen: {}, score: 4 }),
        at({ type: 'activate', player: 'A', source: 6 as ObjectId, abilityIndex: 0, targets: [] }),
        at({ type: 'tap', object: 6 as ObjectId }),
        at({
          type: 'activate',
          player: 'A',
          source: 4 as ObjectId,
          abilityIndex: 1,
          targets: [{ kind: 'player', player: 'B' }],
        }),
        at({ type: 'putOnStack', object: ability }),
      ],
      false,
      cards,
    );
    expect(lines.map((line) => line.text)).toEqual([
      'B chooses to draw, so A plays first',
      'A activates Goblin Guide targeting B',
    ]);
    // The mana ability paid for it; the decision was to activate the ability.
    expect(lines.at(-1)?.score).toBe(4);
  });

  it('keeps a score for the action, past what else the same player does on the way', () => {
    const lines = tell([
      at({ type: 'decision', player: 'A', kind: 'priority', chosen: {}, score: 5 }),
      at({ type: 'draw', player: 'A', object: 1 as ObjectId }),
      at({ type: 'lifeChange', player: 'A', from: 20, to: 19, reason: 'loss' }),
      at({ type: 'playLand', player: 'A', object: 6 as ObjectId }),
    ]);
    expect(lines.map((line) => [line.text, line.score])).toEqual([
      ['A draws Chain Lightning', undefined],
      ['A loses 1 life (19)', undefined],
      ['A plays Mountain', 5],
    ]);
  });

  it('names a token and an ability as what they are', () => {
    expect(
      tell(
        [
          at({
            type: 'moveZone',
            object: token,
            from: 'battlefield',
            to: 'battlefield',
            cause: 'tokenCreated',
          }),
          at({ type: 'trigger', controller: 'A', source: 4 as ObjectId, abilityIndex: 0 }),
          at({ type: 'putOnStack', object: ability }),
          at({ type: 'resolve', object: ability }),
          at({ type: 'counterChange', object: token, counter: '+1/+1', from: 0, to: 2 }),
          at({ type: 'poisonChange', player: 'B', from: 0, to: 3 }),
          at({ type: 'lifeChange', player: 'A', from: 20, to: 23, reason: 'gain' }),
          at({ type: 'block', blocker: 13 as ObjectId, blocking: [token] }),
          at({ type: 'gameEnd', winner: null, reason: 'turnCap' }),
        ],
        false,
        cards,
      ).map((line) => line.text),
    ).toEqual([
      'A creates Goblin token',
      'Goblin Guide triggers',
      'Goblin Guide’s ability resolves',
      'Goblin token gets 2 +1/+1 counters',
      'B gets 3 poison (3)',
      'A gains 3 life (23)',
      'Shock blocks Goblin token',
      'A draw: the turn cap',
    ]);
  });
});
