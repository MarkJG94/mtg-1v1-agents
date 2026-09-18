import {
  type ObjectId,
  opponentOf,
  type PlayerId,
  playerIds,
  playerZone,
  type Step,
  skipsPriority,
  steps,
} from '@mtg/shared';
import { castSpell } from '../cards/cast.js';
import { resolveTop } from '../cards/resolve.js';
import { expireEndOfTurnEffects } from '../characteristics.js';
import {
  attackersNeedingOrder,
  availableBlockers,
  dealCombatDamage,
  declareAttackers,
  declareBlockers,
  defendingPlayer,
  emptyCombat,
  endCombat,
  legalAttackers,
  legalDefenders,
  needsFirstStrikeStep,
  orderBlockers,
} from '../combat.js';
import {
  type Decision,
  type DecisionResponse,
  type PriorityAction,
  UnexpectedDecisionError,
} from '../decision.js';
import type { EventEmitter } from '../events/emitter.js';
import { resumeBatch, runBatch, runEvent } from '../events/perform.js';
import type { MoveZoneEvent } from '../events/rules-event.js';
import { drawGame } from '../game-end.js';
import { hashState, isRepeatedState, rememberState } from '../loop.js';
import { emptyManaPool, isManaPoolEmpty } from '../mana/pool.js';
import { activateLoyaltyAbility } from '../planeswalker.js';
import { withPriority } from '../priority.js';
import { expireEndOfTurnReplacements } from '../replacement.js';
import { applyLegendRule, checkStateBasedActions } from '../sba.js';
import { applyBottomCards, applyMulligan } from '../setup.js';
import { isStackEmpty, putTriggerOnStack } from '../stack.js';
import type { GameState } from '../state/game-state.js';
import { isGameOver } from '../state/game-state.js';
import { getObject, objectsIn, updateObjects, updatePlayer, updateState } from '../state/update.js';
import {
  evaluateCondition,
  fireDelayedTriggers,
  queueTriggers,
  type TriggerInstance,
  triggersFromStep,
  triggersInApnapOrder,
} from '../triggers.js';
import { playLand } from './land.js';

/**
 * Turn structure (CR 500): walking the steps, and the turn-based actions that happen
 * automatically as each one begins.
 *
 * Priority is not here — a step's turn-based actions run, and then the step ends. Roadmap
 * 1.4 inserts priority rounds between them, which is why `advanceStep` is the seam: it
 * performs one step's automatic actions and stops, rather than running a whole turn.
 */

/** Reserved for options later phases add; kept so signatures stay stable. */
export type TurnOptions = Record<string, never>;

/**
 * Steps that do not happen this turn.
 *
 * The first-strike damage step exists only when a creature with first or double strike is
 * in combat (CR 510.4). And if nobody attacks, the declare blockers and combat damage
 * steps are skipped entirely (CR 506.5) — which is why a turn with no attack shows ten
 * steps rather than twelve.
 */
const isStepSkipped = (state: GameState, step: Step): boolean => {
  if (step === 'firstStrikeDamage') return !needsFirstStrikeStep(state);
  if (step === 'declareBlockers' || step === 'combatDamage') {
    return (state.combat?.attackers.length ?? 0) === 0;
  }
  return false;
};

/** The next step in the turn, or `null` when the turn is over. */
export const nextStep = (state: GameState, from: Step): Step | null => {
  for (let index = steps.indexOf(from) + 1; index < steps.length; index += 1) {
    const step = steps[index];
    if (step && !isStepSkipped(state, step)) return step;
  }
  return null;
};

// --- Turn-based actions ---

/**
 * Untap step (CR 502.1): the active player untaps the permanents they control. Nothing
 * else happens and no player receives priority (CR 502.3).
 *
 * This is also where summoning sickness wears off: a creature can attack once it has been
 * under its controller's control since their turn began (CR 302.6), and their turn has
 * just begun.
 */
