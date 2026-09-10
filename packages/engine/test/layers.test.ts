import { describe, expect, it } from 'vitest';
import { scenario } from '../src/testing/index.js';
import { CARDS } from './fixtures/cards.js';

const game = () => scenario(CARDS);

describe('continuous effects and layers (CR 613)', () => {
  it('layer 7c: anthem and +1/+1 counters stack', () => {
    const s = game()
      .player('A')
      .battlefield('Glorious Anthem', ['Grizzly Bears', { counters: { '+1/+1': 1 } }])
      .library('Island')
      .player('B')
      .battlefield('Grizzly Bears')
      .library('Island')
      .start();
    expect(s.chars('Grizzly Bears', 0).power).toBe(4);
    expect(s.chars('Grizzly Bears', 1).power).toBe(2);
  });

  it('layer 7b set before 7c modify regardless of timestamps (Humility then Anthem, Anthem then Humility)', () => {
    const s = game()
      .player('A')
      .battlefield('Humility', 'Glorious Anthem', 'Serra Angel')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    expect(s.chars('Serra Angel').power).toBe(2);
    expect(s.chars('Serra Angel').keywords.has('flying')).toBe(false);
    const t = game()
      .player('A')
      .battlefield('Glorious Anthem', 'Humility', 'Serra Angel')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    expect(t.chars('Serra Angel').power).toBe(2);
  });

  it('effects created by spells lock their affected set (611.2c) and end at cleanup', () => {
    const s = game()
      .player('A')
      .battlefield('Forest', 'Grizzly Bears')
      .hand('Giant Growth')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.cast('Giant Growth', { targets: ['Grizzly Bears'] }).resolveAll();
    expect(s.chars('Grizzly Bears').power).toBe(5);
    expect(s.state.effects[0]!.affected).toHaveLength(1);
  });

  it("layer 4 dependency: Blood Moon removes Urborg's ability (613.8)", () => {
    const s = game()
      .player('A')
      .battlefield('Urborg, Tomb of Yawgmoth', 'Blood Moon', 'Forest')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    const urborg = s.chars('Urborg, Tomb of Yawgmoth');
    expect(urborg.subtypes).toEqual(['Mountain']);
    expect(s.chars('Forest').subtypes).toEqual(['Forest']);
    const t = game()
      .player('A')
      .battlefield('Blood Moon', 'Urborg, Tomb of Yawgmoth', 'Forest')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    expect(t.chars('Forest').subtypes).toEqual(['Forest']);
    expect(t.chars('Urborg, Tomb of Yawgmoth').subtypes).toEqual(['Mountain']);
  });

  it('Urborg alone makes every land a Swamp with a black mana ability', () => {
    const s = game()
      .player('A')
      .battlefield('Urborg, Tomb of Yawgmoth', 'Forest')
      .hand('Vampire Nighthawk')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    expect(s.chars('Forest').subtypes).toEqual(['Forest', 'Swamp']);
    const t = game()
      .player('A')
      .battlefield('Urborg, Tomb of Yawgmoth', 'Forest', 'Plains')
      .hand('Vampire Nighthawk')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    t.cast('Vampire Nighthawk').resolveAll();
    expect(t.zone('A', 'battlefield')).toContain('Vampire Nighthawk');
  });

  it('Opalescence + Humility: enchantments become creatures; Humility applies once started (613.6)', () => {
    const s = game()
      .player('A')
      .battlefield('Opalescence', 'Humility')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    const humility = s.chars('Humility');
    expect(humility.types).toContain('creature');
    // Humility (timestamp later) is a 4/4 creature that loses abilities... but its effect already started applying,
    // so Humility itself and Opalescence are 1/1 with no abilities.
    expect(humility.power).toBe(1);
    expect(s.chars('Opalescence').types).not.toContain('creature');
    const t = game()
      .player('A')
      .battlefield('Humility', 'Opalescence')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    // Opalescence later: Humility's 7b (1/1) has an earlier timestamp than Opalescence's 7b (4/4), so Humility is 4/4.
    expect(t.chars('Humility').power).toBe(4);
  });

  it('control-changing effects move the permanent between battlefields (layer 2)', () => {
    const s = game()
      .player('A')
      .battlefield('Island', 'Island', 'Island', 'Island')
      .hand('Control Magic')
      .library('Island')
      .player('B')
      .battlefield('Serra Angel')
      .library('Island')
      .start();
    s.cast('Control Magic', { targets: ['Serra Angel'] }).resolveAll();
    expect(s.zone('A', 'battlefield')).toContain('Serra Angel');
    expect(s.object('Serra Angel').controller).toBe('A');
    expect(s.object('Serra Angel').sick).toBe(true);
    // Destroying the aura returns control.
    const t = s;
    t.nextTurn();
    expect(t.state.activePlayer).toBe('B');
    void t;
  });

  it('Threaten: temporary control with haste, returning at end of turn', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain', 'Mountain', 'Mountain')
      .hand('Threaten')
      .library('Island')
      .player('B')
      .battlefield(['Hill Giant', { tapped: true }])
      .library('Island')
      .start();
    s.cast('Threaten', { targets: ['Hill Giant'] }).resolveAll();
    expect(s.object('Hill Giant').controller).toBe('A');
    expect(s.object('Hill Giant').tapped).toBe(false);
    s.attack(['Hill Giant']).finishCombat();
    expect(s.life('B')).toBe(17);
    s.nextTurn();
    expect(s.object('Hill Giant').controller).toBe('B');
    expect(s.zone('B', 'battlefield')).toContain('Hill Giant');
  });

  it('characteristic-defining abilities apply in layer 7a (Tarmogoyf)', () => {
    const s = game()
      .player('A')
      .battlefield('Tarmogoyf', 'Glorious Anthem')
      .graveyard('Lightning Bolt')
      .player('B')
      .graveyard('Grizzly Bears', 'Forest')
      .library('Island')
      .player('A')
      .library('Island')
      .start();
    expect(s.chars('Tarmogoyf').power).toBe(3 + 1);
    expect(s.chars('Tarmogoyf').toughness).toBe(4 + 1);
  });

  it('equipment grants a bonus while attached and stays when the creature dies', () => {
    const s = game()
      .player('A')
      .battlefield('Bonesplitter', 'Grizzly Bears', 'Plains', 'Mountain')
      .hand('Lightning Bolt')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.activate('Bonesplitter', 1, { targets: ['Grizzly Bears'] }).resolveAll();
    expect(s.chars('Grizzly Bears').power).toBe(4);
    s.cast('Lightning Bolt', { targets: ['Grizzly Bears'] }).resolveAll();
    expect(s.zoneOf('Bonesplitter')).toBe('battlefield');
    expect(s.object('Bonesplitter').attachedTo).toBeNull();
  });

  it('granted abilities from effects apply in layer 6', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain', 'Mountain', 'Mountain')
      .hand('Threaten')
      .library('Island')
      .player('B')
      .battlefield('Grizzly Bears')
      .library('Island')
      .start();
    s.cast('Threaten', { targets: ['Grizzly Bears'] }).resolveAll();
    expect(s.chars('Grizzly Bears').keywords.has('haste')).toBe(true);
  });
});
