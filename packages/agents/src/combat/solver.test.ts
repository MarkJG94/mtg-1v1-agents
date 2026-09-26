import type {
  DeclareAttackersDecision,
  DeclareBlockersDecision,
  PlayerView,
} from '@mtg/engine/view';
import type { ObjectId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { greedyAgent } from '../greedy.js';
import { creature, noSimulator, scriptedRng, viewOf } from '../test-views.js';
import { defaultWeights as w } from '../weights.js';
import { chooseBlocks, solveAttacks } from './solver.js';

/**
 * The combat solver (roadmap 4.4). Each case is a combat whose right answer is not in
 * doubt, including the ones greedy's rules of thumb get wrong — a gang block, and an
 * attack that leaves nothing home against a lethal counter-attack.
 */

type Creature = ReturnType<typeof creature>;

/** A blocks B's attackers; `reach` limits who may block whom, as the decision would. */
const blocks = (
  mine: readonly Creature[],
  attackers: readonly Creature[],
  options: { myLife?: number; cannot?: readonly (readonly [Creature, Creature])[] } = {},
) => {
  const view = {
    ...viewOf({ mine, theirs: attackers, myLife: options.myLife ?? 20 }),
    activePlayer: 'B' as const,
  };
  const forbidden = new Set((options.cannot ?? []).map(([b, a]) => `${b.id}:${a.id}`));
  const decision: DeclareBlockersDecision = {
    kind: 'declareBlockers',
    player: 'A',
    attackers: attackers.map((a) => a.id),
    available: mine.map((b) => b.id),
    canBlock: mine.map((b) => ({
      blocker: b.id,
      attackers: attackers.filter((a) => !forbidden.has(`${b.id}:${a.id}`)).map((a) => a.id),
    })),
  };
  return chooseBlocks(view, decision, w)
    .map((block) => [block.blocker, block.blocking[0]])
    .sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0));
};

const attackDecision = (legal: readonly Creature[]): DeclareAttackersDecision => ({
  kind: 'declareAttackers',
  player: 'A',
  legal: legal.map((c) => c.id),
  defenders: [{ kind: 'player', player: 'B' }],
});

const attacks = (view: PlayerView, legal: readonly Creature[]): readonly ObjectId[] =>
  solveAttacks(view, attackDecision(legal), w)[0]?.attackers ?? [];

describe('blocking (CR 509.1)', () => {
  it('blocks an attacker it can kill without losing the blocker', () => {
    const attacker = creature(2, 2);
    const wall = creature(3, 3);
    expect(blocks([wall], [attacker])).toEqual([[wall.id, attacker.id]]);
  });

  it('does not chump at a healthy life total', () => {
    expect(blocks([creature(1, 1)], [creature(5, 5)])).toEqual([]);
  });

  it('chumps when the damage getting through would be lethal', () => {
    const chump = creature(1, 1);
    const attacker = creature(5, 5);
    expect(blocks([chump], [attacker], { myLife: 5 })).toEqual([[chump.id, attacker.id]]);
  });

  /**
   * Neither 3/3 can block the 4/4 alone without dying for nothing; together they kill it
   * and lose one. Greedy only ever blocks one-for-one, so it lets the 4/4 through.
   */
  it('gang-blocks a big attacker that no single blocker can kill', () => {
    const a = creature(3, 3);
    const b = creature(3, 3);
    const big = creature(4, 4);
    expect(blocks([a, b], [big])).toEqual([
      [a.id, big.id],
      [b.id, big.id],
    ]);
  });

  it('never blocks a creature with menace alone (CR 702.110b), but will with two', () => {
    const menace = creature(3, 3, { keywords: { menace: true } });
    expect(blocks([creature(4, 4)], [menace], { myLife: 3 })).toEqual([]);

    const a = creature(2, 2);
    const b = creature(2, 2);
    expect(blocks([a, b], [menace])).toEqual([
      [a.id, menace.id],
      [b.id, menace.id],
    ]);
  });

  it('only blocks what the decision says it may', () => {
    const wall = creature(3, 3);
    const attacker = creature(2, 2);
    expect(blocks([wall], [attacker], { cannot: [[wall, attacker]] })).toEqual([]);
  });

  it('puts each blocker on the attacker it does most against', () => {
    const wall = creature(0, 5);
    const killer = creature(3, 3);
    const small = creature(2, 2);
    const big = creature(4, 4);
    // The 3/3 kills the 2/2 and survives; the wall holds the 4/4 up for free.
    expect(blocks([wall, killer], [small, big])).toEqual([
      [wall.id, big.id],
      [killer.id, small.id],
    ]);
  });
});