const performUntap = (state: GameState, emitter: EventEmitter): GameState => {
  const active = state.activePlayer;
  const patches: Array<readonly [ObjectId, { tapped?: boolean; summoningSick?: boolean }]> = [];

  for (const id of objectsIn(state, 'battlefield')) {
    const object = getObject(state, id);
    if (object.controller !== active) continue;
    if (object.tapped) patches.push([id, { tapped: false, summoningSick: false }]);
    else if (object.summoningSick) patches.push([id, { summoningSick: false }]);
  }

  const untapped = updateObjects(state, patches);
  for (const [id, patch] of patches) {
    if (patch.tapped === false) emitter.emit(untapped, { type: 'untap', object: id });
  }
  return untapped;
};

/**
 * Draw step (CR 504.1). In a two-player game the player who goes first skips the draw
 * step of the first turn (CR 103.7a).
 */
const performDraw = (state: GameState, emitter: EventEmitter): GameState => {
  if (state.turn === 1 && state.activePlayer === state.config.playerOnPlay) return state;
  return drawCard(state, emitter, state.activePlayer);
};

/**
 * Draw one card, as a proposed event so that "if you would draw a card, instead ..."
 * replacements (CR 614) get their say. A player who tries to draw from an empty library
 * does not lose on the spot: they are flagged and lose the next time state-based actions
 * are checked (CR 120.3, 704.5b).
 */
export const drawCard = (state: GameState, emitter: EventEmitter, player: PlayerId): GameState =>
  runEvent(state, emitter, { kind: 'draw', player });

/**
 * Cleanup step (CR 514). The active player discards down to their maximum hand size, and
 * simultaneously all damage is removed from permanents and "until end of turn" effects
 * end — continuous ones and any unused regeneration shield alike.
 */
const performCleanup = (state: GameState): GameState => {
  const player = state.activePlayer;
  const hand = objectsIn(state, playerZone(player, 'hand'));
  const excess = hand.length - state.config.maxHandSize;

  // Discarding, removing damage and ending "until end of turn" effects all happen at once
  // (CR 514.2), so the order here is free. Tidying first means nothing is left to do after
  // the discard, which matters because a replacement effect can pause the discard batch.
  const tidied = finishCleanup(state);

  // Discarding is a real choice, so the engine stops and asks.
  if (excess <= 0) return tidied;

  return updateState(tidied, {
    pendingDecision: { kind: 'discard', player, count: excess, from: hand },
  });
};

/** All damage is removed and "until end of turn" effects end (CR 514.2). */
const finishCleanup = (state: GameState): GameState => {
  const patches = objectsIn(state, 'battlefield')
    .map((id) => [id, getObject(state, id)] as const)
    .filter(([, object]) => object.damage !== 0 || object.deathtouched)
    .map(([id]) => [id, { damage: 0, deathtouched: false }] as const);

  // Regeneration shields last only for the turn that made them (CR 701.15b).
  return expireEndOfTurnReplacements(expireEndOfTurnEffects(updateObjects(state, patches)));
};

const applyDiscard = (
  state: GameState,
  emitter: EventEmitter,
  decision: Extract<Decision, { kind: 'discard' }>,
  chosen: readonly ObjectId[],
): GameState => {
  if (chosen.length !== decision.count) {
    throw new UnexpectedDecisionError(
      `expected ${decision.count} card(s) to discard, got ${chosen.length}`,
    );
  }

  const player = decision.player;
  const hand = playerZone(player, 'hand');
  const graveyard = playerZone(player, 'graveyard');
  const allowed = new Set(decision.from);

  const events: MoveZoneEvent[] = [];
  for (const id of chosen) {
    if (!allowed.has(id)) {
      throw new UnexpectedDecisionError(`card ${id} is not in ${player}'s hand`);
    }
    allowed.delete(id);
    events.push({
      kind: 'moveZone',
      object: id,
      from: hand,
      to: graveyard,
      cause: 'discard',
      destruction: false,
    });
  }
  return runBatch(state, emitter, { kind: 'plain' }, events);
};

/**
 * Ask the active player which creatures attack (CR 508.1). With nothing able to attack
 * there is nothing to decide, so combat simply starts empty.
 */
