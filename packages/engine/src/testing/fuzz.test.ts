import { playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { createRng } from '../rng.js';
import { updateObject } from '../state/update.js';
import {
  checkRulesInvariants,
  fuzzGame,
  fuzzGames,
  InvariantViolation,
  replayIsIdentical,
} from './fuzz.js';
import { randomDecision } from './random-agent.js';
import { game } from './scenario.js';

/**
 * How many games to fuzz. Forty in an ordinary run, because a test suite somebody runs on
 * every save has to stay quick, and whatever `FUZZ_GAMES` says in the nightly, where the
 * point is to play enough games to find the rare one that breaks an invariant (docs/09).
 *
 * Read off `globalThis` rather than through `process`, because the engine's tsconfig
 * carries no Node types and this file lives inside it.
 */
const budget = (): number => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const asked = Number(env?.['FUZZ_GAMES']);
  return Number.isInteger(asked) && asked > 0 ? asked : 40;
};

describe('the random agent', () => {
  it('answers every decision kind the engine can raise', () => {
    // The point of this test is the list: a decision kind the agent cannot answer would
    // look like an engine hang in a fuzz run rather than a missing case.
    const rng = createRng('answers');
    const state = game().player('A').library(5).start().get();

    const kinds = [
      { kind: 'priority', player: 'A', options: [{ kind: 'pass' }] },
      { kind: 'mulligan', player: 'A', hand: [], taken: 0, options: ['keep', 'mulligan'] },
      { kind: 'bottomCards', player: 'A', count: 0, from: [] },
      { kind: 'discard', player: 'A', count: 0, from: [] },
      { kind: 'declareAttackers', player: 'A', legal: [], defenders: [] },
      { kind: 'declareBlockers', player: 'B', attackers: [], available: [], canBlock: [] },
      { kind: 'orderBlockers', player: 'A', attacker: 1, blockers: [] },
      { kind: 'orderTriggers', player: 'A', triggers: [] },
      { kind: 'chooseOption', player: 'A', reason: 'legendRule', options: [1] },
      {
        kind: 'chooseReplacement',
        player: 'A',
        options: [1],
        event: { kind: 'draw', player: 'A' },
      },
    ] as const;

    for (const decision of kinds) {
      const response = randomDecision(state, decision as never, rng);
      expect(response.kind).toBe(decision.kind);
    }
  });

  it('draws from the injected generator, so the same seed answers the same way', () => {
    const decision = {
      kind: 'orderTriggers',
      player: 'A',
      triggers: ['a', 'b', 'c', 'd', 'e'],
    } as const;
    const state = game().start().get();

    const first = randomDecision(state, decision, createRng('same'));
    const second = randomDecision(state, decision, createRng('same'));
    const other = randomDecision(state, decision, createRng('different'));

    expect(first).toEqual(second);
    // Not a guarantee for any one seed, but these two orders do differ.
    expect(first).not.toEqual(other);
  });
});

describe('the invariant fuzzer', () => {
  it('plays a game to its end and reports how it finished', () => {
    const result = fuzzGame('one', { turnCap: 6 });
    expect(result.state.result).not.toBeNull();
    expect(result.decisions.length).toBeGreaterThan(0);
    expect(result.turns).toBeGreaterThan(0);
  });

  it('plays many games without violating an invariant', () => {
    const games = budget();
    const results = fuzzGames(games, { turnCap: 8, librarySize: 20 });
    expect(results).toHaveLength(games);
    for (const result of results) expect(result.state.result).not.toBeNull();
  });

  it('reaches combat and kills creatures, so it is exercising something', () => {
    const results = fuzzGames(20, { turnCap: 10, creatures: 4 });
    const anyGraveyard = results.some(
      (result) => result.state.zones[playerZone('A', 'graveyard')].length > 0,
    );
    expect(anyGraveyard).toBe(true);
  });

  it('replays a recorded game to the same place', () => {
    const options = { turnCap: 6, librarySize: 20 };
    for (const seed of ['r1', 'r2', 'r3']) {
      expect(replayIsIdentical(fuzzGame(seed, options), options)).toBe(true);
    }
  });

  it('is reproducible: the same seed plays the same decisions', () => {
    const options = { turnCap: 6 };
    expect(fuzzGame('repeat', options).decisions).toEqual(fuzzGame('repeat', options).decisions);
  });

  /**
   * The fuzzer is only worth having if it fails on a broken position. Rather than break
   * the engine, hand the checker a state that is already wrong and confirm it says so.
   */
  it('catches a creature left on the battlefield with no toughness', () => {
    const scenario = game()
      .player('A')
      .battlefield({ name: 'doomed', power: 1, toughness: 1 })
      .start();
    const broken = updateObject(scenario.get(), scenario.ref('doomed'), { toughness: 0 });

    expect(checkRulesInvariants(broken)).toContainEqual(expect.stringContaining('toughness 0'));
  });

  it('catches two same-name legends under one controller', () => {
    const scenario = game()
      .player('A')
      .battlefield(
        { name: 'twin', power: 1, toughness: 1, legendary: true },
        { name: 'twin', power: 1, toughness: 1, legendary: true },
      )
      .start();

    expect(checkRulesInvariants(scenario.get())).toContainEqual(
      expect.stringContaining('legendary permanents named "twin"'),
    );
  });

  it('catches an object that is in two zones at once', () => {
    const scenario = game()
      .player('A')
      .battlefield({ name: 'here', power: 1, toughness: 1 })
      .start();
    const state = scenario.get();
    const id = scenario.ref('here');
    const broken = {
      ...state,
      zones: { ...state.zones, exile: [id] },
    };

    expect(checkRulesInvariants(broken)).toContainEqual(expect.stringContaining('in both'));
  });

  it('catches a decision that offers nothing to choose', () => {
    const state = game().player('A').library(5).start().get();
    const broken = {
      ...state,
      pendingDecision: { kind: 'priority', player: 'A', options: [] } as const,
    };

    expect(checkRulesInvariants(broken)).toContainEqual(
      expect.stringContaining('offers no options'),
    );
  });

  it('catches a counter left at zero rather than removed', () => {
    const scenario = game()
      .player('A')
      .battlefield({ name: 'thing', power: 1, toughness: 1 })
      .start();
    const broken = updateObject(scenario.get(), scenario.ref('thing'), {
      counters: { '+1/+1': 0 },
    });

    expect(checkRulesInvariants(broken)).toContainEqual(expect.stringContaining('zero entry'));
  });

  it('reports the seed and decision count when a game breaks', () => {
    const violation = new InvariantViolation('bad-seed', 12, ['something is wrong'], {
      turn: 3,
      step: 'upkeep',
    } as never);

    expect(violation.message).toContain('bad-seed');
    expect(violation.message).toContain('12 decision');
    expect(violation.message).toContain('turn 3');
  });

  it('refuses to pass a game that never finishes', () => {
    // A cap of one decision cannot finish a game, and that is itself a finding.
    expect(() => fuzzGame('stuck', { maxDecisions: 1 })).toThrow(InvariantViolation);
  });
});

