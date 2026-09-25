import { describe, expect, it } from 'vitest';
import { creatureValue, evaluate, evaluateTerms } from './evaluate.js';
import { card, creature, land, viewOf } from './test-views.js';
import { defaultWeights as w } from './weights.js';

/**
 * The static evaluator (docs/04). Each test pins one term by building two positions that
 * differ only in what that term is about, so a term that stopped doing its job fails the
 * test named for it rather than disappearing into a total.
 */

describe('a position is scored from the viewer’s side', () => {
  it('scores a mirror-image position as even', () => {
    const view = viewOf({
      mine: [creature(2, 2), land()],
      theirs: [creature(2, 2), land()],
      theirHandSize: 0,
    });
    const { terms } = evaluateTerms(view, w);
    expect(terms.life).toBe(0);
    expect(terms.board).toBe(0);
    expect(terms.cards).toBe(0);
  });

  it('prefers more of everything on the viewer’s side', () => {
    const even = viewOf({ mine: [creature(2, 2)], theirs: [creature(2, 2)] });
    const ahead = viewOf({ mine: [creature(2, 2), creature(3, 3)], theirs: [creature(2, 2)] });
    expect(evaluate(ahead, w)).toBeGreaterThan(evaluate(even, w));
  });

  it('counts a won game above anything on the board, and a lost one below', () => {
    const won = viewOf({ result: { winner: 'A', reason: 'life', turn: 5 } });
    const lost = viewOf({
      result: { winner: 'B', reason: 'life', turn: 5 },
      mine: [creature(9, 9)],
    });
    expect(evaluate(won, w)).toBeGreaterThan(evaluate(viewOf({ mine: [creature(9, 9)] }), w));
    expect(evaluate(lost, w)).toBeLessThan(0);
  });
});

describe('life (CR 119)', () => {
  /** Three points at 20 are not the same three points at 5. */
  it('values life more the less of it there is', () => {
    const fromHigh = evaluate(viewOf({ myLife: 20 }), w) - evaluate(viewOf({ myLife: 17 }), w);
    const fromLow = evaluate(viewOf({ myLife: 5 }), w) - evaluate(viewOf({ myLife: 2 }), w);
    expect(fromLow).toBeGreaterThan(fromHigh);
  });
});

describe('the board', () => {
  it('discounts a creature that cannot attack yet (CR 302.6)', () => {
    expect(creatureValue(creature(3, 3, { sick: true }), w)).toBeLessThan(
      creatureValue(creature(3, 3), w),
    );
  });

  it('does not discount a sick creature with haste', () => {
    expect(creatureValue(creature(3, 3, { sick: true, keywords: { haste: true } }), w)).toBe(
      creatureValue(creature(3, 3), w),
    );
  });

  it('values power that is hard to block above the same power on the ground', () => {
    expect(creatureValue(creature(3, 3, { keywords: { flying: true } }), w)).toBeGreaterThan(
      creatureValue(creature(3, 3), w),
    );
  });

  it('values a damaged creature by the toughness it has left', () => {
    expect(creatureValue(creature(3, 3, { damage: 2 }), w)).toBeLessThan(
      creatureValue(creature(3, 3), w),
    );
  });

  it('counts a planeswalker by its loyalty', () => {
    const low = viewOf({ mine: [card({ types: ['planeswalker'], loyalty: 2 })] });
    const high = viewOf({ mine: [card({ types: ['planeswalker'], loyalty: 5 })] });
    expect(evaluate(high, w)).toBeGreaterThan(evaluate(low, w));
  });
});