const performDeclareAttackers = (state: GameState): GameState => {
  const legal = legalAttackers(state);
  const started = updateState(state, { combat: emptyCombat });
  if (legal.length === 0) return started;

  return updateState(started, {
    pendingDecision: {
      kind: 'declareAttackers',
      player: state.activePlayer,
      legal,
      defenders: legalDefenders(state),
    },
  });
};

/** Ask the defending player which creatures block (CR 509.1). */
const performDeclareBlockers = (state: GameState): GameState => {
  const attackers = (state.combat?.attackers ?? []).map((entry) => entry.attacker);
  const available = availableBlockers(state);
  if (attackers.length === 0 || available.length === 0) return state;

  return updateState(state, {
    pendingDecision: {
      kind: 'declareBlockers',
      player: defendingPlayer(state),
      attackers,
      available,
    },
  });
};

/**
 * After blockers are declared, any attacker facing two or more of them needs its blockers
 * put in a damage-assignment order (CR 509.2). Returns a state waiting on that decision,
 * or the state unchanged once every order is settled.
 */
const askForBlockerOrder = (state: GameState): GameState => {
  const attacker = attackersNeedingOrder(state)[0];
  if (attacker === undefined) return state;

  const entry = state.combat?.attackers.find((candidate) => candidate.attacker === attacker);
  return updateState(state, {
    pendingDecision: {
      kind: 'orderBlockers',
      player: state.activePlayer,
      attacker,
      blockers: entry?.blockedBy ?? [],
    },
  });
};

const performTurnBasedActions = (state: GameState, emitter: EventEmitter): GameState => {
  switch (state.step) {
    case 'untap':
      return performUntap(state, emitter);
    case 'draw':
      return performDraw(state, emitter);
    case 'declareAttackers':
      return performDeclareAttackers(state);
    case 'declareBlockers':
      return performDeclareBlockers(state);
    case 'firstStrikeDamage':
      return dealCombatDamage(state, emitter, true);
    case 'combatDamage':
      return dealCombatDamage(state, emitter, false);
    case 'endCombat':
      return endCombat(state);
    case 'cleanup':
      return performCleanup(state);
    default:
      return state;
  }
};

// --- Turns ---

/** Who takes the turn after this one: whoever is owed an extra turn, else the opponent. */
const nextTurnPlayer = (
  state: GameState,
): { player: PlayerId; extraTurns: readonly PlayerId[] } => {
  const [owed, ...rest] = state.extraTurns;
  return owed === undefined
    ? { player: opponentOf(state.activePlayer), extraTurns: state.extraTurns }
    : { player: owed, extraTurns: rest };
};

/** Give a player an extra turn after this one (CR 500.7). */
export const grantExtraTurn = (state: GameState, player: PlayerId): GameState =>
  updateState(state, { extraTurns: [...state.extraTurns, player] });

const enterStep = (state: GameState, emitter: EventEmitter, step: Step): GameState => {
  // Unused mana empties as a step or phase ends (CR 500.4). Clearing it as the next step
  // begins is the same thing, and keeps mana available for the whole step that made it.
  let entered = updateState(state, { step, passesInARow: 0, priority: null });
  for (const id of playerIds) {
    if (!isManaPoolEmpty(entered.players[id].manaPool)) {
      entered = updatePlayer(entered, id, { manaPool: emptyManaPool });
    }
  }

  emitter.emit(entered, { type: 'stepStart' });

  // "At the beginning of your upkeep" and friends, plus any delayed trigger waiting for
  // this step (CR 603.7). They queue now and go on the stack before the next priority.
  const { fired, remaining } = fireDelayedTriggers(entered, step);
  entered = queueTriggers(updateState(entered, { delayedTriggers: remaining }), [
    ...triggersFromStep(entered, step),
    ...fired,
  ]);

  return performTurnBasedActions(entered, emitter);
};

