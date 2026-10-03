import type { BottomCardsDecision, MulliganDecision } from '@mtg/engine/view';
import { describe, expect, it } from 'vitest';
import { greedyAgent } from './greedy.js';
import { bottomCards, mulliganChoice, playOrDraw, projectOpening } from './opening.js';
import { card, creature, land, noSimulator, scriptedRng, viewOf } from './test-views.js';
import { defaultWeights as w } from './weights.js';

/**
 * The start of a game (roadmap 4.5): who plays first, which hands to keep, and which
 * cards a kept mulligan puts on the bottom — docs/04 items 5 and 6.
 */

type Card = ReturnType<typeof card>;

const forest = (): Card => land({ zone: 'hand', producesMana: ['G'] });
const mountain = (): Card => land({ zone: 'hand', producesMana: ['R'] });
const bear = (manaValue = 2, colours: readonly ('G' | 'R')[] = ['G']): Card =>
  creature(2, 2, { zone: 'hand', manaValue, costColours: colours });
const trinket = (manaValue: number): Card => card({ zone: 'hand', types: ['artifact'], manaValue });

describe('play or draw (CR 103.1, docs/04 item 6)', () => {
  const record = (play: [number, number], draw: [number, number]) => ({
    play: { games: play[0], wins: play[1] },
    draw: { games: draw[0], wins: draw[1] },
  });

  it('plays when it knows nothing', () => {
    expect(playOrDraw()).toBe('play');
  });

  it('draws when the record says drawing wins clearly more', () => {
    expect(playOrDraw(record([40, 15], [40, 30]))).toBe('draw');
  });

  /** Twenty-one wins against nineteen is not evidence of anything. */
  it('still plays when the draw is ahead by no more than luck', () => {
    expect(playOrDraw(record([40, 19], [40, 21]))).toBe('play');
  });

  it('trusts no record with too few games on either side', () => {
    expect(playOrDraw(record([5, 0], [5, 5]))).toBe('play');
  });

  it('plays when there is no spread to test against', () => {
    expect(playOrDraw(record([30, 30], [30, 30]))).toBe('play');
  });

  it('is what greedy answers, and it answers from its knowledge', () => {
    const decision = { kind: 'playOrDraw', player: 'A', options: ['play', 'draw'] } as const;
    const ask = (agent: ReturnType<typeof greedyAgent>) =>
      agent.decide(viewOf(), decision, scriptedRng(), noSimulator);
    expect(ask(greedyAgent())).toEqual({ kind: 'playOrDraw', choice: 'play' });
    expect(ask(greedyAgent(w, { playDraw: record([40, 15], [40, 30]) }))).toEqual({
      kind: 'playOrDraw',
      choice: 'draw',
    });
  });
});

describe('the projected turn-3 board (docs/04 item 5)', () => {
  it('casts on curve: a two-drop on turn two, a three-drop on turn three', () => {
    const two = bear(2);
    const three = bear(3);
    const projection = projectOpening([forest(), forest(), forest(), two, three], w);
    expect(projection.lands).toBe(3);
    expect(projection.cast).toEqual([two, three]);
  });

  it('casts only what the lands in play can pay for (CR 305.2: a land a turn)', () => {
    const projection = projectOpening([forest(), bear(1), bear(2), bear(3)], w);
    expect(projection.lands).toBe(1);
    expect(projection.cast.map((c) => c.manaValue)).toEqual([1]);
  });

  /** Each turn it casts the most mana's worth it can, not the first things that fit. */
  it('spends its whole turn three on the three-drop rather than a leftover two-drop', () => {
    const [a, b, three] = [bear(2), bear(2), bear(3)];
    const projection = projectOpening([forest(), forest(), forest(), a, b, three], w);
    expect(projection.cast).toContain(three);
  });

  it('never casts a spell in a colour its lands cannot make', () => {
    const red = bear(1, ['R']);
    expect(projectOpening([forest(), forest(), forest(), red], w).cast).toEqual([]);
  });

  it('plays the land that makes the colour its spells need first', () => {
    const red = bear(1, ['R']);
    const projection = projectOpening([forest(), mountain(), red], w, 1);
    expect(projection.cast).toEqual([red]);
  });

  it('prices the board on the evaluator’s own scale', () => {
    const projection = projectOpening([forest(), forest(), bear(2)], w);
    expect(projection.board).toBe(w.creaturePower * 2 + w.creatureToughness * 2);
  });
});

