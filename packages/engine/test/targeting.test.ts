import { describe, expect, it } from 'vitest';
import { scenario } from '../src/testing/index.js';
import { CARDS } from './fixtures/cards.js';

const game = () => scenario(CARDS);

function targetsOf(s: ReturnType<ReturnType<typeof game>['start']>): string[] {
  const dec = s.decision;
  if (dec.kind !== 'chooseTargets') throw new Error(`expected chooseTargets, got ${dec.kind}`);
  return dec.candidates[0]!.map((c) =>
    c.kind === 'player'
      ? c.player
      : c.kind === 'object'
        ? s.state.objects[c.id]!.definitionId
        : `stack:${c.stackId}`,
  );
}

describe('targeting legality (CR 115)', () => {
  it('offers exactly the legal targets for "any target"', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain', 'Grizzly Bears')
      .hand('Lightning Bolt')
      .library('Island')
      .player('B')
      .battlefield('Wind Drake', 'Jace Beleren', 'Forest')
      .library('Island')
      .start();
    const dec = s.decision;
    if (dec.kind !== 'priority') throw new Error('expected priority');
    s.answer({ kind: 'priority', action: dec.actions.find((a) => a.kind === 'cast')! });
    expect(targetsOf(s).sort()).toEqual(
      ['A', 'B', 'Grizzly Bears', 'Jace Beleren', 'Wind Drake'].sort(),
    );
  });

  it('hexproof stops opponents but not the controller (CR 702.11)', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain', 'Forest', 'Invisible Stalker')
      .hand('Lightning Bolt', 'Giant Growth')
      .library('Island')
      .player('B')
      .battlefield('Invisible Stalker')
      .library('Island')
      .start();
    const dec = s.decision;
    if (dec.kind !== 'priority') throw new Error('expected priority');
    s.answer({
      kind: 'priority',
      action: dec.actions.find((a) => a.kind === 'cast' && a.object === s.find('Lightning Bolt'))!,
    });
    expect(targetsOf(s).filter((t) => t === 'Invisible Stalker')).toHaveLength(1);
    s.answer({ kind: 'chooseTargets', targets: [[{ kind: 'player', player: 'B' }]] }).resolveAll();
    s.cast('Giant Growth', { targets: ['Invisible Stalker'] }).resolveAll();
    expect(s.chars('Invisible Stalker').power).toBe(4);
  });

  it('shroud stops everyone (CR 702.18)', () => {
    const s = game()
      .player('A')
      .battlefield(
        'Mountain',
        'Forest',
        'Forest',
        'Forest',
        'Forest',
        'Forest',
        'Forest',
        'Forest',
        'Simic Sky Swallower',
      )
      .hand('Giant Growth')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    const actions = s.decision.kind === 'priority' ? s.decision.actions : [];
    expect(actions.some((a) => a.kind === 'cast')).toBe(false);
  });

  it('protection from a colour prevents targeting, damage and blocking (CR 702.16)', () => {
    const s = game()
      .player('A')
      .battlefield('Swamp', 'Swamp', 'Black Knight')
      .hand('Doom Blade')
      .library('Island')
      .player('B')
      .battlefield('White Knight', 'Mountain')
      .hand('Shock')
      .library('Island')
      .start();
    // Doom Blade (black) cannot target White Knight (pro-black) and cannot target Black Knight (black creature).
    const actions = s.decision.kind === 'priority' ? s.decision.actions : [];
    expect(actions.some((a) => a.kind === 'cast')).toBe(false);
    s.pass();
    // Shock (red) can target both knights; damage to Black Knight from a red source is not prevented.
    s.cast('Shock', { targets: ['Black Knight'] }).resolveAll();
    expect(s.zoneOf('Black Knight')).toBe('graveyard');
  });

  it('protection prevents damage from sources with that quality', () => {
    const s = game()
      .player('A')
      .battlefield('Drudge Skeletons')
      .library('Island')
      .player('B')
      .battlefield('White Knight')
      .library('Island')
      .start();
    // White Knight (pro-black) blocks Drudge Skeletons: the Skeletons' black damage is prevented.
    s.attack([['Drudge Skeletons', 'B']]);
    s.block([['White Knight', 'Drudge Skeletons']]);
    s.finishCombat();
    expect(s.zoneOf('White Knight')).toBe('battlefield');
    expect(s.object('White Knight').damage).toBe(0);
    expect(s.zoneOf('Drudge Skeletons')).toBe('graveyard');
  });

  it('ward counters the spell unless the caster pays (CR 702.21)', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain')
      .hand('Lightning Bolt')
      .library('Island')
      .player('B')
      .battlefield('Warded Crocodile')
      .library('Island')
      .start();
    s.cast('Lightning Bolt', { targets: ['Warded Crocodile'] });
    expect(s.stackNames).toEqual(['Lightning Bolt', 'Warded Crocodile:trigger']);
    s.resolveAll();
    expect(s.zoneOf('Warded Crocodile')).toBe('battlefield');
    expect(s.zoneOf('Lightning Bolt')).toBe('graveyard');
  });

  it('ward can be paid', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain', 'Mountain', 'Mountain')
      .hand('Lightning Bolt')
      .library('Island')
      .player('B')
      .battlefield('Warded Crocodile')
      .library('Island')
      .start();
    s.cast('Lightning Bolt', { targets: ['Warded Crocodile'] }).passBoth();
    expect(s.decision.kind).toBe('yesNo');
    s.answer({ kind: 'yesNo', yes: true }).resolveAll();
    expect(s.zoneOf('Warded Crocodile')).toBe('graveyard');
  });

  it('cannot cast a targeted spell with no legal targets', () => {
    const s = game()
      .player('A')
      .battlefield('Island')
      .hand('Unsummon')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    const actions = s.decision.kind === 'priority' ? s.decision.actions : [];
    expect(actions.some((a) => a.kind === 'cast')).toBe(false);
  });

  it('rejects an illegal target answer', () => {
    const s = game()
      .player('A')
      .battlefield('Island', 'Grizzly Bears')
      .hand('Unsummon')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    const dec = s.decision;
    if (dec.kind !== 'priority') throw new Error('expected priority');
    s.answer({ kind: 'priority', action: dec.actions.find((a) => a.kind === 'cast')! });
    expect(() =>
      s.answer({ kind: 'chooseTargets', targets: [[{ kind: 'player', player: 'B' }]] }),
    ).toThrow(/illegal target/);
  });

  it('a multi-target spell with one remaining legal target still resolves for that target', () => {
    const s = game()
      .player('A')
      .battlefield('Forest', 'Forest', 'Grizzly Bears', 'Mountain')
      .hand('Prey Upon', 'Lightning Bolt')
      .library('Island')
      .player('B')
      .battlefield('Wind Drake')
      .library('Island')
      .start();
    s.cast('Prey Upon', { targets: ['Grizzly Bears', 'Wind Drake'] });
    s.cast('Lightning Bolt', { targets: ['Wind Drake'] }).passBoth();
    expect(s.zoneOf('Wind Drake')).toBe('graveyard');
    s.passBoth();
    // Fight with an illegal second target: nothing happens, but the spell does not fizzle.
    expect(s.events.some((e) => e.type === 'fizzle')).toBe(false);
    expect(s.object('Grizzly Bears').damage).toBe(0);
  });
});