const beginTurn = (
  state: GameState,
  emitter: EventEmitter,
  player: PlayerId,
  extraTurns: readonly PlayerId[],
): GameState => {
  const turn = state.turn + 1;
  if (turn > state.config.turnCap) return drawGame(state, emitter, 'turnCap');

  // "This turn" bookkeeping resets for both players, not only the active one: effects
  // can let a player play lands on someone else's turn.
  let started = updateState(state, {
    turn,
    activePlayer: player,
    extraTurns,
    passesInARow: 0,
    triggersFiredThisTurn: [],
    loyaltyActivatedThisTurn: [],
    // A position recurring across turns is ordinary; only within one is it a loop.
    statesThisTurn: [],
    decisionsThisTurn: 0,
  });
  for (const id of playerIds) started = updatePlayer(started, id, { landsPlayedThisTurn: 0 });

  emitter.emit(started, { type: 'turnStart', activePlayer: player });
  return enterStep(started, emitter, 'untap');
};

/** Move to the next step, or into the next turn when the current one is over. */
const leaveStep = (state: GameState, emitter: EventEmitter): GameState => {
  const following = nextStep(state, state.step);
  if (following) return enterStep(state, emitter, following);

  const { player, extraTurns } = nextTurnPlayer(state);
  return beginTurn(state, emitter, player, extraTurns);
};

/**
 * Empty the trigger queue onto the stack (CR 603.3b).
 *
 * The active player's triggers go on first, then the non-active player's — which means
 * the non-active player's resolve first, since the stack is last-on-first-off. A player
 * with more than one chooses the order themselves, so this stops for a decision.
 */
const putPendingTriggersOnStack = (state: GameState, emitter: EventEmitter): GameState => {
  if (state.pendingTriggers.length === 0) return state;

  const { active, nonActive } = triggersInApnapOrder(state);
  const group = active.length > 0 ? active : nonActive;
  const first = group[0];
  if (!first) return state;

  if (group.length > 1) {
    return updateState(state, {
      pendingDecision: {
        kind: 'orderTriggers',
        player: first.controller,
        triggers: group.map((trigger) => trigger.abilityId),
      },
    });
  }

  return stackOneTrigger(state, emitter, first);
};

/**
 * Put one queued trigger on the stack, unless its intervening-if clause is false — in
 * which case it simply never goes on the stack at all (CR 603.4).
 */
const stackOneTrigger = (
  state: GameState,
  emitter: EventEmitter,
  trigger: TriggerInstance,
): GameState => {
  const remaining = state.pendingTriggers.filter((candidate) => candidate !== trigger);
  const dequeued = updateState(state, { pendingTriggers: remaining });

  if (!evaluateCondition(dequeued, trigger.interveningIf, trigger)) return dequeued;

  return putTriggerOnStack(dequeued, emitter, {
    abilityId: trigger.abilityId,
    source: trigger.source,
    controller: trigger.controller,
    definitionId: trigger.lastKnown.definitionId,
  });
};

/** Hand a player priority and stop for their decision (CR 117.1). */
const grantPriority = (state: GameState, player: PlayerId): GameState =>
  withPriority(state, player);

/**
 * Run the game forward until a player must decide, or it ends.
 *
 * State-based actions are checked immediately before priority is granted (CR 704.3), and
 * they can end the game or raise a decision of their own. Putting triggered abilities on
 * the stack belongs in the same place and arrives in roadmap 1.8.
 */
export const advanceToDecision = (
  state: GameState,
  emitter: EventEmitter,
  limit = 10_000,
): GameState => {
  let current = state;
  for (let i = 0; i < limit; i += 1) {
    if (isGameOver(current)) return current;
    // Every decision point passes through here, which makes this the one place that sees
    // each distinct position exactly once — and so the only place loop detection can sit.
    if (current.pendingDecision !== null) return checkForLoop(current, emitter);
    if (current.turn === 0) {
      throw new Error('the game has not started; call startGame or setUpGame first');
    }

    if (skipsPriority(current.step)) {
      current = leaveStep(current, emitter);
      continue;
    }

    const settled = checkStateBasedActions(current, emitter);
    if (settled !== current) {
      current = settled;
      continue;
    }

    const stacked = putPendingTriggersOnStack(current, emitter);
    if (stacked !== current) {
      current = stacked;
      continue;
    }

    // Either nobody holds priority yet this step (the active player gets it first,
    // CR 117.3a) or somebody acted and gets it straight back (CR 117.3c).
    current = grantPriority(current, current.priority ?? current.activePlayer);
  }
  throw new Error(`the game made no progress in ${limit} steps`);
};

