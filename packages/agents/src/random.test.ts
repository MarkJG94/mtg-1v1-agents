import { describe, expect, it } from 'vitest';
import { randomAgent } from './random.js';
import { creature, scriptedRng, viewOf } from './test-views.js';

/**
 * The view-only `random` agent. Whether its answers are legal across whole games is for
 * `@mtg/sim`'s tests, where a real engine refuses anything that is not; these pin the two
 * places it has to do more than pick from a list.
 */

describe('blocking', () => {
  /**
   * With every coin landing heads it wants to block with everything — and still only
   * blocks what the decision says each blocker may.
   */
  it('blocks only the pairings the decision offers', () => {
    const flyer = creature(2, 2, { keywords: { flying: true } });
    const bear = creature(2, 2);
    const ground = creature(2, 2);
    const view = viewOf({ mine: [ground], theirs: [flyer, bear] });

    const response = randomAgent.decide(
      view,
      {
        kind: 'declareBlockers',
        player: 'A',
        attackers: [flyer.id, bear.id],
        available: [ground.id],
        canBlock: [{ blocker: ground.id, attackers: [bear.id] }],
      },
      scriptedRng(true),
    );

    expect(response).toEqual({
      kind: 'declareBlockers',
      blocks: [{ blocker: ground.id, blocking: [bear.id] }],
    });
  });

  it('declares nothing for a blocker that can block nothing', () => {
    const flyer = creature(2, 2, { keywords: { flying: true } });
    const ground = creature(2, 2);
    const view = viewOf({ mine: [ground], theirs: [flyer] });

    const response = randomAgent.decide(
      view,
      {
        kind: 'declareBlockers',
        player: 'A',
        attackers: [flyer.id],
        available: [ground.id],
        canBlock: [{ blocker: ground.id, attackers: [] }],
      },
      scriptedRng(true),
    );

    expect(response).toEqual({ kind: 'declareBlockers', blocks: [] });
  });

  /** A lone blocker on a menace creature would be refused (CR 702.110b), so it drops it. */
  it('drops a lone block on a creature with menace', () => {
    const menace = creature(3, 3, { keywords: { menace: true } });
    const one = creature(1, 1);
    const view = viewOf({ mine: [one], theirs: [menace] });

    const response = randomAgent.decide(
      view,
      {
        kind: 'declareBlockers',
        player: 'A',
        attackers: [menace.id],
        available: [one.id],
        canBlock: [{ blocker: one.id, attackers: [menace.id] }],
      },
      scriptedRng(true),
    );

    expect(response).toEqual({ kind: 'declareBlockers', blocks: [] });
  });

  it('keeps a double block on a creature with menace', () => {
    const menace = creature(3, 3, { keywords: { menace: true } });
    const one = creature(1, 1);
    const two = creature(1, 1);
    const view = viewOf({ mine: [one, two], theirs: [menace] });

    const response = randomAgent.decide(
      view,
      {
        kind: 'declareBlockers',
        player: 'A',
        attackers: [menace.id],
        available: [one.id, two.id],
        canBlock: [
          { blocker: one.id, attackers: [menace.id] },
          { blocker: two.id, attackers: [menace.id] },
        ],
      },
      scriptedRng(true),
    );

    expect(response).toEqual({
      kind: 'declareBlockers',
      blocks: [
        { blocker: one.id, blocking: [menace.id] },
        { blocker: two.id, blocking: [menace.id] },
      ],
    });
  });
});

describe('attacking', () => {
  it('attacks with what the coin says, at a defender the decision offers', () => {
    const bear = creature(2, 2);
    const view = viewOf({ mine: [bear] });
    const decision = {
      kind: 'declareAttackers' as const,
      player: 'A' as const,
      legal: [bear.id],
      defenders: [{ kind: 'player' as const, player: 'B' as const }],
    };

    expect(randomAgent.decide(view, decision, scriptedRng(true))).toEqual({
      kind: 'declareAttackers',
      attackers: [{ attacker: bear.id, defender: { kind: 'player', player: 'B' } }],
    });
    expect(randomAgent.decide(view, decision, scriptedRng(false))).toEqual({
      kind: 'declareAttackers',
      attackers: [],
    });
  });
});
