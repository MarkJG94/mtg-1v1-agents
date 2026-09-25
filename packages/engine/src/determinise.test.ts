import { playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { determinise, simulatorFor, unknownCard } from './determinise.js';
import { createEventEmitter } from './events/emitter.js';
import { createRng } from './rng.js';
import { setUpGame } from './setup.js';
import type { GameState } from './state/game-state.js';
import { fuzzBoard } from './testing/fuzz.js';
import { randomDecision } from './testing/random-agent.js';
import { game } from './testing/scenario.js';
import { withTheUnseenReplaced } from './testing/unseen.js';
import { applyDecision } from './turn/turn.js';
import type { World } from './view/simulator.js';

/**
 * Determinisation (roadmap 4.3, ADR 0012). What a searching agent plays forward is built
 * from the true state, so the whole of its safety is one property: **the world depends on
 * nothing the viewer cannot see.** It is tested the way the view is, by swapping every
 * hidden card for a different one and requiring the same world.
 */

const board = () =>
  game({ seed: 'determinise' })
    .player('A')
    .battlefield({ name: 'bear', power: 2, toughness: 2 })
    .hand({ name: 'mine-1' }, { name: 'mine-2' })
    .graveyard({ name: 'mine-dead' })
    .library(12)
    .life(18)
    .player('B')
    .battlefield({ name: 'wall', power: 0, toughness: 4 })
    .hand({ name: 'theirs-1' }, { name: 'theirs-2' }, { name: 'theirs-3' })
    .graveyard({ name: 'theirs-dead' })
    .library(9)
    .life(11)
    .get();

const sample = (state: GameState, seed = 'sampler') => determinise(state, 'A', createRng(seed));

describe('the world is a function of only what the viewer can see', () => {
  it('is identical when only the hidden cards differ', () => {
    const state = board();
    const other = withTheUnseenReplaced(state, 'A');

    expect(other.zones[playerZone('B', 'hand')]).not.toEqual(state.zones[playerZone('B', 'hand')]);
    expect(sample(other)).toEqual(sample(state));
  });

  it('differs for B, who can see their own hand, so the check is not vacuous', () => {
    const state = board();
    const other = withTheUnseenReplaced(state, 'A');
    expect(determinise(other, 'B', createRng('s'))).not.toEqual(
      determinise(state, 'B', createRng('s')),
    );
  });

  it('holds on a game in progress, with a real deck of cards on both sides', () => {
    const state = midGame();
    expect(determinise(withTheUnseenReplaced(state, 'A'), 'A', createRng('s'))).toEqual(
      determinise(state, 'A', createRng('s')),
    );
  });
});

describe('what is kept', () => {
  it('keeps every visible object exactly as it was', () => {
    const state = board();
    const world = sample(state);
    for (const zone of [
      'battlefield',
      playerZone('A', 'hand'),
      playerZone('B', 'graveyard'),
    ] as const) {
      expect(world.zones[zone]).toEqual(state.zones[zone]);
      for (const id of state.zones[zone]) expect(world.objects.get(id)).toBe(state.objects.get(id));
    }
    expect(world.players).toBe(state.players);
    expect(world.pendingDecision).toBe(state.pendingDecision);
  });

  it('leaves the game it was sampled from alone', () => {
    const state = board();
    const before = { zones: state.zones, objects: state.objects, rng: state.rng };
    sample(state);
    expect(state.zones).toBe(before.zones);
    expect(state.objects).toBe(before.objects);
    expect(state.rng).toBe(before.rng);
  });
});

describe('what is replaced', () => {
  it('keeps the size of every hidden zone and nothing of its contents', () => {
    const state = board();
    const world = sample(state);
    for (const zone of [
      playerZone('B', 'hand'),
      playerZone('A', 'library'),
      playerZone('B', 'library'),
    ] as const) {
      expect(world.zones[zone]).toHaveLength(state.zones[zone].length);
      for (const id of world.zones[zone]) expect(state.zones[zone]).not.toContain(id);
    }
  });

  it('fills libraries — the viewer’s own too (CR 401.2) — with unknown cards', () => {
    const world = sample(board());
    for (const zone of [playerZone('A', 'library'), playerZone('B', 'library')] as const) {
      for (const id of world.zones[zone]) {
        expect(world.objects.get(id)?.definitionId).toBe(unknownCard);
      }
    }
  });

  it('guesses the opponent’s hand from the cards they have shown', () => {
    const state = board();
    const [dead] = state.zones[playerZone('B', 'graveyard')];
    if (dead === undefined) throw new Error('the board has a card in B’s graveyard');
    const shown = state.objects.get(dead)?.definitionId;
    const world = sample(state);
    for (const id of world.zones[playerZone('B', 'hand')]) {
      expect(world.objects.get(id)?.definitionId).toBe(shown);
    }
  });

  it('makes the opponent’s hand unknown cards when they have shown nothing', () => {
    const state = game({ seed: 'nothing-shown' })
      .player('A')
      .hand({ name: 'mine' })
      .player('B')
      .hand({ name: 'theirs-1' }, { name: 'theirs-2' })
      .get();
    const world = sample(state);
    expect(world.zones[playerZone('B', 'hand')]).toHaveLength(2);
    for (const id of world.zones[playerZone('B', 'hand')]) {
      expect(world.objects.get(id)?.definitionId).toBe(unknownCard);
    }
  });

  it('knows only the definitions of cards the viewer can see', () => {
    const state = midGame();
    const world = determinise(state, 'A', createRng('s'));
    const visible = new Set(
      [...world.objects.values()]
        .filter((object) => object.definitionId !== unknownCard)
        .map((object) => object.definitionId),
    );
    expect(world.definitions.size).toBeGreaterThan(0);
    for (const oracle of world.definitions.keys()) expect(visible).toContain(oracle);
  });

  it('numbers the replacements above every id the viewer can see', () => {
    const state = board();
    const world = sample(state);
    const hiddenIds = world.zones[playerZone('B', 'hand')];
    const highestVisible = Math.max(
      ...state.zones.battlefield,
      ...state.zones[playerZone('A', 'hand')],
    );
    for (const id of hiddenIds) expect(id).toBeGreaterThan(highestVisible);
  });

  it('draws on the sampler’s generator, not the game’s', () => {
    const state = midGame();
    expect(determinise(state, 'A', createRng('one')).rng).not.toEqual(state.rng);
    expect(determinise(state, 'A', createRng('one'))).toEqual(
      determinise(state, 'A', createRng('one')),
    );
    expect(determinise(state, 'A', createRng('one')).rng).not.toEqual(
      determinise(state, 'A', createRng('two')).rng,
    );
  });

  it('forgets the loop detector’s hashes, which were taken of the whole truth', () => {
    const state = { ...board(), statesThisTurn: [1, 2, 3] };
    expect(sample(state).statesThisTurn).toEqual([]);
  });
});

/** A fuzz game run a few turns in, so there are real cards in every zone. */
const midGame = (): GameState => {
  const emitter = createEventEmitter();
  const rng = createRng('mid-game');
  let state = setUpGame(fuzzBoard('mid-game', { creatures: 2 }), emitter);
  const answer = (current: GameState): GameState => {
    const decision = current.pendingDecision;
    if (decision === null) throw new Error('the game stopped without a decision');
    return applyDecision(current, emitter, randomDecision(current, decision, rng));
  };
  while (state.turn < 4 && state.result === null) state = answer(state);
  // Stop at a priority decision for A, which is where a search would be asked.
  while (
    state.result === null &&
    !(state.pendingDecision?.kind === 'priority' && state.pendingDecision.player === 'A')
  ) {
    state = answer(state);
  }
  return state;
};

describe('the simulator a searching agent is handed', () => {
  it('answers from the world, never from the game it was made from', () => {
    const state = midGame();
    const simulator = simulatorFor(state, 'A');
    const world = simulator.sample(createRng('s'));

    expect(simulator.viewer).toBe('A');
    expect(simulator.decision(world)).toEqual(state.pendingDecision);
    const status = simulator.status(world);
    expect(status.turn).toBe(state.turn);
    expect(status.step).toBe(state.step);
    expect(status.stackSize).toBe(state.zones.stack.length);
    expect(simulator.view(world, 'A').you.hand).toEqual(state.zones[playerZone('A', 'hand')]);
    expect(simulator.view(world, 'B').you.hand).not.toEqual(state.zones[playerZone('B', 'hand')]);
  });

  /**
   * A world is played forward by the real rules, unknown cards and all. Twenty worlds run
   * to the end of their games with random answers: an unknown card has to be drawn,
   * discarded and shuffled like any other without the engine noticing.
   */
  it('plays a world to the end of its game by the real rules', () => {
    const state = midGame();
    const simulator = simulatorFor(state, 'A');
    for (let i = 0; i < 20; i += 1) {
      const rng = createRng(`world-${i}`);
      let world: World = simulator.sample(rng);
      let steps = 0;
      for (
        let decision = simulator.decision(world);
        decision !== null;
        decision = simulator.decision(world)
      ) {
        world = simulator.apply(
          world,
          randomDecision(world as unknown as GameState, decision, rng),
        );
        steps += 1;
        if (steps > 5_000) throw new Error('world did not finish');
      }
      expect(simulator.status(world).result).not.toBeNull();
    }
  });

  it('leaves the real game where it was', () => {
    const state = midGame();
    const before = { decision: state.pendingDecision, objects: state.objects, zones: state.zones };
    const simulator = simulatorFor(state, 'A');
    simulator.apply(simulator.sample(createRng('s')), {
      kind: 'priority',
      action: { kind: 'pass' },
    });
    expect(state.pendingDecision).toBe(before.decision);
    expect(state.objects).toBe(before.objects);
    expect(state.zones).toBe(before.zones);
  });
});