/**
 * Begin turn 1 for the player on the play and run to the first decision.
 * Mulligans and opening hands are roadmap 1.12; this assumes the game is set up.
 */
export const startGame = (state: GameState, emitter: EventEmitter): GameState => {
  if (state.turn !== 0) throw new Error(`the game has already started (turn ${state.turn})`);
  const started = beginTurn(state, emitter, state.config.playerOnPlay, state.extraTurns);
  return advanceToDecision(started, emitter);
};

/**
 * Answer the pending decision and run on to the next one — the `step(state, decision)` of
 * docs/01. A game is therefore a pure function of its seed and the decisions taken.
 */
export const applyDecision = (
  state: GameState,
  emitter: EventEmitter,
  response: DecisionResponse,
): GameState => {
  const decision = state.pendingDecision;
  if (!decision) throw new UnexpectedDecisionError('no decision is pending');
  if (decision.kind !== response.kind) {
    throw new UnexpectedDecisionError(
      `the pending decision is "${decision.kind}", not "${response.kind}"`,
    );
  }

  // The backstop for a loop that repeated-state detection cannot see, such as one that
  // shuffles a library and so never reaches the same position twice (docs/02).
  if (state.decisionsMade + 1 > state.config.decisionCap) {
    return drawGame(state, emitter, 'decisionCap');
  }

  const cleared = updateState(state, {
    pendingDecision: null,
    decisionsMade: state.decisionsMade + 1,
    decisionsThisTurn: state.decisionsThisTurn + 1,
  });
  let next: GameState;

  if (decision.kind === 'discard' && response.kind === 'discard') {
    next = applyDiscard(cleared, emitter, decision, response.cards);
  } else if (decision.kind === 'declareAttackers' && response.kind === 'declareAttackers') {
    next = declareAttackers(cleared, emitter, response.attackers);
  } else if (decision.kind === 'declareBlockers' && response.kind === 'declareBlockers') {
    next = askForBlockerOrder(declareBlockers(cleared, emitter, response.blocks));
  } else if (decision.kind === 'orderTriggers' && response.kind === 'orderTriggers') {
    next = stackTriggersInOrder(cleared, emitter, decision.player, response.order);
  } else if (decision.kind === 'chooseOption' && response.kind === 'chooseOption') {
    next = applyLegendRule(cleared, emitter, decision.options, response.chosen);
  } else if (decision.kind === 'orderBlockers' && response.kind === 'orderBlockers') {
    next = askForBlockerOrder(orderBlockers(cleared, decision.attacker, response.order));
  } else if (decision.kind === 'chooseReplacement' && response.kind === 'chooseReplacement') {
    next = resumeBatch(cleared, emitter, response.effect);
  } else if (decision.kind === 'mulligan' && response.kind === 'mulligan') {
    next = afterSetup(applyMulligan(cleared, emitter, decision.player, response.action), emitter);
  } else if (decision.kind === 'bottomCards' && response.kind === 'bottomCards') {
    next = afterSetup(applyBottomCards(cleared, emitter, decision.player, response.cards), emitter);
  } else {
    const priority = decision as Extract<Decision, { kind: 'priority' }>;
    if (response.kind !== 'priority') {
      throw new UnexpectedDecisionError(
        `the game is waiting for a priority decision, and the answer was "${response.kind}"`,
      );
    }
    next = applyPriority(cleared, emitter, priority, response.action);
  }

  return advanceToDecision(next, emitter);
};

/**
 * A position the turn has already been in means nothing has changed and nothing will, so
 * the game is a draw (CR 726). Checked as the engine settles on a decision, which is the
 * one moment a position is fully formed and can be compared with another.
 *
 * Not every decision, though: a turn is only watched once it has run longer than any
 * ordinary turn does (`config.loopCheckAfter`). A loop never stops looping, so a detector
 * that starts late still catches it — it just does not charge every normal turn for the
 * privilege, which the 1.14 benchmarks showed was nine tenths of a game. ADR 0005.
 */
