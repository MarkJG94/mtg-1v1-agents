import type {
  Decision,
  DecisionResponse,
  DeclareBlockersDecision,
  PlayerView,
  PriorityAction,
} from '@mtg/engine/view';
import type { ObjectId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { greedyAgent, prior } from './greedy.js';
import { card, cast, creature, land, scriptedRng, viewOf } from './test-views.js';
import { defaultWeights as w } from './weights.js';

/**
 * The `greedy` level (docs/04): one evaluation per legal action and no search. Each test
 * is a position where the right answer is not in doubt, so a rule that stopped working
 * shows up as greedy doing the obviously wrong thing.
 */

const greedy = greedyAgent();

const decide = (view: PlayerView, decision: Decision): DecisionResponse =>
  greedy.decide(view, decision, scriptedRng());

const choose = (view: PlayerView, options: readonly PriorityAction[]): PriorityAction => {
  const response = decide(view, {
    kind: 'priority',
    player: 'A',
    options: [{ kind: 'pass' }, ...options],
  });
  if (response.kind !== 'priority')
    throw new Error(`answered a priority decision with ${response.kind}`);
  return response.action;
};

describe('at priority, the best-looking action or nothing', () => {
  it('plays a land rather than passing', () => {
    const forest = land({ zone: 'hand' });
    const view = viewOf({ hand: [forest] });
    expect(choose(view, [{ kind: 'playLand', object: forest.id }])).toEqual({
      kind: 'playLand',
      object: forest.id,
    });
  });

  it('casts a creature it can pay for rather than holding it', () => {
    const bear = creature(2, 2, { zone: 'hand', manaValue: 2 });
    const view = viewOf({ mine: [land(), land()], hand: [bear] });
    expect(choose(view, [cast(bear.id)])).toEqual(cast(bear.id));
  });

  it('passes when the only thing it could do is nothing it can see a gain in', () => {
    expect(choose(viewOf(), [])).toEqual({ kind: 'pass' });
  });

  /**
   * Greedy cannot see what a spell does, so the prior is all that tells a burn spell at
   * the opponent's creature from the same spell at its own. Without it the two score the
   * same and the first offered wins — which here is the wrong one.
   */
  it('aims removal at the opponent’s creature and never at its own', () => {
    const bolt = card({ zone: 'hand', types: ['instant'], manaValue: 1 });
    const mine = creature(3, 3);
    const theirs = creature(3, 3);
    const view = viewOf({ mine: [land(), mine], theirs: [theirs], hand: [bolt] });

    const atMine = cast(bolt.id, [{ kind: 'object', object: mine.id }]);
    const atTheirs = cast(bolt.id, [{ kind: 'object', object: theirs.id }]);

    expect(choose(view, [atMine, atTheirs])).toEqual(atTheirs);
    expect(choose(view, [atMine])).toEqual({ kind: 'pass' });
  });

  it('aims removal at the bigger threat', () => {
    const bolt = card({ zone: 'hand', types: ['instant'], manaValue: 1 });
    const small = creature(1, 1);
    const big = creature(4, 3, { keywords: { flying: true } });
    const view = viewOf({ mine: [land()], theirs: [small, big], hand: [bolt] });

    const atSmall = cast(bolt.id, [{ kind: 'object', object: small.id }]);
    const atBig = cast(bolt.id, [{ kind: 'object', object: big.id }]);

    expect(choose(view, [atSmall, atBig])).toEqual(atBig);
  });

  it('aims a spell at the opponent, not at itself', () => {
    const shock = card({ zone: 'hand', types: ['instant'], manaValue: 1 });
    const view = viewOf({ mine: [land()], hand: [shock] });

    const atThem = cast(shock.id, [{ kind: 'player', player: 'B' }]);
    const atMe = cast(shock.id, [{ kind: 'player', player: 'A' }]);

    expect(choose(view, [atMe, atThem])).toEqual(atThem);
  });

  it('credits a spell with only as much as the prior says, and a permanent with none', () => {
    const shock = card({ zone: 'hand', types: ['instant'], manaValue: 2 });
    const view = viewOf({ hand: [shock] });
    expect(prior(view, cast(shock.id, [{ kind: 'player', player: 'B' }]), w)).toBe(
      w.spellAtOpponent * 2,
    );
    expect(prior(view, cast(shock.id), w)).toBe(w.spellUntargeted * 2);

    const bear = creature(2, 2, { zone: 'hand', manaValue: 2 });
    expect(prior(viewOf({ hand: [bear] }), cast(bear.id), w)).toBe(0);
  });
});

describe('attacking (CR 508.1)', () => {
  const attack = (view: PlayerView, legal: readonly ObjectId[]) => {
    const response = decide(view, {
      kind: 'declareAttackers',
      player: 'A',
      legal,
      defenders: [{ kind: 'player', player: 'B' }],
    });
    if (response.kind !== 'declareAttackers') throw new Error('wrong response kind');
    return response.attackers.map((entry) => entry.attacker);
  };

  it('attacks with everything when nothing can block', () => {
    const a = creature(2, 2);
    const b = creature(1, 1);
    expect(attack(viewOf({ mine: [a, b] }), [a.id, b.id])).toEqual([a.id, b.id]);
  });

  it('does not send a creature into a blocker that kills it and survives', () => {
    const bear = creature(2, 2);
    const wall = creature(3, 4);
    expect(attack(viewOf({ mine: [bear], theirs: [wall] }), [bear.id])).toEqual([]);
  });

  it('ignores a blocker that is tapped, or cannot reach a flyer (CR 702.9b)', () => {
    const bird = creature(2, 2, { keywords: { flying: true } });
    const bear = creature(2, 2);
    const giant = creature(5, 5);
    const tapped = creature(5, 5, { tapped: true });

    expect(attack(viewOf({ mine: [bird], theirs: [giant] }), [bird.id])).toEqual([bird.id]);
    expect(attack(viewOf({ mine: [bear], theirs: [tapped] }), [bear.id])).toEqual([bear.id]);
  });

  it('attacks into a trade that is worth making', () => {
    const bear = creature(2, 2);
    const theirs = creature(3, 2);
    expect(attack(viewOf({ mine: [bear], theirs: [theirs] }), [bear.id])).toEqual([bear.id]);
  });

  it('does not attack with a creature that has no power to deal', () => {
    const wall = creature(0, 4);
    expect(attack(viewOf({ mine: [wall] }), [wall.id])).toEqual([]);
  });

  it('attacks the player even when a planeswalker is offered', () => {
    const bear = creature(2, 2);
    const walker = card({ types: ['planeswalker'], loyalty: 3 });
    const response = decide(viewOf({ mine: [bear], theirs: [walker] }), {
      kind: 'declareAttackers',
      player: 'A',
      legal: [bear.id],
      defenders: [
        { kind: 'object', object: walker.id },
        { kind: 'player', player: 'B' },
      ],
    });
    expect(response).toEqual({
      kind: 'declareAttackers',
      attackers: [{ attacker: bear.id, defender: { kind: 'player', player: 'B' } }],
    });
  });
});

describe('blocking (CR 509.1)', () => {
  const block = (
    view: PlayerView,
    attackers: readonly ObjectId[],
    canBlock: DeclareBlockersDecision['canBlock'],
  ) => {
    const decision: DeclareBlockersDecision = {
      kind: 'declareBlockers',
      player: 'A',
      attackers,
      available: canBlock.map((entry) => entry.blocker),
      canBlock,
    };
    const response = decide(view, decision);
    if (response.kind !== 'declareBlockers') throw new Error('wrong response kind');
    return response.blocks;
  };

  it('blocks an attacker it can kill without losing the blocker', () => {
    const attacker = creature(2, 2);
    const blocker = creature(3, 3);
    const view = viewOf({ mine: [blocker], theirs: [attacker] });
    expect(block(view, [attacker.id], [{ blocker: blocker.id, attackers: [attacker.id] }])).toEqual(
      [{ blocker: blocker.id, blocking: [attacker.id] }],
    );
  });

  it('does not throw a creature away at a healthy life total', () => {
    const attacker = creature(5, 5);
    const blocker = creature(1, 1);
    const view = viewOf({ mine: [blocker], theirs: [attacker], myLife: 20 });
    expect(block(view, [attacker.id], [{ blocker: blocker.id, attackers: [attacker.id] }])).toEqual(
      [],
    );
  });

  it('chumps when the damage getting through would be lethal', () => {
    const attacker = creature(5, 5);
    const blocker = creature(1, 1);
    const view = viewOf({ mine: [blocker], theirs: [attacker], myLife: 5 });
    expect(block(view, [attacker.id], [{ blocker: blocker.id, attackers: [attacker.id] }])).toEqual(
      [{ blocker: blocker.id, blocking: [attacker.id] }],
    );
  });

  /** One blocker on a menace creature is an illegal declaration (CR 702.110b). */
  it('never blocks a creature with menace on its own', () => {
    const attacker = creature(3, 3, { keywords: { menace: true } });
    const blocker = creature(4, 4);
    const view = viewOf({ mine: [blocker], theirs: [attacker], myLife: 3 });
    expect(block(view, [attacker.id], [{ blocker: blocker.id, attackers: [attacker.id] }])).toEqual(
      [],
    );
  });

  /**
   * The decision, not the view, says who may block whom: here the flyer is out of reach,
   * and only `canBlock` says so — the blocker has no reach and the view does not model
   * the rest (protection, "can't be blocked except by…").
   */
  it('only blocks what the decision says it may', () => {
    const attacker = creature(2, 2);
    const blocker = creature(3, 3);
    const view = viewOf({ mine: [blocker], theirs: [attacker], myLife: 1 });
    expect(block(view, [attacker.id], [{ blocker: blocker.id, attackers: [] }])).toEqual([]);
  });
});

describe('opening hands (CR 103.4)', () => {
  const mulligan = (hand: readonly ReturnType<typeof card>[], taken = 0, canMulligan = true) => {
    const view = viewOf({ hand });
    const response = decide(view, {
      kind: 'mulligan',
      player: 'A',
      hand: hand.map((c) => c.id),
      taken,
      options: canMulligan ? ['keep', 'mulligan'] : ['keep'],
    });
    if (response.kind !== 'mulligan') throw new Error('wrong response kind');
    return response.action;
  };
  const spell = (manaValue: number, colours: readonly ('G' | 'R')[] = ['G']) =>
    card({ zone: 'hand', types: ['creature'], manaValue, costColours: colours });
  const forest = () => land({ zone: 'hand' });

  it('keeps three lands and a two-drop it can cast', () => {
    expect(mulligan([forest(), forest(), forest(), spell(2), spell(3), spell(4), spell(5)])).toBe(
      'keep',
    );
  });

  it('sends back a hand with no lands, or with nothing but', () => {
    expect(mulligan([spell(1), spell(2), spell(2), spell(3), spell(3), spell(4), spell(5)])).toBe(
      'mulligan',
    );
    expect(mulligan([forest(), forest(), forest(), forest(), forest(), forest(), spell(2)])).toBe(
      'mulligan',
    );
  });

  it('sends back a hand whose early plays need a colour its lands do not make', () => {
    expect(
      mulligan([forest(), forest(), forest(), spell(2, ['R']), spell(4), spell(5), spell(6)]),
    ).toBe('mulligan');
  });

  it('keeps anything once keeping would leave five cards', () => {
    const bad = [spell(5), spell(5), spell(5), spell(5), spell(5), spell(5), spell(5)];
    expect(mulligan(bad, 2)).toBe('keep');
  });

  it('keeps when mulliganing is no longer offered', () => {
    const bad = [spell(5), spell(5), spell(5), spell(5), spell(5), spell(5), spell(5)];
    expect(mulligan(bad, 0, false)).toBe('keep');
  });
});

describe('getting rid of cards', () => {
  it('bottoms the most expensive spell from a hand short of lands', () => {
    const hand = [
      land({ zone: 'hand' }),
      land({ zone: 'hand' }),
      card({ zone: 'hand', manaValue: 2 }),
    ];
    const dragon = card({ zone: 'hand', manaValue: 7 });
    const view = viewOf({ hand: [...hand, dragon] });
    const all = [...hand, dragon].map((c) => c.id);

    expect(decide(view, { kind: 'bottomCards', player: 'A', count: 1, from: all })).toEqual({
      kind: 'bottomCards',
      cards: [dragon.id],
    });
  });

  it('discards a land once it has as many as it wants', () => {
    const inPlay = Array.from({ length: w.landTarget }, () => land());
    const spare = land({ zone: 'hand' });
    const bear = creature(2, 2, { zone: 'hand', manaValue: 2 });
    const view = viewOf({ mine: inPlay, hand: [spare, bear] });

    expect(
      decide(view, { kind: 'discard', player: 'A', count: 1, from: [spare.id, bear.id] }),
    ).toEqual({ kind: 'discard', cards: [spare.id] });
  });
});

describe('the rest of the questions', () => {
  it('orders blockers weakest first, so its damage kills as many as it can (CR 510.1c)', () => {
    const attacker = creature(4, 4);
    const big = creature(3, 3);
    const small = creature(1, 1);
    const view = viewOf({ mine: [attacker], theirs: [big, small] });

    expect(
      decide(view, {
        kind: 'orderBlockers',
        player: 'A',
        attacker: attacker.id,
        blockers: [big.id, small.id],
      }),
    ).toEqual({ kind: 'orderBlockers', order: [small.id, big.id] });
  });

  it('keeps the more valuable copy under the legend rule (CR 704.5j)', () => {
    const hurt = creature(3, 3, { damage: 2 });
    const whole = creature(3, 3);
    const view = viewOf({ mine: [hurt, whole] });

    expect(
      decide(view, {
        kind: 'chooseOption',
        player: 'A',
        reason: 'legendRule',
        options: [hurt.id, whole.id],
      }),
    ).toEqual({ kind: 'chooseOption', chosen: whole.id });
  });

  it('never draws from the generator, so it is the same player every game', () => {
    const forest = land({ zone: 'hand' });
    const view = viewOf({ hand: [forest] });
    const decision: Decision = {
      kind: 'priority',
      player: 'A',
      options: [{ kind: 'pass' }, { kind: 'playLand', object: forest.id }],
    };
    expect(greedy.decide(view, decision, scriptedRng(true))).toEqual(
      greedy.decide(view, decision, scriptedRng(false)),
    );
  });
});