describe('cards and mana', () => {
  it('counts cards in the opponent’s hand against the viewer, though it cannot see them', () => {
    expect(evaluate(viewOf({ theirHandSize: 5 }), w)).toBeLessThan(
      evaluate(viewOf({ theirHandSize: 1 }), w),
    );
  });

  /**
   * Past the land target a land in hand is a spare, not a card. Scored as a card it was
   * worth more in hand than on the battlefield, and so was never played.
   */
  it('values a spare land in hand below the same land in play', () => {
    const inPlay = Array.from({ length: w.landTarget }, () => land());
    const spare = land({ zone: 'hand' });
    const held = viewOf({ mine: inPlay, hand: [spare] });
    const played = viewOf({ mine: [...inPlay, { ...spare, zone: 'battlefield' }] });
    expect(evaluate(played, w)).toBeGreaterThan(evaluate(held, w));
  });

  it('still counts a land it needs as a whole card', () => {
    const needed = viewOf({ mine: [land()], hand: [land({ zone: 'hand' })] });
    const nothing = viewOf({ mine: [land()] });
    expect(evaluateTerms(needed, w).terms.cards - evaluateTerms(nothing, w).terms.cards).toBe(
      w.cardInHand,
    );
  });

  /** The next draw from an empty library loses the game (CR 704.5b). */
  it('fears an empty library', () => {
    expect(evaluate(viewOf({ myLibrary: 0 }), w)).toBeLessThan(
      evaluate(viewOf({ myLibrary: 1 }), w) - 10,
    );
  });

  it('values lands up to a target and little beyond it', () => {
    const lands = (n: number) => viewOf({ mine: Array.from({ length: n }, () => land()) });
    const early = evaluate(lands(3), w) - evaluate(lands(2), w);
    const late = evaluate(lands(w.landTarget + 2), w) - evaluate(lands(w.landTarget + 1), w);
    expect(early).toBeGreaterThan(late);
  });

  it('charges the viewer for a colour its hand needs and its lands cannot make', () => {
    const blueCard = card({ zone: 'hand', costColours: ['U'], manaValue: 2 });
    const greenLands = viewOf({ mine: [land({ producesMana: ['G'] })], hand: [blueCard] });
    const blueLands = viewOf({ mine: [land({ producesMana: ['U'] })], hand: [{ ...blueCard }] });
    expect(evaluateTerms(greenLands, w).terms.mana).toBeLessThan(
      evaluateTerms(blueLands, w).terms.mana,
    );
  });

  /**
   * The opponent's hand cannot be read, so they are never charged for colours — least of
   * all for the colours the *viewer's* hand needs, which is what charging both sides the
   * same way would do.
   */
  it('never charges the opponent for colours, since their hand cannot be seen', () => {
    const blueCard = card({ zone: 'hand', costColours: ['U'], manaValue: 2 });
    const view = viewOf({
      mine: [land({ producesMana: ['U'] })],
      theirs: [land({ producesMana: ['G'] })],
      hand: [blueCard],
    });
    expect(evaluateTerms(view, w).terms.mana).toBe(0);
  });
});

describe('threats', () => {
  it('fears a board that is already lethal next turn', () => {
    const safe = viewOf({ theirs: [creature(4, 4)], myLife: 5 });
    const dead = viewOf({ theirs: [creature(4, 4), creature(2, 2)], myLife: 5 });
    expect(evaluateTerms(dead, w).terms.threats).toBe(-w.lethalOnBoard);
    expect(evaluateTerms(safe, w).terms.threats).toBe(0);
  });

  /** A creature left at home stops the biggest attacker it can reach (roadmap 4.4). */
  it('counts the blockers that will be there to meet the attack', () => {
    const guarded = viewOf({
      mine: [creature(1, 1)],
      theirs: [creature(4, 4), creature(2, 2)],
      myLife: 5,
    });
    expect(evaluateTerms(guarded, w).terms.threats).toBe(0);
  });

  /**
   * Tapped creatures stay tapped until their controller's next untap step (CR 502.3), so
   * on the viewer's own turn a creature that attacked is no blocker against the reply.
   */
  it('does not count a tapped blocker on the viewer’s own turn', () => {
    const open = viewOf({
      mine: [creature(1, 1, { tapped: true })],
      theirs: [creature(4, 4), creature(2, 2)],
      myLife: 5,
    });
    expect(evaluateTerms(open, w).terms.threats).toBe(-w.lethalOnBoard);
  });

  it('lets a flyer past a blocker that cannot reach it (CR 702.9b)', () => {
    const view = viewOf({
      mine: [creature(1, 1)],
      theirs: [creature(5, 5, { keywords: { flying: true } })],
      myLife: 5,
    });
    expect(evaluateTerms(view, w).terms.threats).toBe(-w.lethalOnBoard);
  });

  /** This turn's attack uses what can attack now; next turn's, everything (CR 302.6). */
  it('does not count a summoning-sick creature toward an attack still to come this turn', () => {
    const sick = creature(6, 6, { sick: true });
    expect(evaluateTerms(viewOf({ mine: [sick], theirLife: 5 }), w).terms.threats).toBe(0);
    expect(
      evaluateTerms(viewOf({ mine: [{ ...sick }], theirLife: 5, step: 'end' }), w).terms.threats,
    ).toBe(w.lethalOnBoard);
  });

  it('does not count a creature with defender as a threat (CR 702.3)', () => {
    const wall = viewOf({ theirs: [creature(9, 9, { keywords: { defender: true } })], myLife: 5 });
    expect(evaluateTerms(wall, w).terms.threats).toBe(0);
  });
});

describe('tempo', () => {
  it('values untapped mana held with an instant in hand', () => {
    const instant = card({ zone: 'hand', types: ['instant'], manaValue: 1 });
    const open = viewOf({ mine: [land()], hand: [instant] });
    const tapped = viewOf({ mine: [land({ tapped: true })], hand: [{ ...instant }] });
    expect(evaluateTerms(open, w).terms.tempo).toBeGreaterThan(
      evaluateTerms(tapped, w).terms.tempo,
    );
  });

  it('scores nothing for untapped mana with no instant to spend it on', () => {
    const sorcery = card({ zone: 'hand', types: ['sorcery'], manaValue: 1 });
    expect(evaluateTerms(viewOf({ mine: [land(), land()], hand: [sorcery] }), w).terms.tempo).toBe(
      0,
    );
  });
});
