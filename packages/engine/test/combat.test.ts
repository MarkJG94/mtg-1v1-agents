import { describe, expect, it } from 'vitest';
import { scenario } from '../src/testing/index.js';
import { CARDS } from './fixtures/cards.js';

const game = () => scenario(CARDS);

describe('combat (CR 506–511)', () => {
  it('an unblocked attacker deals damage to the defending player and taps (no vigilance)', () => {
    const s = game()
      .player('A')
      .battlefield('Grizzly Bears')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.attack(['Grizzly Bears']);
    expect(s.object('Grizzly Bears').tapped).toBe(true);
    s.finishCombat();
    expect(s.life('B')).toBe(18);
  });

  it('vigilance attackers do not tap; summoning-sick creatures cannot attack without haste', () => {
    const s = game()
      .player('A')
      .battlefield(
        'Serra Angel',
        ['Grizzly Bears', { sick: true }],
        ['Raging Goblin', { sick: true }],
      )
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.toStep('declareAttackers');
    const dec = s.decision;
    expect(dec.kind).toBe('declareAttackers');
    if (dec.kind !== 'declareAttackers') return;
    expect(dec.candidates.map((c) => s.state.objects[c.attacker]!.definitionId).sort()).toEqual([
      'Raging Goblin',
      'Serra Angel',
    ]);
    s.answer({
      kind: 'declareAttackers',
      attacks: dec.candidates.map((c) => ({ attacker: c.attacker, defender: 'B' })),
    });
    expect(s.object('Serra Angel').tapped).toBe(false);
    expect(s.object('Raging Goblin').tapped).toBe(true);
    s.finishCombat();
    expect(s.life('B')).toBe(15);
  });

  it('blocks: both creatures deal damage simultaneously and SBAs destroy lethally damaged ones', () => {
    const s = game()
      .player('A')
      .battlefield('Hill Giant')
      .library('Island')
      .player('B')
      .battlefield('Grizzly Bears')
      .library('Island')
      .start();
    s.attack(['Hill Giant'])
      .block([['Grizzly Bears', 'Hill Giant']])
      .finishCombat();
    expect(s.zoneOf('Grizzly Bears')).toBe('graveyard');
    expect(s.zoneOf('Hill Giant')).toBe('battlefield');
    expect(s.object('Hill Giant').damage).toBe(2);
    expect(s.life('B')).toBe(20);
  });

  it('flying can only be blocked by flying or reach (CR 702.9)', () => {
    const s = game()
      .player('A')
      .battlefield('Wind Drake')
      .library('Island')
      .player('B')
      .battlefield('Grizzly Bears', 'Giant Spider', 'Serra Angel')
      .library('Island')
      .start();
    s.attack(['Wind Drake']).toStep('declareBlockers');
    const dec = s.decision;
    if (dec.kind !== 'declareBlockers') throw new Error('expected declareBlockers');
    expect(dec.candidates.map((c) => s.state.objects[c.blocker]!.definitionId).sort()).toEqual([
      'Giant Spider',
      'Serra Angel',
    ]);
  });

  it('menace requires two or more blockers (CR 702.110)', () => {
    const s = game()
      .player('A')
      .battlefield('Boggart Brute')
      .library('Island')
      .player('B')
      .battlefield('Grizzly Bears', 'Hill Giant')
      .library('Island')
      .start();
    s.attack(['Boggart Brute']).toStep('declareBlockers');
    expect(() =>
      s.answer({
        kind: 'declareBlockers',
        blocks: [{ blocker: s.find('Grizzly Bears'), attacker: s.find('Boggart Brute') }],
      }),
    ).toThrow(/menace/);
    s.answer({
      kind: 'declareBlockers',
      blocks: [
        { blocker: s.find('Grizzly Bears'), attacker: s.find('Boggart Brute') },
        { blocker: s.find('Hill Giant'), attacker: s.find('Boggart Brute') },
      ],
    });
    // Damage assignment order for two blockers.
    expect(s.decision.kind).toBe('orderBlockers');
    s.answer({ kind: 'orderBlockers', order: [s.find('Grizzly Bears'), s.find('Hill Giant')] });
    s.toStep('combatDamage');
    // 3 damage: must assign lethal (2) to the Bears before the Giant.
    const dec = s.decision;
    expect(dec.kind).toBe('assignDamage');
    if (dec.kind !== 'assignDamage') return;
    expect(() =>
      s.answer({ kind: 'assignDamage', assignments: [{ id: s.find('Hill Giant'), amount: 3 }] }),
    ).toThrow(/lethal/);
    s.answer({
      kind: 'assignDamage',
      assignments: [
        { id: s.find('Grizzly Bears'), amount: 2 },
        { id: s.find('Hill Giant'), amount: 1 },
      ],
    });
    s.finishCombat();
    expect(s.zoneOf('Grizzly Bears')).toBe('graveyard');
    expect(s.zoneOf('Boggart Brute')).toBe('graveyard');
    expect(s.object('Hill Giant').damage).toBe(1);
  });

  it('trample assigns excess damage to the player; deathtouch makes 1 damage lethal (CR 702.19, 702.2)', () => {
    const s = game()
      .player('A')
      .battlefield('Rampaging Baloths')
      .library('Island')
      .player('B')
      .battlefield('Grizzly Bears')
      .library('Island')
      .start();
    s.attack(['Rampaging Baloths'])
      .block([['Grizzly Bears', 'Rampaging Baloths']])
      .toStep('combatDamage');
    const dec = s.decision;
    if (dec.kind !== 'assignDamage') throw new Error(`expected assignDamage, got ${dec.kind}`);
    expect(dec.trample).toBe(true);
    s.answer({
      kind: 'assignDamage',
      assignments: [
        { id: s.find('Grizzly Bears'), amount: 2 },
        { id: 'B', amount: 4 },
      ],
    });
    s.finishCombat();
    expect(s.life('B')).toBe(16);
    expect(s.zoneOf('Grizzly Bears')).toBe('graveyard');

    const t = game()
      .player('A')
      .battlefield('Vampire Nighthawk')
      .library('Island')
      .player('B')
      .battlefield('Giant Spider')
      .library('Island')
      .start();
    t.attack(['Vampire Nighthawk'])
      .block([['Giant Spider', 'Vampire Nighthawk']])
      .finishCombat();
    expect(t.zoneOf('Giant Spider')).toBe('graveyard');
    expect(t.zoneOf('Vampire Nighthawk')).toBe('battlefield');
    expect(t.life('A')).toBe(22); // lifelink
  });

  it('first strike creates a first-strike damage step; the first striker survives (CR 702.7)', () => {
    const s = game()
      .player('A')
      .battlefield('White Knight')
      .library('Island')
      .player('B')
      .battlefield('Grizzly Bears')
      .library('Island')
      .start();
    s.attack(['White Knight'])
      .block([['Grizzly Bears', 'White Knight']])
      .toStep('firstStrikeDamage');
    expect(s.state.step).toBe('firstStrikeDamage');
    expect(s.zoneOf('Grizzly Bears')).toBe('graveyard');
    s.finishCombat();
    expect(s.object('White Knight').damage).toBe(0);
  });

  it('double strike deals damage in both steps', () => {
    const s = game()
      .player('A')
      .battlefield('Boros Swiftblade')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.attack(['Boros Swiftblade']).finishCombat();
    expect(s.life('B')).toBe(18);
  });

  it('no first-strike step happens without first strikers', () => {
    const s = game()
      .player('A')
      .battlefield('Grizzly Bears')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    const steps = new Set<string>();
    s.attack(['Grizzly Bears']);
    while (s.state.step !== 'endCombat') {
      steps.add(s.state.step);
      const dec = s.decision;
      if (dec.kind === 'priority') s.pass();
      else s.answer(s.defaultAnswer(dec));
    }
    expect(steps.has('firstStrikeDamage')).toBe(false);
    expect(steps.has('combatDamage')).toBe(true);
  });

  it('defender cannot attack; "can\'t be blocked" cannot be blocked', () => {
    const s = game()
      .player('A')
      .battlefield('Wall of Stone', 'Phantom Warrior')
      .library('Island')
      .player('B')
      .battlefield('Grizzly Bears')
      .library('Island')
      .start();
    s.toStep('declareAttackers');
    const dec = s.decision;
    if (dec.kind !== 'declareAttackers') throw new Error('expected attackers');
    expect(dec.candidates.map((c) => s.state.objects[c.attacker]!.definitionId)).toEqual([
      'Phantom Warrior',
    ]);
    s.answer({
      kind: 'declareAttackers',
      attacks: [{ attacker: s.find('Phantom Warrior'), defender: 'B' }],
    });
    s.toStep('endCombat');
    expect(s.life('B')).toBe(18);
  });

  it('creatures can attack planeswalkers and damage removes loyalty (CR 306.7)', () => {
    const s = game()
      .player('A')
      .battlefield('Hill Giant')
      .library('Island')
      .player('B')
      .battlefield('Jace Beleren')
      .library('Island')
      .start();
    s.attack([['Hill Giant', 'Jace Beleren']]).finishCombat();
    expect(s.zoneOf('Jace Beleren')).toBe('graveyard');
    expect(s.life('B')).toBe(20);
  });

  it('a creature removed from combat deals and receives no damage', () => {
    const s = game()
      .player('A')
      .battlefield('Hill Giant')
      .library('Island')
      .player('B')
      .battlefield('Grizzly Bears', 'Island')
      .hand('Unsummon')
      .library('Island')
      .start();
    s.attack(['Hill Giant']).block([['Grizzly Bears', 'Hill Giant']]);
    s.pass();
    s.cast('Unsummon', { targets: ['Hill Giant'] }).resolveAll();
    s.finishCombat();
    expect(s.zoneOf('Hill Giant')).toBe('hand');
    expect(s.zoneOf('Grizzly Bears')).toBe('battlefield');
    expect(s.life('B')).toBe(20);
  });

  it('Fog prevents all combat damage', () => {
    const s = game()
      .player('A')
      .battlefield('Hill Giant')
      .library('Island')
      .player('B')
      .battlefield('Forest')
      .hand('Fog')
      .library('Island')
      .start();
    s.attack(['Hill Giant']).pass();
    s.cast('Fog').resolveAll();
    s.finishCombat();
    expect(s.life('B')).toBe(20);
  });

  it('Pacifism stops attacking and blocking', () => {
    const s = game()
      .player('A')
      .battlefield(['Grizzly Bears', { attachedTo: undefined as never }])
      .battlefield(['Pacifism', { attachedTo: 'Grizzly Bears' }])
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.toStep('declareAttackers');
    expect(s.decision.kind).toBe('priority');
  });

  it('Jackal Familiar can attack only alongside another creature (conditional static)', () => {
    const s = game()
      .player('A')
      .battlefield('Jackal Familiar')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.toStep('declareAttackers');
    expect(s.decision.kind).toBe('priority');
    const t = game()
      .player('A')
      .battlefield('Jackal Familiar', 'Grizzly Bears')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    t.toStep('declareAttackers');
    expect(t.decision.kind).toBe('declareAttackers');
  });
});
