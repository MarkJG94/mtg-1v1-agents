/**
 * Everything an agent is allowed to see (`@mtg/engine/view`).
 *
 * A separate entry point, and the separation is the whole mechanism. `@mtg/engine`
 * exports `GameState` and every function that reads one; an agent that imported it could
 * look at the opponent's hand, and no test of an agent's *behaviour* would ever notice —
 * it would only play better. So the agents package imports this instead, and
 * `import-boundary.test.ts` holds it to that.
 *
 * Four things are here because an agent genuinely needs all four, and nothing else is:
 *
 * - the **view**: what this player knows;
 * - the **decisions**: what is being asked and what an answer looks like;
 * - the **RNG**: an interface, so an agent's randomness is seeded like everything else
 *   and a game stays a pure function of its seed;
 * - the **simulator**: an interface too, for a searching agent to play determinisations
 *   of the game forward (ADR 0012) — the driver supplies the implementation.
 *
 * None of them can reach a `GameState` at run time. `decision.ts` refers to combat and
 * rules-event types, but only as `import type`, which is erased — and a test walks this
 * module's real import graph rather than trusting that sentence.
 */

export type { CardType } from '../cards/vocabulary.js';
export type {
  BottomCardsDecision,
  ChooseOptionDecision,
  ChooseReplacementDecision,
  Decision,
  DecisionResponse,
  DeclareAttackersDecision,
  DeclareBlockersDecision,
  DiscardDecision,
  MulliganDecision,
  OrderBlockersDecision,
  OrderTriggersDecision,
  PlayOrDrawDecision,
  PriorityAction,
  PriorityDecision,
} from '../decision.js';
export type { Keywords } from '../keywords.js';

export type { Rng } from '../rng.js';
export type {
  CombatView,
  OpponentSideView,
  OwnSideView,
  PlayerView,
  SideView,
  VisibleObject,
} from './player-view.js';
export { objectsSeenIn, seen } from './player-view.js';
export type { Simulator, World, WorldStatus } from './simulator.js';
