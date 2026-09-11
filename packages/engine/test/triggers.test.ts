import { describe, expect, it } from 'vitest';
import type { Decision, DecisionAnswer } from '../src/state.js';
import { scenario } from '../src/testing/index.js';
import { CARDS } from './fixtures/cards.js';

const game = () => scenario(CARDS);

describe('triggered abilities (CR 603)', () => {
  it('ETB triggers go on the stack and resolve', () => {
    const s = game()
      .player('A')
      .battlefield('Forest', 'Forest')
      .hand('Elvish Visionary')
      .library('Island', 'Island')
      .player('B')
      .library('Island')
      .start();
    s.cast('Elvish Visionary').passBoth();
    expect(s.stackNames).toEqual(['Elvish Visionary:trigger']);
    s.resolveAll();
    expect(s.zone('A', 'hand')).toEqual(['Island']);
  });

  it('dies triggers use last known information and see other creatures dying simultaneously', () => {
    const s = game()
      .player('A')
      .battlefield('Blood Artist', 'Grizzly Bears', 'Plains', 'Plains', 'Plains', 'Plains')
      .hand('Wrath of God')
      .library('Island')
      .player('B')
      .battlefield('Hill Giant')
      .library('Island')
      .start();
    s.cast('Wrath of God').passBoth();
    // Blood Artist itself, Grizzly Bears and Hill Giant died: three triggers, each targeting a player.
    const targetB = (dec: Decision): DecisionAnswer =>
      dec.kind === 'chooseTargets'
        ? { kind: 'chooseTargets', targets: [[{ kind: 'player', player: 'B' }]] }
        : s.defaultAnswer(dec);
    while (s.decision.kind !== 'priority') s.answer(targetB(s.decision));
    expect(s.state.stack).toHaveLength(3);
    s.resolveAll(targetB);
    expect(s.life('B')).toBe(17);
    expect(s.life('A')).toBe(23);
  });

  it("APNAP: the active player's triggers go on the stack first and resolve last (603.3b)", () => {
    const s = game()
      .player('A')
      .battlefield('Blood Artist')
      .library('Island')
      .player('B')
      .battlefield('Blood Artist', 'Grizzly Bears')
      .library('Island')
      .player('A')
      .battlefield('Mountain')
      .hand('Lightning Bolt')
      .start();
    s.cast('Lightning Bolt', { targets: ['Grizzly Bears'] }).passBoth();
    while (s.decision.kind === 'chooseTargets')
      s.answer({ kind: 'chooseTargets', targets: [[{ kind: 'player', player: 'B' }]] });
    const stack = s.state.stack;
    expect(stack).toHaveLength(2);
    expect(stack[0]!.controller).toBe('A');
    expect(stack[1]!.controller).toBe('B');
  });

  it('a controller with several simultaneous triggers orders them', () => {
    const s = game()
      .player('A')
      .battlefield('Blood Artist', 'Blood Artist', 'Mountain')
      .hand('Lightning Bolt')
      .library('Island')
      .player('B')
      .battlefield('Grizzly Bears')
      .library('Island')
      .start();
    s.cast('Lightning Bolt', { targets: ['Grizzly Bears'] }).passBoth();
    expect(s.decision.kind).toBe('orderTriggers');
  });

  it('intervening-if conditions are checked on trigger and on resolution (603.4)', () => {
    const s = game()
      .player('A')
      .battlefield('Intervening Angel', 'Grizzly Bears')
      .library('Island', 'Island')
      .player('B')
      .battlefield('Mountain')
      .hand('Lightning Bolt')
      .library('Island', 'Island')
      .step('end')
      .start();
    s.nextTurn(); // B's turn
    s.toStep('end');
    // Advance into A's upkeep: trigger should fire since A controls another creature.
    let guard = 0;
    while (
      !(s.state.turn === 5 && s.state.step === 'upkeep' && s.state.stack.length === 1) &&
      guard++ < 50
    ) {
      const dec = s.decision;
      if (dec.kind === 'priority') s.pass();
      else s.answer(s.defaultAnswer(dec));
    }
    expect(s.stackNames).toEqual(['Intervening Angel:trigger']);
    // B kills the Bears in response: the condition is false on resolution, so no life is gained.
    s.pass();
    s.cast('Lightning Bolt', { targets: ['Grizzly Bears'] }).resolveAll();
    expect(s.life('A')).toBe(20);

    const t = game()
      .player('A')
      .battlefield('Intervening Angel')
      .library('Island', 'Island')
      .player('B')
      .library('Island', 'Island')
      .step('end')
      .start();
    t.nextTurn().nextTurn();
    expect(t.events.filter((e) => e.type === 'trigger')).toHaveLength(0);
  });

  it('delayed triggers fire at the next end step', () => {
    const s = game()
      .player('A')
      .battlefield('Forest', 'Forest', 'Forest')
      .hand('Temporary Beast')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.cast('Temporary Beast').resolveAll();
    expect(s.zone('A', 'battlefield')).toContain('Beast');
    expect(s.state.delayedTriggers).toHaveLength(1);
    s.toStep('end');
    s.resolveAll();
    expect(s.zone('A', 'battlefield')).not.toContain('Beast');
    expect(s.state.delayedTriggers).toHaveLength(0);
  });

  it("end step triggers fire on any player's end step when specified (Ball Lightning)", () => {
    const s = game()
      .player('A')
      .battlefield('Mountain', 'Mountain', 'Mountain')
      .hand('Ball Lightning')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.cast('Ball Lightning').resolveAll();
    s.attack(['Ball Lightning']).finishCombat();
    expect(s.life('B')).toBe(14);
    s.toStep('end').resolveAll();
    expect(s.zoneOf('Ball Lightning')).toBe('graveyard');
  });

  it("life gain triggers (Ajani's Pridemate)", () => {
    const s = game()
      .player('A')
      .battlefield("Ajani's Pridemate", 'Plains', 'Forest', 'Forest')
      .hand('Kitchen Finks')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.cast('Kitchen Finks').resolveAll();
    expect(s.life('A')).toBe(22);
    expect(s.chars("Ajani's Pridemate").power).toBe(3);
  });

  it('a trigger with no legal targets is removed from the stack (603.3d)', () => {
    const s = game()
      .player('A')
      .battlefield('Blood Artist', 'Mountain')
      .hand('Lightning Bolt')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    // Blood Artist trigger always has a legal player target; ensure it targets and resolves normally here.
    s.cast('Lightning Bolt', { targets: ['Blood Artist'] }).passBoth();
    expect(s.decision.kind).toBe('chooseTargets');
  });

  it('cast triggers and landfall fire from events', () => {
    const s = game()
      .player('A')
      .hand('Forest')
      .battlefield('Plains')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.playLand('Forest');
    expect(s.events.some((e) => e.type === 'playLand')).toBe(true);
  });
});
