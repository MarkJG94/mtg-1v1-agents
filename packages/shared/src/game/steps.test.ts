import { describe, expect, it } from 'vitest';
import {
  indexOfStep,
  isCombatStep,
  isMainPhase,
  phaseOf,
  phases,
  skipsPriority,
  steps,
} from './steps.js';

describe('steps', () => {
  it('lists each step once, in turn order', () => {
    expect(new Set(steps).size).toBe(steps.length);
    expect(steps[0]).toBe('untap');
    expect(steps.at(-1)).toBe('cleanup');
  });

  it('assigns every step to a known phase', () => {
    for (const step of steps) expect(phases).toContain(phaseOf(step));
  });

  it('orders the phases as the turn runs', () => {
    const seen: string[] = [];
    for (const step of steps) {
      const phase = phaseOf(step);
      if (seen.at(-1) !== phase) seen.push(phase);
    }
    expect(seen).toEqual(['beginning', 'precombatMain', 'combat', 'postcombatMain', 'ending']);
  });

  it('increases the index monotonically', () => {
    const indexes = steps.map(indexOfStep);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(new Set(indexes).size).toBe(steps.length);
  });

  it('reports -1 for something that is not a step', () => {
    expect(indexOfStep('not-a-step' as (typeof steps)[number])).toBe(-1);
  });
});

describe('step predicates', () => {
  it('knows the two main phases', () => {
    expect(steps.filter(isMainPhase)).toEqual(['precombatMain', 'postcombatMain']);
  });

  it('knows the combat steps, including the first-strike damage step', () => {
    expect(steps.filter(isCombatStep)).toEqual([
      'beginCombat',
      'declareAttackers',
      'declareBlockers',
      'firstStrikeDamage',
      'combatDamage',
      'endCombat',
    ]);
  });

  it('skips priority only in untap and cleanup (CR 502.3, 514.3)', () => {
    expect(steps.filter(skipsPriority)).toEqual(['untap', 'cleanup']);
  });
});
