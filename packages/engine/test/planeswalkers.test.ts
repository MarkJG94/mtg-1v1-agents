import { describe, expect, it } from 'vitest';
import { scenario } from '../src/testing/index.js';
import { CARDS } from './fixtures/cards.js';

const game = () => scenario(CARDS);

describe('planeswalkers (CR 306)', () => {
  it('enters with loyalty counters equal to its printed loyalty', () => {
    const s = game()
      .player('A')
      .battlefield('Island', 'Island', 'Island')
      .hand('Jace Beleren')
      .library('Forest')
      .player('B')
      .library('Island')
      .start();
    s.cast('Jace Beleren').resolveAll();
    expect(s.object('Jace Beleren').counters.loyalty).toBe(3);
  });

  it('loyalty abilities cost loyalty, are sorcery speed and once per turn (606.3)', () => {
    const s = game()
      .player('A')
      .battlefield('Jace Beleren')
      .library('Forest', 'Forest')
      .player('B')
      .library('Island', 'Island')
      .start();
    s.activate('Jace Beleren', 0).resolveAll();
    expect(s.object('Jace Beleren').counters.loyalty).toBe(5);
    expect(s.zone('A', 'hand')).toEqual(['Forest']);
    expect(s.zone('B', 'hand')).toEqual(['Island']);
    const actions = s.decision.kind === 'priority' ? s.decision.actions : [];
    expect(actions.some((a) => a.kind === 'loyalty')).toBe(false);
    s.passBoth();
    expect(s.state.step).toBe('beginCombat');
    const later = s.decision.kind === 'priority' ? s.decision.actions : [];
    expect(later.some((a) => a.kind === 'loyalty')).toBe(false);
  });

  it('cannot activate a minus ability without enough loyalty', () => {
    const s = game()
      .player('A')
      .battlefield('Jace Beleren')
      .library('Forest')
      .player('B')
      .library('Island')
      .start();
    const actions = s.decision.kind === 'priority' ? s.decision.actions : [];
    const loyalty = actions.filter((a) => a.kind === 'loyalty');
    expect(loyalty.map((a) => (a.kind === 'loyalty' ? a.ability : -1)).sort()).toEqual([0, 1]);
  });

  it('a minus ability that drops loyalty to 0 puts the planeswalker into the graveyard after it resolves', () => {
    const s = game()
      .player('A')
      .battlefield(['Jace Beleren', { counters: { loyalty: 1 } }])
      .library('Forest')
      .player('B')
      .library('Island')
      .start();
    s.activate('Jace Beleren', 1, { targets: ['A'] });
    expect(s.zoneOf('Jace Beleren')).toBe('graveyard');
    s.resolveAll();
    expect(s.zone('A', 'hand')).toEqual(['Forest']);
  });

  it('non-combat damage to a planeswalker removes loyalty and never redirects (post-2018 rules)', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain')
      .hand('Shock')
      .library('Island')
      .player('B')
      .battlefield('Jace Beleren')
      .library('Island')
      .start();
    s.cast('Shock', { targets: ['Jace Beleren'] }).resolveAll();
    expect(s.object('Jace Beleren').counters.loyalty).toBe(1);
    expect(s.life('B')).toBe(20);
  });

  it("Ajani's -1 puts counters on each creature you control", () => {
    const s = game()
      .player('A')
      .battlefield('Ajani Goldmane', 'Grizzly Bears', 'Hill Giant')
      .library('Forest')
      .player('B')
      .battlefield('Wind Drake')
      .library('Island')
      .start();
    s.activate('Ajani Goldmane', 1).resolveAll();
    expect(s.chars('Grizzly Bears').power).toBe(3);
    expect(s.chars('Hill Giant').power).toBe(4);
    expect(s.chars('Wind Drake').power).toBe(2);
    expect(s.object('Ajani Goldmane').counters.loyalty).toBe(3);
  });
});
