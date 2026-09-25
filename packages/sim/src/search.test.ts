import {
  greedyAgent,
  type PlayAgent,
  type SearchReport,
  type SearchSettings,
  searchAgent,
  searchLevels,
} from '@mtg/agents';
import {
  createRng,
  type Decision,
  type DecisionResponse,
  type GameState,
  type Simulator,
  simulatorFor,
  viewFor,
  type World,
} from '@mtg/engine';
import { fuzzBoard, fuzzBurn, fuzzCreature, fuzzDeck, fuzzLand, game } from '@mtg/engine/testing';
import { describe, expect, it } from 'vitest';
import { playGame } from './game.js';

/**
 * The `search` level (roadmap 4.3), against the real engine. The agents package cannot
 * run a game, so its search is tested here, where every world it plays forward is played
 * by the actual rules and every answer it gives is checked by `applyDecision`.
 *
 * Whether it plays *better* than greedy is the sanity ladder's question, and it is not
 * asked here: the margin is real (roughly three games in five of those decided) but a
 * hundred games cannot tell it from luck — two seed sets of a hundred gave 48–28 and
 * 32–35 — so it is asked at docs/09's 500 games by `pnpm ladder`, nightly.
 */

/** Ask `agent` the pending decision of `state`, the way `playGame` would. */
const ask = (agent: PlayAgent, state: GameState, simulator?: Simulator): DecisionResponse => {
  const decision = state.pendingDecision;
  if (decision === null) throw new Error('nothing to decide');
  return agent.decide(
    viewFor(state, decision.player),
    decision,
    createRng('ask'),
    simulator ?? simulatorFor(state, decision.player),
  );
};

/** A simulator that counts what the search does with it. */
const counting = (inner: Simulator) => {
  const sampled = new Set<World>();
  const counts = { samples: 0, applies: 0, replies: 0, followUps: 0 };
  const simulator: Simulator = {
    viewer: inner.viewer,
    sample: (rng) => {
      counts.samples += 1;
      const world = inner.sample(rng);
      sampled.add(world);
      return world;
    },
    decision: (world) => inner.decision(world),
    apply: (world, response) => {
      counts.applies += 1;
      const decision = inner.decision(world);
      if (response.kind === 'priority' && response.action.kind !== 'pass' && decision !== null) {
        if (decision.player !== inner.viewer) counts.replies += 1;
        else if (!sampled.has(world)) counts.followUps += 1;
      }
      return inner.apply(world, response);
    },
    view: (world, player) => inner.view(world, player),
    status: (world) => inner.status(world),
  };
  return { simulator, counts };
};

const land = { definitionId: fuzzLand.oracleId };
const bolt = { name: 'bolt', definitionId: fuzzBurn.oracleId };
const bear = { definitionId: fuzzCreature.oracleId };

/** A's first main phase, with the board and hand given. */
const mainPhase = (build: (scenario: ReturnType<typeof game>) => ReturnType<typeof game>) =>
  build(game({ seed: 'search', definitions: fuzzDeck, onPlay: 'A' }))
    .start()
    .to('precombatMain')
    .get();

const named = (state: GameState, name: string) =>
  [...state.objects.values()].find((object) => object.name === name)?.id;

/** A burn spell in hand, and two creatures to aim it at: one it kills, one bigger. */
const burnBoard = () =>
  mainPhase((s) =>
    s
      .player('A')
      .battlefield(land)
      .hand(bolt)
      .library(10)
      .player('B')
      .battlefield(
        { name: 'giant', power: 4, toughness: 4 },
        { name: 'bear', power: 2, toughness: 2 },
      )
      .library(10),
  );

describe('what the search sees that greedy has to guess', () => {
  /**
   * Greedy prices a burn spell by the creature it is aimed at (ADR 0011), so it aims at
   * the biggest — here a 4/4 that two damage does not kill. The search resolves the spell
   * in its worlds and sees which creature actually dies.
   */
  it('aims burn at the creature it will kill, not the biggest one', () => {
    const state = burnBoard();
    const bearId = named(state, 'bear');
    const giantId = named(state, 'giant');

    const chosen = (agent: PlayAgent) => {
      const response = ask(agent, state);
      if (response.kind !== 'priority' || response.action.kind !== 'cast') return null;
      const [target] = response.action.targets;
      return target?.kind === 'object' ? target.object : null;
    };

    expect(chosen(greedyAgent())).toBe(giantId);
    expect(chosen(searchAgent())).toBe(bearId);
  });

  /**
   * With too little budget for the full search it falls back on the one-step looks,
   * which see the kill just as well — rather than comparing a finished candidate with one
   * the budget cut short, which would favour whichever was searched first.
   */
  it('still aims burn at the creature it will kill when the budget runs short', () => {
    for (const budget of [15, 25, 40]) {
      const state = burnBoard();
      const response = ask(
        searchAgent('search', undefined, { ...searchLevels.search, budget }),
        state,
      );
      expect(response).toMatchObject({
        kind: 'priority',
        action: { kind: 'cast', targets: [{ kind: 'object', object: named(state, 'bear') }] },
      });
    }
  });

  /**
   * With an opponent holding burn and the mana for it, passing and playing the land tie
   * at depth: the reply that hurts most is a different one in each line and costs the
   * same. The one-step look breaks the tie, and says the land is worth playing — the
   * position a fuzz game found, where search passed and greedy did not.
   */
  it('plays a land rather than passing, even into an opponent holding burn', () => {
    const state = mainPhase((s) =>
      s
        .player('A')
        .battlefield(land)
        .hand({ name: 'spare', ...land })
        .library(10)
        .player('B')
        .battlefield(land)
        // Burn shown five times over against one land, and two cards in hand, so every
        // world this seed samples (the answer is deterministic) holds a burn spell.
        .graveyard(bolt, bolt, bolt, bolt, bolt)
        .hand({ name: 'unseen-1' }, { name: 'unseen-2' })
        .library(10),
    );
    let report: SearchReport | undefined;
    const response = ask(
      searchAgent('search', undefined, searchLevels.search, (seen) => {
        report = seen;
      }),
      state,
    );
    expect(response).toMatchObject({ kind: 'priority', action: { kind: 'playLand' } });
    // And it was the tie-break that decided it, so this test is about the tie-break.
    const [pass, play] = report?.candidates ?? [];
    expect(play?.deep).toBe(pass?.deep);
    expect(play?.shallow).toBeGreaterThan(pass?.shallow ?? Number.POSITIVE_INFINITY);
  });
});