describe('keeping (CR 103.4, docs/04 item 5)', () => {
  const decide = (hand: readonly Card[], taken = 0) => {
    const decision: MulliganDecision = {
      kind: 'mulligan',
      player: 'A',
      hand: hand.map((c) => c.id),
      taken,
      options: ['keep', 'mulligan'],
    };
    return mulliganChoice(viewOf({ hand }), decision, w);
  };

  it('keeps lands and a curve', () => {
    expect(decide([forest(), forest(), forest(), bear(2), bear(3), bear(4), bear(5)])).toBe('keep');
  });

  /**
   * Three lands and a two-drop pass the old rules; but the two-drop is a trinket, and
   * nothing else is castable before turn five. The first three turns do almost nothing.
   */
  it('sends back a hand whose first three turns would do too little', () => {
    expect(decide([forest(), forest(), forest(), trinket(2), bear(5), bear(6), bear(7)])).toBe(
      'mulligan',
    );
  });

  /** A smaller hand is held to its share of the threshold, so the same board can do. */
  it('holds a smaller hand to less', () => {
    // A 1/1 lifelinker (1.8) and a one-mana trinket (0.5): 2.3, between the six-card
    // threshold (2.14) and the seven-card one (2.5).
    const two = creature(1, 1, {
      zone: 'hand',
      manaValue: 2,
      costColours: ['G'],
      keywords: { lifelink: true },
    });
    const hand = [forest(), forest(), forest(), two, trinket(1), bear(6), bear(7)];
    const board = projectOpening(hand, w).board;
    expect(board).toBeLessThan(w.keepBoard);
    expect(board).toBeGreaterThanOrEqual(w.keepBoard * (6 / 7));
    expect(decide(hand)).toBe('mulligan');
    expect(decide(hand, 1)).toBe('keep');
  });
});

describe('bottoming (CR 103.4b, docs/04 item 5)', () => {
  const bottom = (hand: readonly Card[], count: number) => {
    const decision: BottomCardsDecision = {
      kind: 'bottomCards',
      player: 'A',
      count,
      from: hand.map((c) => c.id),
    };
    return bottomCards(viewOf({ hand }), decision, w);
  };

  it('keeps the curve and bottoms what it cannot cast', () => {
    const lands = [forest(), forest(), forest(), forest()];
    const one = bear(1);
    const two = bear(2);
    const seven = bear(7);
    const bottomed = bottom([...lands, one, two, seven], 2);
    expect(bottomed).toHaveLength(2);
    expect(bottomed).toContain(seven.id);
    expect(bottomed).not.toContain(one.id);
    expect(bottomed).not.toContain(two.id);
  });

  it('keeps its lands when it is short of them, and bottoms spells instead', () => {
    const lands = [forest(), forest()];
    const spells = [bear(1), bear(1), bear(1), bear(1), bear(1)];
    const bottomed = bottom([...lands, ...spells], 2);
    for (const l of lands) expect(bottomed).not.toContain(l.id);
  });

  /** Five lands and a seven-drop: the seven might yet be cast; a fifth land is a spare. */
  it('bottoms a spare land before a spell it might yet cast', () => {
    const lands = [forest(), forest(), forest(), forest(), forest()];
    const seven = bear(7);
    const bottomed = bottom([...lands, bear(1), seven], 1);
    expect(bottomed).not.toContain(seven.id);
    expect(lands.map((l) => l.id)).toContain(bottomed[0]);
  });

  it('bottoms exactly as many as it owes', () => {
    const hand = [forest(), forest(), forest(), bear(2), bear(3), bear(4), bear(5)];
    for (const count of [1, 2, 3]) expect(bottom(hand, count)).toHaveLength(count);
  });
});
