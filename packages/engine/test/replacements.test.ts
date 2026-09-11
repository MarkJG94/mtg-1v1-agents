import { describe, expect, it } from 'vitest';
import { scenario } from '../src/testing/index.js';
import { CARDS } from './fixtures/cards.js';

const game = () => scenario(CARDS);

describe('replacement and prevention effects (CR 614, 615)', () => {
  it('"enters tapped" applies as the permanent enters', () => {
    const s = game()
      .player('A')
      .hand('Simic Guildgate')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.playLand('Simic Guildgate');
    expect(s.object('Simic Guildgate').tapped).toBe(true);
  });

  it('"if it would die, exile it instead" (Rest in Peace)', () => {
    const s = game()
      .player('A')
      .battlefield('Rest in Peace', 'Mountain')
      .hand('Lightning Bolt')
      .library('Island')
      .player('B')
      .battlefield('Grizzly Bears', 'Blood Artist')
      .library('Island')
      .start();
    s.cast('Lightning Bolt', { targets: ['Grizzly Bears'] }).passBoth();
    expect(s.zoneOf('Grizzly Bears')).toBe('exile');
    // It never died, so Blood Artist does not trigger.
    expect(s.state.stack).toHaveLength(0);
  });

  it('extra counters (Hardened Scales)', () => {
    const s = game()
      .player('A')
      .battlefield('Hardened Scales', 'Grizzly Bears', 'Ajani Goldmane')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.activate('Ajani Goldmane', 1).resolveAll();
    expect(s.object('Grizzly Bears').counters['+1/+1']).toBe(2);
  });

  it('prevents all damage from red sources to you (Circle of Protection: Red)', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain')
      .hand('Lightning Bolt')
      .library('Island')
      .player('B')
      .battlefield('Circle of Protection: Red', 'Grizzly Bears')
      .library('Island')
      .start();
    s.cast('Lightning Bolt', { targets: ['B'] }).resolveAll();
    expect(s.life('B')).toBe(20);
  });

  it('"prevent the next 3 damage" shields are consumed by damage (Healing Salve)', () => {
    const s = game()
      .player('A')
      .battlefield('Plains', 'Mountain', 'Mountain', 'Hill Giant')
      .hand('Healing Salve', 'Lightning Bolt', 'Shock')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.cast('Healing Salve', { mode: 1, targets: ['Hill Giant'] }).resolveAll();
    s.cast('Lightning Bolt', { targets: ['Hill Giant'] }).resolveAll();
    expect(s.object('Hill Giant').damage).toBe(0);
    s.cast('Shock', { targets: ['Hill Giant'] }).resolveAll();
    expect(s.object('Hill Giant').damage).toBe(2);
  });

  it('lifelink and deathtouch are applied within one damage event batch', () => {
    const s = game()
      .player('A')
      .life(1)
      .battlefield('Vampire Nighthawk')
      .library('Island')
      .player('B')
      .battlefield('Giant Spider')
      .library('Island')
      .start();
    s.attack(['Vampire Nighthawk'])
      .block([['Giant Spider', 'Vampire Nighthawk']])
      .finishCombat();
    expect(s.life('A')).toBe(3);
    expect(s.zoneOf('Giant Spider')).toBe('graveyard');
    expect(s.zoneOf('Vampire Nighthawk')).toBe('battlefield');
  });

  it('Swords to Plowshares exiles and gains life equal to power via a bound value', () => {
    const s = game()
      .player('A')
      .battlefield('Plains')
      .hand('Swords to Plowshares')
      .library('Island')
      .player('B')
      .battlefield('Hill Giant')
      .library('Island')
      .start();
    s.cast('Swords to Plowshares', { targets: ['Hill Giant'] }).resolveAll();
    expect(s.zoneOf('Hill Giant')).toBe('exile');
    expect(s.life('B')).toBe(23);
  });
});