describe('attacking (CR 508.1)', () => {
  it('attacks with everything when nothing can block', () => {
    const a = creature(2, 2);
    const b = creature(3, 1);
    expect(attacks(viewOf({ mine: [a, b] }), [a, b])).toEqual([a.id, b.id]);
  });

  it('does not attack into a blocker that kills it for free', () => {
    const bear = creature(2, 2);
    expect(attacks(viewOf({ mine: [bear], theirs: [creature(4, 4)] }), [bear])).toEqual([]);
  });

  it('attacks with everything when the damage that gets through is lethal', () => {
    const team = [creature(3, 3), creature(3, 3), creature(3, 3)];
    const view = viewOf({ mine: team, theirs: [creature(4, 4)], theirLife: 6 });
    expect(attacks(view, team)).toEqual(team.map((c) => c.id));
  });

  /**
   * A 1/1 could attack freely — their only creature is tapped. But it is also the only
   * thing that can block their 5/5 next turn, and five damage is lethal. Greedy attacks;
   * the solver sees the board it would leave (roadmap 4.4's threat term) and stays home.
   */
  it('keeps home the blocker that stops a lethal counter-attack', () => {
    const guard = creature(1, 1);
    const view = viewOf({
      mine: [guard],
      theirs: [creature(5, 5, { tapped: true })],
      myLife: 5,
    });
    expect(attacks(view, [guard])).toEqual([]);

    const greedy = greedyAgent().decide(view, attackDecision([guard]), scriptedRng(), noSimulator);
    expect(greedy).toMatchObject({ attackers: [{ attacker: guard.id }] });
  });

  it('attacks anyway with vigilance, which leaves the blocker home (CR 702.20b)', () => {
    const guard = creature(1, 1, { keywords: { vigilance: true } });
    const view = viewOf({
      mine: [guard],
      theirs: [creature(5, 5, { tapped: true })],
      myLife: 5,
    });
    expect(attacks(view, [guard])).toEqual([guard.id]);
  });

  /** The defender cannot block a menace creature with one blocker (CR 702.110b). */
  it('attacks with menace past a lone blocker that could otherwise kill it', () => {
    const menace = creature(3, 3, { keywords: { menace: true } });
    expect(attacks(viewOf({ mine: [menace], theirs: [creature(4, 4)] }), [menace])).toEqual([
      menace.id,
    ]);
  });

  it('attacks with a flyer over a ground blocker that could otherwise kill it', () => {
    const flyer = creature(2, 2, { keywords: { flying: true } });
    expect(attacks(viewOf({ mine: [flyer], theirs: [creature(4, 4)] }), [flyer])).toEqual([
      flyer.id,
    ]);
  });

  /** Neither everything nor nothing: the flyers go, the ground creatures stay out of the way. */
  it('sends the creatures that are worth sending and keeps the rest back', () => {
    const flyers = [
      creature(2, 2, { keywords: { flying: true } }),
      creature(2, 2, { keywords: { flying: true } }),
    ];
    const bears = [creature(2, 2), creature(2, 2)];
    const view = viewOf({ mine: [...flyers, ...bears], theirs: [creature(4, 4)] });
    expect(attacks(view, [...flyers, ...bears])).toEqual(flyers.map((c) => c.id));
  });

  /**
   * Any one of three 2/2s can attack into a tapped board; all three leave nothing to
   * block the 5/5 that is lethal next turn. The answer is everything but one.
   */
  it('attacks with all but the one creature that must stay home', () => {
    const team = [creature(2, 2), creature(2, 2), creature(2, 2)];
    const view = viewOf({ mine: team, theirs: [creature(5, 5, { tapped: true })], myLife: 5 });
    expect(attacks(view, team)).toHaveLength(2);
  });

  it('says which blocks it expects the defender to answer with', () => {
    const bear = creature(2, 2);
    const flyer = creature(2, 2, { keywords: { flying: true } });
    const wall = creature(0, 4);
    const [best] = solveAttacks(
      viewOf({ mine: [bear, flyer], theirs: [wall] }),
      attackDecision([bear, flyer]),
      w,
    );
    // The wall cannot reach the flyer, so if anything it blocks the bear.
    expect(best?.attackers).toContain(flyer.id);
    for (const [attacker, blockers] of best?.blocks ?? []) {
      expect(attacker).not.toBe(flyer.id);
      expect(blockers).toEqual([wall.id]);
    }
  });
});
