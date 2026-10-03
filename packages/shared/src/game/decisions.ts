/**
 * The kinds of choice the engine can pause on (docs/02-rules-engine.md).
 *
 * Only the *names* live here, because the event log records which kind of decision was
 * made. The `Decision` objects themselves — with their legal options — are an engine
 * concern and stay in `@mtg/engine`.
 */
export const decisionKinds = [
  // Who takes the first turn, before anything is dealt (CR 103.1).
  'playOrDraw',
  'mulligan',
  'bottomCards',
  'priority',
  'chooseTargets',
  'chooseMode',
  'payCost',
  'chooseX',
  'declareAttackers',
  'declareBlockers',
  'orderBlockers',
  'assignDamage',
  'orderTriggers',
  'chooseReplacement',
  'chooseCardsFromLibrary',
  'discard',
  'distributeCounters',
  'yesNo',
  'chooseOption',
] as const;
export type DecisionKind = (typeof decisionKinds)[number];