describe('the shape of the search', () => {
  const opponentShowedBurn = () =>
    mainPhase((s) =>
      s
        .player('A')
        .battlefield(land, land)
        .hand(bear, { name: 'extra', ...land })
        .library(10)
        .player('B')
        .battlefield(land)
        .graveyard(bolt)
        .hand({ name: 'unseen' })
        .library(10),
    );

  const searchWith = (
    settings: Partial<SearchSettings>,
    observe?: (report: SearchReport) => void,
  ) => searchAgent('search', undefined, { ...searchLevels.search, ...settings }, observe);

  /** "My action, then the opponent's best cheap response" (docs/04). */
  it('considers the opponent’s responses, drawn from what they have shown', () => {
    const state = opponentShowedBurn();
    const withReplies = counting(simulatorFor(state, 'A'));
    ask(searchWith({ replies: 1 }), state, withReplies.simulator);
    expect(withReplies.counts.replies).toBeGreaterThan(0);

    const without = counting(simulatorFor(state, 'A'));
    ask(searchWith({ replies: 0 }), state, without.simulator);
    expect(without.counts.replies).toBe(0);
  });

  /** "Play a land, then cast what it enables" is one line, not two separate guesses. */
  it('sequences its own actions after the first', () => {
    const state = opponentShowedBurn();
    const sequencing = counting(simulatorFor(state, 'A'));
    ask(searchWith({ followUps: 2 }), state, sequencing.simulator);
    expect(sequencing.counts.followUps).toBeGreaterThan(0);

    const single = counting(simulatorFor(state, 'A'));
    ask(searchWith({ followUps: 0 }), state, single.simulator);
    expect(single.counts.followUps).toBe(0);
  });

  /**
   * Depth-2 assumes the opponent answers with whatever is worst for the searcher. Casting
   * a creature into an opponent holding burn scores lower once their reply is searched
   * than when everyone is assumed to pass — the reply they pick is the one that kills it.
   */
  it('assumes the opponent answers with what is worst for it', () => {
    const state = opponentShowedBurn();
    const reports: SearchReport[] = [];
    ask(
      searchWith({ followUps: 0, replies: 1 }, (report) => reports.push(report)),
      state,
    );
    const cast = reports[0]?.candidates.find((entry) => entry.action.kind === 'cast');
    expect(cast?.deep).not.toBeNull();
    expect(cast?.deep ?? 0).toBeLessThan(cast?.shallow ?? 0);
  });

  it('samples as many worlds as it is told to', () => {
    const state = opponentShowedBurn();
    const three = counting(simulatorFor(state, 'A'));
    ask(searchWith({ samples: 3 }), state, three.simulator);
    expect(three.counts.samples).toBe(3);
  });

  /** The budget is in engine steps, so a decision costs the same on every machine. */
  it('never spends more engine steps than its budget', () => {
    for (const budget of [1, 10, 50, searchLevels.search.budget]) {
      const state = opponentShowedBurn();
      const { simulator, counts } = counting(simulatorFor(state, 'A'));
      const response = ask(searchWith({ budget }), state, simulator);
      expect(counts.applies).toBeLessThanOrEqual(budget);
      expect(response.kind).toBe('priority');
    }
  });

  it('does not search a decision whose only option is to pass', () => {
    const state = mainPhase((s) => s.player('A').library(10).player('B').library(10));
    const { simulator, counts } = counting(simulatorFor(state, 'A'));
    expect(ask(searchAgent(), state, simulator)).toEqual({
      kind: 'priority',
      action: { kind: 'pass' },
    });
    expect(counts.samples).toBe(0);
  });

  it('gives the same answer from the same generator, and leaves the game alone', () => {
    const state = opponentShowedBurn();
    const before = { objects: state.objects, zones: state.zones, rng: state.rng };
    expect(ask(searchAgent(), state)).toEqual(ask(searchAgent(), state));
    expect(state.objects).toBe(before.objects);
    expect(state.zones).toBe(before.zones);
    expect(state.rng).toBe(before.rng);
  });
});

describe('everything but priority is greedy’s, until the combat solver (4.4)', () => {
  it('answers every other decision exactly as greedy does', () => {
    const greedy = greedyAgent();
    const search = searchAgent();
    let compared = 0;
    const comparing: PlayAgent = {
      level: 'search',
      decide: (view, decision: Decision, rng, simulator) => {
        const answer = search.decide(view, decision, rng, simulator);
        if (decision.kind !== 'priority') {
          compared += 1;
          expect(answer).toEqual(greedy.decide(view, decision, rng, simulator));
        }
        return answer;
      },
    };
    playGame(fuzzBoard('others', { creatures: 3 }), { A: comparing, B: greedy }, 'others');
    expect(compared).toBeGreaterThan(5);
  });
});
