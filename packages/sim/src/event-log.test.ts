import { greedyAgent } from '@mtg/agents';
import { fuzzBoard } from '@mtg/engine/testing';
import { CURRENT_EVENT_LOG_VERSION, migrateEventLog, objectsNamedBy } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { eventLogOf, UnfinishedGameError } from './event-log.js';
import { playGame } from './game.js';

/** A played game as an event log (roadmap 5.2, docs/06 "Event log format"). */

const played = playGame(fuzzBoard('log'), { A: greedyAgent(), B: greedyAgent() }, 'log');
const players = {
  A: { generation: 2, main: [], side: [] },
  B: { generation: 5, main: [], side: [] },
};

describe('the event log of a game', () => {
  const log = eventLogOf({ gameId: 'log', seed: 'log', played, players });

  it('names every object any event mentions, those gone by the end included', () => {
    const named = new Set(log.objects.map((object) => object.id));
    for (const event of log.events) {
      for (const id of objectsNamedBy(event)) expect(named).toContain(id);
    }
    for (const id of played.state.objects.keys()) expect(named).toContain(id);
    expect(named.size).toBe(log.objects.length);
  });

  it('names the abilities that went on the stack, though they ceased to exist (CR 113.7)', () => {
    const withAbilities = playGame(
      fuzzBoard('log-3'),
      { A: greedyAgent(), B: greedyAgent() },
      'log-3',
    );
    const logged = eventLogOf({ gameId: 'x', seed: 'log-3', played: withAbilities, players });
    const ceased = logged.events.flatMap((event) =>
      event.type === 'putOnStack' && !withAbilities.state.objects.has(event.object)
        ? [event.object]
        : [],
    );
    expect(ceased.length).toBeGreaterThan(0);
    for (const id of ceased) {
      expect(logged.objects.find((object) => object.id === id)).toMatchObject({ ability: true });
    }
  });

  it('says which generation of each deck played, and how the game ended', () => {
    expect(log.players.A.deckGeneration).toBe(2);
    expect(log.players.B.deckGeneration).toBe(5);
    expect(log.result).toEqual({
      winner: played.result?.winner,
      reason: played.result?.reason,
      turns: played.result?.turn,
    });
  });

  it('is a current-version log, which the migrations accept as it is', () => {
    expect(log.version).toBe(CURRENT_EVENT_LOG_VERSION);
    expect(migrateEventLog(JSON.parse(JSON.stringify(log)))).toEqual(
      JSON.parse(JSON.stringify(log)),
    );
  });

  it('is refused for a game with no result', () => {
    expect(() =>
      eventLogOf({ gameId: 'x', seed: 'x', played: { ...played, result: null }, players }),
    ).toThrow(UnfinishedGameError);
  });
});
