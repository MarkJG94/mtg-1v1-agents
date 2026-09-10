import { describe, expect, it } from 'vitest';
import { scenario } from '../src/testing/index.js';
import { CARDS } from './fixtures/cards.js';

const game = () => scenario(CARDS);

describe('priority and the stack (CR 117, 405, 608)', () => {
  it('gives priority back to the caster after casting, then to the opponent on pass', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain')
      .hand('Lightning Bolt')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.cast('Lightning Bolt', { targets: ['B'] });
    expect(s.decision.kind).toBe('priority');
    expect(s.decision.kind === 'priority' && s.decision.player).toBe('A');
    expect(s.stackNames).toEqual(['Lightning Bolt']);
    s.pass();
    expect(s.decision.kind === 'priority' && s.decision.player).toBe('B');
    s.pass();
    expect(s.stackNames).toEqual([]);
    expect(s.life('B')).toBe(17);
    expect(s.zoneOf('Lightning Bolt')).toBe('graveyard');
    expect(s.decision.kind === 'priority' && s.decision.player).toBe('A');
  });

  it('resolves the stack last-in first-out and lets the opponent respond', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain', 'Grizzly Bears')
      .hand('Lightning Bolt')
      .library('Island')
      .player('B')
      .battlefield('Forest')
      .hand('Giant Growth')
      .library('Island')
      .start();
    s.cast('Lightning Bolt', { targets: ['Grizzly Bears'] }).pass();
    s.cast('Giant Growth', { targets: ['Grizzly Bears'] });
    expect(s.stackNames).toEqual(['Lightning Bolt', 'Giant Growth']);
    s.resolveAll();
    expect(s.zoneOf('Grizzly Bears')).toBe('battlefield');
    expect(s.object('Grizzly Bears').damage).toBe(3);
    expect(s.chars('Grizzly Bears').toughness).toBe(5);
  });

  it('counters a spell (CR 701.5)', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain')
      .hand('Lightning Bolt')
      .library('Island')
      .player('B')
      .battlefield('Island', 'Island')
      .hand('Counterspell')
      .library('Island')
      .start();
    s.cast('Lightning Bolt', { targets: ['B'] }).pass();
    s.cast('Counterspell', { targets: ['spell:Lightning Bolt'] }).resolveAll();
    expect(s.life('B')).toBe(20);
    expect(s.zoneOf('Lightning Bolt')).toBe('graveyard');
    expect(s.zoneOf('Counterspell')).toBe('graveyard');
  });

  it('a spell whose only target became illegal fizzles (CR 608.2b)', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain', 'Mountain')
      .hand('Lightning Bolt', 'Shock')
      .library('Island')
      .player('B')
      .battlefield('Grizzly Bears')
      .library('Island')
      .start();
    s.cast('Shock', { targets: ['Grizzly Bears'] })
      .pass()
      .pass();
    // Respond to nothing: Shock resolves first? No — cast Bolt on top instead:
    const t = game()
      .player('A')
      .battlefield('Mountain', 'Mountain')
      .hand('Lightning Bolt', 'Shock')
      .library('Island')
      .player('B')
      .battlefield('Grizzly Bears')
      .library('Island')
      .start();
    t.cast('Shock', { targets: ['Grizzly Bears'] });
    t.cast('Lightning Bolt', { targets: ['Grizzly Bears'] });
    t.passBoth();
    expect(t.zoneOf('Grizzly Bears')).toBe('graveyard');
    t.passBoth();
    expect(t.events.some((e) => e.type === 'fizzle')).toBe(true);
    expect(t.zoneOf('Shock')).toBe('graveyard');
    void s;
  });

  it('split second forbids casting spells while it is on the stack (CR 702.61)', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain', 'Mountain')
      .hand('Sudden Shock')
      .library('Island')
      .player('B')
      .battlefield('Island', 'Island')
      .hand('Counterspell')
      .library('Island')
      .start();
    s.cast('Sudden Shock', { targets: ['B'] }).pass();
    const actions = s.decision.kind === 'priority' ? s.decision.actions : [];
    expect(actions.map((a) => a.kind)).toEqual(['pass', 'activateMana', 'activateMana']);
  });

  it('"can\'t be countered" spells ignore counterspells', () => {
    const s = game()
      .player('A')
      .battlefield('Swamp', 'Forest')
      .hand('Abrupt Decay')
      .library('Island')
      .player('B')
      .battlefield('Island', 'Island', 'Grizzly Bears')
      .hand('Counterspell')
      .library('Island')
      .start();
    s.cast('Abrupt Decay', { targets: ['Grizzly Bears'] }).pass();
    s.cast('Counterspell', { targets: ['spell:Abrupt Decay'] }).resolveAll();
    expect(s.zoneOf('Grizzly Bears')).toBe('graveyard');
  });

  it('activated abilities use the stack and can be responded to', () => {
    const s = game()
      .player('A')
      .battlefield('Prodigal Sorcerer')
      .library('Island')
      .player('B')
      .battlefield('Forest', 'Raging Goblin')
      .hand('Giant Growth')
      .library('Island')
      .start();
    s.activate('Prodigal Sorcerer', 0, { targets: ['Raging Goblin'] });
    expect(s.object('Prodigal Sorcerer').tapped).toBe(true);
    expect(s.state.stack).toHaveLength(1);
    s.pass();
    s.cast('Giant Growth', { targets: ['Raging Goblin'] }).resolveAll();
    expect(s.zoneOf('Raging Goblin')).toBe('battlefield');
  });

  it('sorcery-speed spells can only be cast in a main phase with an empty stack', () => {
    const s = game()
      .player('A')
      .battlefield('Island', 'Island', 'Island', 'Mountain')
      .hand('Divination', 'Lightning Bolt')
      .library('Forest', 'Forest', 'Forest')
      .player('B')
      .library('Island')
      .start();
    s.cast('Lightning Bolt', { targets: ['B'] });
    let actions = s.decision.kind === 'priority' ? s.decision.actions : [];
    expect(actions.some((a) => a.kind === 'cast')).toBe(false);
    s.resolveAll();
    actions = s.decision.kind === 'priority' ? s.decision.actions : [];
    expect(actions.some((a) => a.kind === 'cast')).toBe(true);
    s.passBoth();
    expect(s.state.step).toBe('beginCombat');
    actions = s.decision.kind === 'priority' ? s.decision.actions : [];
    expect(actions.some((a) => a.kind === 'cast')).toBe(false);
  });

  it('flash creatures can be cast at instant speed', () => {
    const s = game()
      .player('A')
      .battlefield('Forest', 'Forest')
      .hand('Ambush Viper')
      .library('Island')
      .player('B')
      .library('Island')
      .step('end')
      .start();
    s.cast('Ambush Viper').resolveAll();
    expect(s.zone('A', 'battlefield')).toContain('Ambush Viper');
  });

  it('pays additional costs: sacrifice (Fling) and discard (Tormenting Voice)', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain', 'Mountain', 'Grizzly Bears')
      .hand('Fling', 'Tormenting Voice', 'Forest')
      .library('Island', 'Island', 'Island')
      .player('B')
      .library('Island')
      .start();
    s.cast('Fling', { targets: ['B'], choose: ['Grizzly Bears'] });
    expect(s.zoneOf('Grizzly Bears')).toBe('graveyard');
    s.resolveAll();
    expect(s.life('B')).toBe(18);
    // Tormenting Voice can't be cast: only one Mountain left untapped.
    const actions = s.decision.kind === 'priority' ? s.decision.actions : [];
    expect(actions.some((a) => a.kind === 'cast')).toBe(false);
  });

  it('modal spells choose a mode and its targets', () => {
    const s = game()
      .player('A')
      .battlefield('Plains')
      .hand('Healing Salve')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.cast('Healing Salve', { mode: 0, targets: ['A'] }).resolveAll();
    expect(s.life('A')).toBe(23);
  });

  it('"unless pays" counters when the controller cannot pay (Mana Leak)', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain')
      .hand('Lightning Bolt')
      .library('Island')
      .player('B')
      .battlefield('Island', 'Island')
      .hand('Mana Leak')
      .library('Island')
      .start();
    s.cast('Lightning Bolt', { targets: ['B'] }).pass();
    s.cast('Mana Leak', { targets: ['spell:Lightning Bolt'] }).resolveAll();
    expect(s.life('B')).toBe(20);
    expect(s.zoneOf('Lightning Bolt')).toBe('graveyard');
  });

  it('"unless pays" lets a player with mana pay (Mana Leak)', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain', 'Mountain', 'Mountain', 'Mountain')
      .hand('Lightning Bolt')
      .library('Island')
      .player('B')
      .battlefield('Island', 'Island')
      .hand('Mana Leak')
      .library('Island')
      .start();
    s.cast('Lightning Bolt', { targets: ['B'] }).pass();
    s.cast('Mana Leak', { targets: ['spell:Lightning Bolt'] }).passBoth();
    expect(s.decision.kind).toBe('yesNo');
    s.answer({ kind: 'yesNo', yes: true });
    expect(s.stackNames).toEqual(['Lightning Bolt']);
    s.resolveAll();
    expect(s.life('B')).toBe(17);
  });

  it('loses the game when the spell resolution runs out of library cards to draw (CR 704.5b)', () => {
    const s = game()
      .player('A')
      .battlefield('Island', 'Island', 'Island')
      .hand('Divination')
      .library('Forest')
      .player('B')
      .library('Island')
      .start();
    s.cast('Divination').resolveAll();
    expect(s.state.result).toEqual({ winner: 'B', reason: 'drawFromEmptyLibrary' });
  });
});
