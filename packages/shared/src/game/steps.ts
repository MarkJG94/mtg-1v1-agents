/**
 * Turn structure (CR 500). The engine walks these in order; the UI labels them.
 */

export const phases = ['beginning', 'precombatMain', 'combat', 'postcombatMain', 'ending'] as const;
export type Phase = (typeof phases)[number];

/**
 * Steps in the order they occur. Two of these are conditional rather than skippable:
 * `firstStrikeDamage` exists only when a creature with first or double strike is in
 * combat (CR 510.5), and the whole combat phase can be skipped by effects.
 */
export const steps = [
  'untap',
  'upkeep',
  'draw',
  'precombatMain',
  'beginCombat',
  'declareAttackers',
  'declareBlockers',
  'firstStrikeDamage',
  'combatDamage',
  'endCombat',
  'postcombatMain',
  'end',
  'cleanup',
] as const;
export type Step = (typeof steps)[number];

const stepPhases: Record<Step, Phase> = {
  untap: 'beginning',
  upkeep: 'beginning',
  draw: 'beginning',
  precombatMain: 'precombatMain',
  beginCombat: 'combat',
  declareAttackers: 'combat',
  declareBlockers: 'combat',
  firstStrikeDamage: 'combat',
  combatDamage: 'combat',
  endCombat: 'combat',
  postcombatMain: 'postcombatMain',
  end: 'ending',
  cleanup: 'ending',
};

export const phaseOf = (step: Step): Phase => stepPhases[step];

/** Main phases are where sorcery-speed actions are legal (CR 505.6b). */
export const isMainPhase = (step: Step): boolean =>
  step === 'precombatMain' || step === 'postcombatMain';

export const isCombatStep = (step: Step): boolean => phaseOf(step) === 'combat';

/**
 * Steps in which no player receives priority under normal rules: untap (CR 502.3)
 * and cleanup (CR 514.3, unless a trigger or SBA happens).
 */
export const skipsPriority = (step: Step): boolean => step === 'untap' || step === 'cleanup';

const stepIndex: ReadonlyMap<Step, number> = new Map(steps.map((step, index) => [step, index]));

/** Position in the turn, for ordering comparisons. */
export const indexOfStep = (step: Step): number => stepIndex.get(step) ?? -1;