describe('the scenario builder', () => {
  it('builds a board and finds objects again by label', () => {
    const scenario = game()
      .player('A')
      .battlefield({ name: 'bear', power: 2, toughness: 2 })
      .player('B')
      .battlefield({ name: 'wall', power: 0, toughness: 4 })
      .start();

    expect(scenario.object('bear').controller).toBe('A');
    expect(scenario.object('wall').controller).toBe('B');
    expect(scenario.zoneOf('bear')).toBe('battlefield');
  });

  it('gives two permanents with one name distinct labels, for the legend rule', () => {
    const scenario = game()
      .player('A')
      .battlefield(
        { name: 'hero', legendary: true, power: 1, toughness: 1 },
        { name: 'hero', legendary: true, power: 1, toughness: 1 },
      );

    expect(scenario.ref('hero')).not.toBe(scenario.ref('hero 2'));
    expect(scenario.object('hero').name).toBe('hero');
    expect(scenario.object('hero 2').name).toBe('hero');
  });

  it('gives a planeswalker its starting loyalty even when placed directly', () => {
    const scenario = game().player('A').battlefield({ name: 'walker', loyalty: 4 });
    expect(scenario.object('walker').counters.loyalty).toBe(4);
  });

  it('drives combat through the real decisions', () => {
    const scenario = game({ seed: 'combat' })
      .player('A')
      .battlefield({ name: 'attacker', power: 3, toughness: 3 })
      .player('B')
      .battlefield({ name: 'blocker', power: 1, toughness: 1 })
      .start()
      .to('declareAttackers')
      .attack('attacker')
      // Players get priority in the declare attackers step (CR 508.2), so the block
      // decision is not the next one.
      .to('declareBlockers')
      .block({ blocker: 'blocker', blocking: 'attacker' })
      .to('end');

    expect(scenario.zoneOf('blocker')).toBe(playerZone('B', 'graveyard'));
    expect(scenario.lifeOf('B')).toBe(20);
  });

  it('sends an attack at a planeswalker when told to', () => {
    const scenario = game({ seed: 'pw' })
      .player('A')
      .battlefield({ name: 'attacker', power: 3, toughness: 3 })
      .player('B')
      .battlefield({ name: 'walker', loyalty: 5 })
      .start()
      .to('declareAttackers')
      .attack({ attacker: 'attacker', at: 'walker' })
      .to('end');

    expect(scenario.object('walker').counters.loyalty).toBe(2);
    expect(scenario.lifeOf('B')).toBe(20);
  });

  it('records events when asked', () => {
    const scenario = game({ recordEvents: true }).player('A').library(3).start().to('draw');
    expect(scenario.events()).toContain('turnStart');
  });

  it('throws on an unknown label rather than returning nothing', () => {
    expect(() => game().ref('nobody')).toThrow(/no object labelled/);
  });

  it('keeps every state it builds structurally sound', () => {
    const scenario = game()
      .player('A')
      .battlefield({ power: 1, toughness: 1 }, { name: 'aura', attachment: 'aura' })
      .library(4)
      .graveyard({})
      .player('B')
      .battlefield({ loyalty: 3 })
      .hand({}, {})
      .library(4);

    expect(checkRulesInvariants(scenario.get())).toEqual([]);
    expect(checkRulesInvariants(scenario.start().get())).toEqual([]);
  });
});
