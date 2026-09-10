import { describe, expect, it } from 'vitest';
import { costColors, emptyPool, manaValue, parseManaCost } from '../src/mana/cost.js';
import { type ManaSource, solvePayment } from '../src/mana/solver.js';
import { scenario } from '../src/testing/index.js';
import { CARDS } from './fixtures/cards.js';

const game = () => scenario(CARDS);

function src(object: number, ...options: string[]): ManaSource {
  const opts = options.map((o) => o.split('') as ManaSource['options'][number]);
  return { object, ability: 0, options: opts, flexibility: new Set(opts.flat()).size };
}

describe('mana costs (CR 202)', () => {
  it('parses symbols and computes mana value', () => {
    const c = parseManaCost('{2}{G}{G/U}{R/P}{X}{C}{2/W}');
    expect(c.symbols.map((s) => s.kind)).toEqual([
      'generic',
      'colored',
      'hybrid',
      'phyrexian',
      'x',
      'colorless',
      'monoHybrid',
    ]);
    expect(manaValue(c)).toBe(2 + 1 + 1 + 1 + 0 + 1 + 2);
    expect(manaValue(c, 4)).toBe(12);
    expect(costColors(c)).toEqual(['W', 'U', 'R', 'G']);
  });
});

describe('payment solver', () => {
  it('pays coloured pips from the least flexible sources', () => {
    const s = solvePayment(
      parseManaCost('{1}{G}'),
      emptyPool(),
      [src(1, 'G'), src(2, 'G', 'U'), src(3, 'R')],
      0,
      20,
    )!;
    expect(s).not.toBeNull();
    expect(s.taps).toHaveLength(2);
    expect(s.taps.map((t) => t.source.object).sort()).toEqual([1, 3]);
  });

  it('uses the pool before tapping', () => {
    const pool = { ...emptyPool(), R: 1 };
    const s = solvePayment(parseManaCost('{R}'), pool, [src(1, 'R')], 0, 20)!;
    expect(s.taps).toHaveLength(0);
    expect(s.used).toEqual(['R']);
  });

  it('handles hybrid, phyrexian and mono-hybrid alternatives', () => {
    expect(solvePayment(parseManaCost('{G/U}'), emptyPool(), [src(1, 'U')], 0, 20)).not.toBeNull();
    expect(solvePayment(parseManaCost('{G/U}'), emptyPool(), [src(1, 'R')], 0, 20)).toBeNull();
    const phy = solvePayment(parseManaCost('{U/P}'), emptyPool(), [], 0, 20)!;
    expect(phy.lifePaid).toBe(2);
    expect(solvePayment(parseManaCost('{U/P}'), emptyPool(), [], 0, 2)).toBeNull();
    const mono = solvePayment(
      parseManaCost('{2/W}'),
      emptyPool(),
      [src(1, 'R'), src(2, 'G')],
      0,
      20,
    )!;
    expect(mono.taps).toHaveLength(2);
    const monoW = solvePayment(
      parseManaCost('{2/W}'),
      emptyPool(),
      [src(1, 'W'), src(2, 'G')],
      0,
      20,
    )!;
    expect(monoW.taps).toHaveLength(1);
  });

  it('is exact: finds the only assignment when colours are tight', () => {
    // Sources: A can make W or U, B can make U or B, C makes B. Cost {W}{U}{B} needs A→W, B→U, C→B.
    const s = solvePayment(
      parseManaCost('{W}{U}{B}'),
      emptyPool(),
      [src(1, 'W', 'U'), src(2, 'U', 'B'), src(3, 'B')],
      0,
      20,
    )!;
    expect(s).not.toBeNull();
    const byObject = Object.fromEntries(
      s.taps.map((t) => [t.source.object, t.source.options[t.option]!.join('')]),
    );
    expect(byObject).toEqual({ 1: 'W', 2: 'U', 3: 'B' });
  });

  it('supports X costs and multi-mana sources', () => {
    const s = solvePayment(
      parseManaCost('{X}{R}'),
      emptyPool(),
      [src(1, 'R'), src(2, 'CC')],
      2,
      20,
    )!;
    expect(s).not.toBeNull();
    expect(s.taps).toHaveLength(2);
    expect(
      solvePayment(parseManaCost('{X}{R}'), emptyPool(), [src(1, 'R'), src(2, 'CC')], 3, 20),
    ).toBeNull();
  });
});

describe('mana abilities in play (CR 605)', () => {
  it('auto-taps lands to cast a spell and leaves flexible lands untapped', () => {
    const s = game()
      .player('A')
      .battlefield('Tropical Island', 'Forest', 'Mountain')
      .hand('Grizzly Bears')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.cast('Grizzly Bears');
    expect(s.object('Forest').tapped).toBe(true);
    expect(s.object('Mountain').tapped).toBe(true);
    expect(s.object('Tropical Island').tapped).toBe(false);
    s.resolveAll();
    expect(s.zone('A', 'battlefield')).toContain('Grizzly Bears');
  });

  it('cannot cast a spell it cannot pay for', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain')
      .hand('Grizzly Bears')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    const actions = s.decision.kind === 'priority' ? s.decision.actions : [];
    expect(actions.some((a) => a.kind === 'cast')).toBe(false);
  });

  it('a summoning-sick creature cannot tap for mana, but a land can', () => {
    const s = game()
      .player('A')
      .battlefield(['Llanowar Elves', { sick: true }], 'Forest')
      .hand('Grizzly Bears')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    const actions = s.decision.kind === 'priority' ? s.decision.actions : [];
    expect(actions.some((a) => a.kind === 'cast')).toBe(false);
    s.nextTurn().nextTurn();
    s.cast('Grizzly Bears');
    expect(s.object('Llanowar Elves').tapped).toBe(true);
  });

  it('floats mana explicitly and spends it from the pool', () => {
    const s = game()
      .player('A')
      .battlefield('Swamp')
      .hand('Dark Ritual', 'Vampire Nighthawk')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.cast('Dark Ritual').resolveAll();
    expect(s.state.players.A.pool.B).toBe(3);
    s.cast('Vampire Nighthawk').resolveAll();
    expect(s.state.players.A.pool.B).toBe(0);
    expect(s.zone('A', 'battlefield')).toContain('Vampire Nighthawk');
  });

  it('chooses a colour from a dual land and pays life for painlands', () => {
    const s = game()
      .player('A')
      .battlefield('Karplusan Forest')
      .hand('Raging Goblin')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.cast('Raging Goblin').resolveAll();
    expect(s.life('A')).toBe(19);
    expect(s.zone('A', 'battlefield')).toContain('Raging Goblin');
  });

  it('pays an X cost with the chosen X', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain', 'Mountain', 'Mountain')
      .hand('Fireball')
      .library('Island')
      .player('B')
      .library('Island')
      .start();
    s.cast('Fireball', { targets: ['B'], x: 2 }).resolveAll();
    expect(s.life('B')).toBe(18);
    expect(s.state.zones.A.battlefield.every((id) => s.state.objects[id]!.tapped)).toBe(true);
  });

  it('applies cost increases from static effects', () => {
    const s = game()
      .player('A')
      .battlefield('Mountain', 'Mountain')
      .hand('Lightning Bolt')
      .library('Island')
      .player('B')
      .battlefield("Thalia's Tax")
      .library('Island')
      .start();
    s.cast('Lightning Bolt', { targets: ['B'] });
    expect(s.state.zones.A.battlefield.every((id) => s.state.objects[id]!.tapped)).toBe(true);
  });
});