const checkForLoop = (state: GameState, emitter: EventEmitter): GameState => {
  if (!state.config.detectLoops || state.turn === 0) return state;
  if (state.decisionsThisTurn < state.config.loopCheckAfter) return state;

  const hash = hashState(state);
  if (isRepeatedState(state, hash)) return drawGame(state, emitter, 'loop');
  return updateState(state, { statesThisTurn: rememberState(state, hash) });
};

/**
 * Once the opening hands are settled, turn 1 begins (CR 103.7). Mulligans are the only
 * thing that happens on "turn 0", so this is the one place where a state with no turn
 * yet becomes a game in progress.
 */
const afterSetup = (state: GameState, emitter: EventEmitter): GameState =>
  state.turn === 0 && state.mulligans === null && state.pendingDecision === null
    ? beginTurn(state, emitter, state.config.playerOnPlay, state.extraTurns)
    : state;

/**
 * What a player does with priority: pass, or take one of the actions `legalActions`
 * offered (CR 117.1).
 *
 * Everything but passing leaves the player still holding priority — casting a spell or
 * playing a land does not give it up (CR 117.3c) — so those return without touching the
 * pass count's meaning. Only a pass advances the two-passes-in-a-row that resolves the
 * top of the stack or ends the step (CR 117.4).
 */
const applyPriority = (
  state: GameState,
  emitter: EventEmitter,
  decision: Extract<Decision, { kind: 'priority' }>,
  action: PriorityAction,
): GameState => {
  switch (action.kind) {
    case 'pass':
      break;
    case 'playLand':
      // Playing a land is a special action: it uses no stack, so the player simply has
      // priority again afterwards with a shorter list of things they may do.
      return withPriority(
        playLand(state, emitter, decision.player, action.object),
        decision.player,
      );
    case 'cast':
      // `castSpell` hands priority back itself (CR 117.3c), with the options recomputed,
      // because putting a spell on the stack is what restarts the pass count.
      return castSpell(state, emitter, decision.player, action.object, { targets: action.targets });
    case 'activateLoyalty':
      return activateLoyaltyAbility(state, emitter, decision.player, action.object, action.ability);
  }

  const passes = state.passesInARow + 1;
  if (passes < playerIds.length) {
    return grantPriority(updateState(state, { passesInARow: passes }), opponentOf(decision.player));
  }

  if (isStackEmpty(state)) {
    return leaveStep(updateState(state, { passesInARow: 0, priority: null }), emitter);
  }

  // The active player receives priority after something resolves (CR 117.3b). Set that
  // before resolving, so that a resolution paused by a replacement choice resumes with
  // priority in the right place rather than back with whoever passed.
  const resolved = resolveTop(
    updateState(state, { passesInARow: 0, priority: state.activePlayer }),
    emitter,
  );
  // CR 117.5: before anyone actually receives priority, state-based actions are checked
  // and anything that has triggered goes on the stack. `advanceToDecision` is the one
  // place that does all of it in order — and `applyDecision` calls it on whatever this
  // returns, so resolution hands the state back rather than running it forward here.
  //
  // It used to call `advanceToDecision` itself when nothing was pending, and then
  // `applyDecision` called it a second time on the result. Both calls settle on the same
  // position, and the second one hashed it again — so loop detection saw every
  // post-resolution position twice and called the game a draw. Nothing could reach it
  // until 4.2 let a fuzz game put a spell on the stack, and the default threshold of two
  // hundred decisions a turn hid it from every game but an eagerly-checked one.
  return resolved;
};

