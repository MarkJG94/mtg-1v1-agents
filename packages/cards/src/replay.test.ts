import { fileURLToPath } from 'node:url';
import { createGameState, createObject, createRng, type GameState } from '@mtg/engine';
import { replayCheckedGame } from '@mtg/engine/testing';
import { playerIds, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { readScripts } from './files.js';
import { loadCardScript } from './load.js';

/**
 * docs/09's `replay(log) == state` over the real bootstrap set: games dealt from every
 * scripted card — tokens that come and go, counters, a planeswalker's loyalty,
 * abilities on the stack, permanents that die and come back — played at random, with the
 * log folded and held against the engine after every decision. The fuzzer's own cards
 * cannot reach most of this.
 */

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
const definitions = readScripts(here('../scripts')).map((file) => loadCardScript(file.content));
const lands = definitions.filter((card) => card.types.includes('land'));
const spells = definitions.filter((card) => !card.types.includes('land'));

const board = (seed: string): GameState => {
  const rng = createRng(`${seed}:board`);
  let state = createGameState({ rng: createRng(seed).save(), onPlay: 'A', definitions });
  for (const player of playerIds) {
    for (let i = 0; i < 40; i += 1) {
      const card = i % 5 < 2 ? rng.pick(lands) : rng.pick(spells);
      state = createObject(state, {
        definitionId: card.oracleId,
        owner: player,
        zone: playerZone(player, 'library'),
      }).state;
    }
  }
  return state;
};

describe('replay(log) == state, with real cards', () => {
  it('holds after every decision of games dealt from the whole bootstrap set', () => {
    const games = Array.from({ length: 60 }, (_, i) =>
      replayCheckedGame(`bootstrap-${i}`, board(`bootstrap-${i}`)),
    );
    expect(games.reduce((sum, game) => sum + game.turns, 0)).toBeGreaterThan(60 * 5);
  });
});