/** Put one player's queued triggers on the stack in the order they chose. */
const stackTriggersInOrder = (
  state: GameState,
  emitter: EventEmitter,
  player: PlayerId,
  order: readonly string[],
): GameState => {
  const mine = state.pendingTriggers.filter((trigger) => trigger.controller === player);
  if (order.length !== mine.length) {
    throw new UnexpectedDecisionError(
      `expected an order over ${mine.length} trigger(s), got ${order.length}`,
    );
  }

  const remaining = [...mine];
  let current = state;
  for (const abilityId of order) {
    const index = remaining.findIndex((trigger) => trigger.abilityId === abilityId);
    if (index === -1) {
      throw new UnexpectedDecisionError(`no queued trigger with id "${abilityId}"`);
    }
    const [trigger] = remaining.splice(index, 1);
    if (trigger) current = stackOneTrigger(current, emitter, trigger);
  }
  return current;
};

// --- Driving a whole game, for tests and the random agent ---

export interface AutoPlayOptions {
  /** Which cards to pitch to a discard decision; defaults to the first ones in hand. */
  readonly chooseDiscards?: (
    decision: Extract<Decision, { kind: 'discard' }>,
  ) => readonly ObjectId[];
  /** Whether to mulligan a given opening hand; defaults to keeping whatever is dealt. */
  readonly mulligan?: (decision: Extract<Decision, { kind: 'mulligan' }>) => 'keep' | 'mulligan';
  readonly limit?: number;
}

/**
 * Drive a game to its end, answering every decision in the simplest legal way: pass
 * priority, discard the first cards in hand, decline to attack or block, and take
 * whatever order is offered. Used by tests and, in roadmap 1.13, by the invariant fuzzer,
 * so it must be able to answer *every* decision kind rather than the couple it started
 * with — an unanswerable decision would look like an engine hang.
 */
export const runUntilGameOver = (
  state: GameState,
  emitter: EventEmitter,
  options: AutoPlayOptions = {},
): GameState => {
  const limit = options.limit ?? 100_000;
  let current = state;

  for (let i = 0; i < limit && !isGameOver(current); i += 1) {
    const decision = current.pendingDecision;
    if (!decision) {
      current = advanceToDecision(current, emitter);
      continue;
    }

    current = applyDecision(current, emitter, defaultAnswer(decision, options));
  }
  return current;
};

const defaultAnswer = (decision: Decision, options: AutoPlayOptions): DecisionResponse => {
  switch (decision.kind) {
    case 'discard':
      return {
        kind: 'discard',
        cards: (options.chooseDiscards ?? ((d) => d.from.slice(0, d.count)))(decision),
      };
    case 'declareAttackers':
      return { kind: 'declareAttackers', attackers: [] };
    case 'declareBlockers':
      return { kind: 'declareBlockers', blocks: [] };
    case 'orderBlockers':
      return { kind: 'orderBlockers', order: decision.blockers };
    case 'orderTriggers':
      return { kind: 'orderTriggers', order: decision.triggers };
    case 'chooseOption': {
      const [first] = decision.options;
      if (first === undefined) throw new Error('a chooseOption decision offered nothing');
      return { kind: 'chooseOption', chosen: first };
    }
    case 'chooseReplacement': {
      const [first] = decision.options;
      if (first === undefined) throw new Error('a chooseReplacement decision offered nothing');
      return { kind: 'chooseReplacement', effect: first };
    }
    case 'mulligan':
      return { kind: 'mulligan', action: options.mulligan?.(decision) ?? 'keep' };
    case 'bottomCards':
      return { kind: 'bottomCards', cards: decision.from.slice(0, decision.count) };
    default:
      return { kind: 'priority', action: { kind: 'pass' } };
  }
};

/** Drive the game forward, passing priority, until `step` begins. For tests. */
export const advanceToStep = (
  state: GameState,
  emitter: EventEmitter,
  step: Step,
  limit = 2_000,
): GameState => {
  let current = state;
  for (let i = 0; i < limit; i += 1) {
    if (current.step === step && current.pendingDecision !== null) return current;
    if (isGameOver(current)) throw new Error(`the game ended before reaching ${step}`);
    current = applyDecision(current, emitter, { kind: 'priority', action: { kind: 'pass' } });
  }
  throw new Error(`did not reach ${step} within ${limit} decisions`);
};
