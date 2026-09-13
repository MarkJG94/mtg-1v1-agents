import { type EventTarget, type ObjectId, opponentOf, type PlayerId } from '@mtg/shared';
import { effectivePower, isCreature, remainingToughness } from './characteristics.js';
import type { EventEmitter } from './events/emitter.js';
import type { GameState } from './state/game-state.js';
import type { GameObject } from './state/object.js';
import { getObject, objectsIn, updateObjects, updatePlayer, updateState } from './state/update.js';
import { canBeTargeted } from './targeting.js';

/**
 * Combat (CR 506-511).
 *
 * A sub-state machine hanging off the combat steps: attackers are declared and tapped,
 * blockers are declared and ordered, and then damage is dealt — once in the first-strike
 * step if anyone has first or double strike, and once in the regular step.
 *
 * Damage is applied as one batch rather than creature by creature. That is not a
 * micro-optimisation: it is what makes two creatures with lethal damage trade instead of
 * the first one dying and its damage never being dealt, and it is why lifelink and
 * deathtouch interact correctly with the state-based actions that follow in roadmap 1.7.
 */

export interface AttackerState {
  readonly attacker: ObjectId;
  /** A player, or later a planeswalker (roadmap 1.11). */
  readonly defender: EventTarget;
  /** Blockers in damage-assignment order (CR 509.2), empty if never blocked. */
  readonly blockedBy: readonly ObjectId[];
  /**
   * Once blocked, a creature stays blocked even if every blocker leaves combat
   * (CR 509.1h), so it deals no damage to the player. That is why this is tracked
   * separately from `blockedBy` being empty.
   */
  readonly blocked: boolean;
  /**
   * Whether the damage-assignment order is settled. True as soon as blockers are
   * declared when there are fewer than two of them, since then there is nothing to
   * order. Kept in the state rather than alongside it so a cloned or replayed game
   * behaves identically.
   */
  readonly orderSettled: boolean;
}

export interface CombatState {
  readonly attackers: readonly AttackerState[];
  readonly firstStrikeDone: boolean;
}

export const emptyCombat: CombatState = Object.freeze({
  attackers: Object.freeze([]),
  firstStrikeDone: false,
});

export class IllegalCombatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalCombatError';
  }
}

// --- Declaring attackers (CR 508) ---

/**
 * Creatures the active player could declare as attackers: their own untapped creatures
 * that are not summoning sick and do not have defender.
 */
export const legalAttackers = (state: GameState): readonly ObjectId[] =>
  objectsIn(state, 'battlefield').filter((id) => {
    const object = getObject(state, id);
    return (
      isCreature(object) &&
      object.controller === state.activePlayer &&
      !object.tapped &&
      !object.keywords.defender &&
      (!object.summoningSick || object.keywords.haste)
    );
  });

/**
 * Declare attackers (CR 508.1). Attacking taps each attacker unless it has vigilance
 * (CR 702.20), and attacking is not targeting, so hexproof and shroud do not apply.
 */
export const declareAttackers = (
  state: GameState,
  emitter: EventEmitter,
  declarations: readonly { readonly attacker: ObjectId; readonly defender: EventTarget }[],
): GameState => {
  const legal = new Set(legalAttackers(state));
  const seen = new Set<ObjectId>();

  for (const { attacker } of declarations) {
    if (!legal.has(attacker)) {
      throw new IllegalCombatError(`object ${attacker} cannot attack`);
    }
    if (seen.has(attacker)) {
      throw new IllegalCombatError(`object ${attacker} was declared as an attacker twice`);
    }
    seen.add(attacker);
  }

  const attackers: AttackerState[] = declarations.map(({ attacker, defender }) => ({
    attacker,
    defender,
    blockedBy: [],
    blocked: false,
    orderSettled: true,
  }));

  // Tap the attackers that do not have vigilance.
  const toTap = declarations
    .map(({ attacker }) => attacker)
    .filter((id) => !getObject(state, id).keywords.vigilance);
  let next = updateObjects(
    state,
    toTap.map((id) => [id, { tapped: true }] as const),
  );

  next = updateState(next, { combat: { attackers, firstStrikeDone: false } });

  for (const { attacker, defender } of declarations) {
    emitter.emit(next, { type: 'attack', attacker, defender });
  }
  for (const id of toTap) emitter.emit(next, { type: 'tap', object: id });

  return next;
};

// --- Declaring blockers (CR 509) ---

/** The player being attacked; in a two-player game, whoever is not the active player. */
export const defendingPlayer = (state: GameState): PlayerId => opponentOf(state.activePlayer);

/** Creatures that could block at all: the defender's untapped creatures. */
export const availableBlockers = (state: GameState): readonly ObjectId[] => {
  const defender = defendingPlayer(state);
  return objectsIn(state, 'battlefield').filter((id) => {
    const object = getObject(state, id);
    return isCreature(object) && object.controller === defender && !object.tapped;
  });
};

/**
 * Whether one creature may block one attacker, ignoring how many others also block it
 * (CR 509.1b). Evasion is checked here: flying needs flying or reach to block it
 * (CR 702.9b), and protection stops a blocker of the protected-from colour (CR 702.16e).
 */
export const canBlock = (state: GameState, blocker: ObjectId, attacker: ObjectId): boolean => {
  const blocking = getObject(state, blocker);
  const attacking = getObject(state, attacker);

  if (!isCreature(blocking) || !isCreature(attacking) || blocking.tapped) return false;
  if (blocking.controller !== defendingPlayer(state)) return false;
  if (attacking.keywords.flying && !(blocking.keywords.flying || blocking.keywords.reach)) {
    return false;
  }

  // Protection stops the protected creature being blocked by that colour, which here is
  // the attacker's protection against its would-be blocker.
  const blockerColours = blocking.keywords.protectionFrom;
  if (attacking.keywords.protectionFrom.length > 0 || blockerColours.length > 0) {
    // Colours of a creature are a characteristic; until 2.1 supplies them, protection in
    // combat is decided by the same check targeting uses, with no colours to match.
    const legality = canBeTargeted(
      state,
      { kind: 'object', object: attacker },
      {
        controller: blocking.controller,
        colours: [],
      },
    );
    if (!legality.legal && legality.reason === 'protection') return false;
  }

  return true;
};

/** The attackers a given creature could legally block. */
export const legalBlocksFor = (state: GameState, blocker: ObjectId): readonly ObjectId[] =>
  (state.combat?.attackers ?? [])
    .map((entry) => entry.attacker)
    .filter((attacker) => canBlock(state, blocker, attacker));

export interface BlockDeclaration {
  readonly blocker: ObjectId;
  /** Blocking several attackers at once needs an effect; normally exactly one. */
  readonly blocking: readonly ObjectId[];
}

/**
 * Declare blockers (CR 509.1). Menace is checked across the whole declaration rather than
 * per blocker: a creature with menace can't be blocked except by two or more creatures
 * (CR 702.110b), which is only knowable once every block is on the table.
 */
export const declareBlockers = (
  state: GameState,
  emitter: EventEmitter,
  declarations: readonly BlockDeclaration[],
): GameState => {
  const combat = state.combat;
  if (!combat) throw new IllegalCombatError('no combat is in progress');

  const blockersOf = new Map<ObjectId, ObjectId[]>();
  const seen = new Set<ObjectId>();

  for (const { blocker, blocking } of declarations) {
    if (seen.has(blocker)) {
      throw new IllegalCombatError(`creature ${blocker} was declared as a blocker twice`);
    }
    seen.add(blocker);

    for (const attacker of blocking) {
      if (!canBlock(state, blocker, attacker)) {
        throw new IllegalCombatError(`creature ${blocker} cannot block ${attacker}`);
      }
      const existing = blockersOf.get(attacker);
      if (existing) existing.push(blocker);
      else blockersOf.set(attacker, [blocker]);
    }
  }

  for (const [attacker, blockers] of blockersOf) {
    if (getObject(state, attacker).keywords.menace && blockers.length < 2) {
      throw new IllegalCombatError(
        `creature ${attacker} has menace and cannot be blocked by only one creature`,
      );
    }
  }

  const attackers = combat.attackers.map((entry) => {
    const blockers = blockersOf.get(entry.attacker) ?? [];
    return blockers.length === 0
      ? entry
      : { ...entry, blockedBy: blockers, blocked: true, orderSettled: blockers.length < 2 };
  });

  const next = updateState(state, { combat: { ...combat, attackers } });
  for (const { blocker, blocking } of declarations) {
    if (blocking.length > 0) emitter.emit(next, { type: 'block', blocker, blocking });
  }
  return next;
};

/** Reorder the blockers of one attacker for damage assignment (CR 509.2). */
export const orderBlockers = (
  state: GameState,
  attacker: ObjectId,
  order: readonly ObjectId[],
): GameState => {
  const combat = state.combat;
  if (!combat) throw new IllegalCombatError('no combat is in progress');

  const entry = combat.attackers.find((candidate) => candidate.attacker === attacker);
  if (!entry) throw new IllegalCombatError(`object ${attacker} is not attacking`);

  const current = [...entry.blockedBy].sort();
  if (
    order.length !== entry.blockedBy.length ||
    ![...order].sort().every((id, i) => id === current[i])
  ) {
    throw new IllegalCombatError(`the order must be a permutation of ${attacker}'s blockers`);
  }

  const attackers = combat.attackers.map((candidate) =>
    candidate.attacker === attacker
      ? { ...candidate, blockedBy: order, orderSettled: true }
      : candidate,
  );
  return updateState(state, { combat: { ...combat, attackers } });
};

/**
 * Attackers still waiting for a damage-assignment order: blocked by two or more creatures
 * and not yet ordered.
 */
export const attackersNeedingOrder = (state: GameState): readonly ObjectId[] =>
  (state.combat?.attackers ?? [])
    .filter((entry) => entry.blockedBy.length > 1 && !entry.orderSettled)
    .map((entry) => entry.attacker);

// --- Damage (CR 510) ---

/** Whether this creature deals damage in the given step. */
const dealsDamageIn = (object: GameObject, firstStrikeStep: boolean): boolean => {
  const { firstStrike, doubleStrike } = object.keywords;
  return firstStrikeStep ? firstStrike || doubleStrike : doubleStrike || !firstStrike;
};

/**
 * Whether a first-strike damage step happens at all (CR 510.4): only if some creature in
 * combat has first or double strike. Without this the step is skipped entirely, which is
 * why `nextStep` consults it.
 */
export const needsFirstStrikeStep = (state: GameState): boolean => {
  const combat = state.combat;
  if (!combat || combat.firstStrikeDone) return false;

  return combat.attackers.some((entry) => {
    const attacker = state.objects.get(entry.attacker);
    if (attacker && (attacker.keywords.firstStrike || attacker.keywords.doubleStrike)) return true;
    return entry.blockedBy.some((id) => {
      const blocker = state.objects.get(id);
      return blocker?.keywords.firstStrike === true || blocker?.keywords.doubleStrike === true;
    });
  });
};

interface DamageAssignment {
  readonly source: ObjectId;
  readonly target: EventTarget;
  readonly amount: number;
  readonly deathtouch: boolean;
  readonly lifelink: boolean;
  readonly controller: PlayerId;
}

/**
 * How much damage an attacker must assign to a blocker before moving to the next
 * (CR 510.1a). Deathtouch makes any single point lethal (CR 702.2b).
 */
const lethalFor = (blocker: GameObject, deathtouch: boolean): number =>
  deathtouch ? 1 : Math.max(0, remainingToughness(blocker));

/**
 * Work out every point of combat damage for one step, without applying any of it.
 *
 * Assignment follows the damage-assignment order: each blocker gets exactly lethal before
 * the next gets any, and whatever is left goes to the last blocker — or, with trample, to
 * the defending player instead (CR 702.19b). That is one of several legal assignments a
 * player could choose; it is the sensible one, and a free-form `assignDamage` decision is
 * a refinement rather than a correctness fix.
 */
export const assignCombatDamage = (
  state: GameState,
  firstStrikeStep: boolean,
): readonly DamageAssignment[] => {
  const combat = state.combat;
  if (!combat) return [];

  const assignments: DamageAssignment[] = [];

  for (const entry of combat.attackers) {
    const attacker = state.objects.get(entry.attacker);
    if (!attacker || !isCreature(attacker) || !dealsDamageIn(attacker, firstStrikeStep)) continue;

    const power = effectivePower(attacker);
    const deathtouch = attacker.keywords.deathtouch;
    const lifelink = attacker.keywords.lifelink;
    const base = { source: entry.attacker, deathtouch, lifelink, controller: attacker.controller };

    // Blockers that are still on the battlefield when damage is dealt.
    const blockers = entry.blockedBy.filter((id) => state.objects.get(id)?.zone === 'battlefield');

    if (!entry.blocked) {
      if (power > 0) assignments.push({ ...base, target: entry.defender, amount: power });
    } else if (blockers.length === 0) {
      // Blocked but every blocker has gone: it deals no damage at all unless it tramples.
      if (attacker.keywords.trample && power > 0) {
        assignments.push({ ...base, target: entry.defender, amount: power });
      }
    } else {
      let remaining = power;
      for (let i = 0; i < blockers.length; i += 1) {
        const id = blockers[i];
        if (id === undefined) continue;
        const blocker = getObject(state, id);
        const isLast = i === blockers.length - 1;
        const lethal = Math.min(remaining, lethalFor(blocker, deathtouch));

        // The last blocker soaks up everything left, unless trample carries it over.
        const amount = isLast && !attacker.keywords.trample ? remaining : lethal;
        if (amount > 0) {
          assignments.push({ ...base, target: { kind: 'object', object: id }, amount });
        }
        remaining -= amount;
        if (remaining <= 0) break;
      }

      if (attacker.keywords.trample && remaining > 0) {
        assignments.push({ ...base, target: entry.defender, amount: remaining });
      }
    }

    // Blockers deal their damage back to the attacker they block.
    for (const id of blockers) {
      const blocker = getObject(state, id);
      if (!dealsDamageIn(blocker, firstStrikeStep)) continue;
      const blockerPower = effectivePower(blocker);
      if (blockerPower <= 0) continue;
      assignments.push({
        source: id,
        target: { kind: 'object', object: entry.attacker },
        amount: blockerPower,
        deathtouch: blocker.keywords.deathtouch,
        lifelink: blocker.keywords.lifelink,
        controller: blocker.controller,
      });
    }
  }

  return assignments;
};

/**
 * Deal one step's combat damage, all at once (CR 510.2). Creatures are only marked here;
 * dying is a state-based action, which roadmap 1.7 adds.
 */
export const dealCombatDamage = (
  state: GameState,
  emitter: EventEmitter,
  firstStrikeStep: boolean,
): GameState => {
  const assignments = assignCombatDamage(state, firstStrikeStep);
  emitter.emit(state, { type: 'combatDamage', firstStrike: firstStrikeStep });
  if (assignments.length === 0) return markFirstStrikeDone(state, firstStrikeStep);

  // Accumulate first, apply once: simultaneity is what makes creatures trade.
  const damageByObject = new Map<ObjectId, number>();
  const deathtouchedObjects = new Set<ObjectId>();
  const lifeByPlayer = new Map<PlayerId, number>();
  const lifeGain = new Map<PlayerId, number>();

  for (const assignment of assignments) {
    if (assignment.target.kind === 'object') {
      const id = assignment.target.object;
      damageByObject.set(id, (damageByObject.get(id) ?? 0) + assignment.amount);
      // Remembered so the state-based action can destroy it even if the damage is not
      // lethal on its own (CR 702.2b).
      if (assignment.deathtouch && assignment.amount > 0) deathtouchedObjects.add(id);
    } else {
      const player = assignment.target.player;
      lifeByPlayer.set(player, (lifeByPlayer.get(player) ?? 0) + assignment.amount);
    }
    if (assignment.lifelink) {
      lifeGain.set(
        assignment.controller,
        (lifeGain.get(assignment.controller) ?? 0) + assignment.amount,
      );
    }
  }

  let next = updateObjects(
    state,
    [...damageByObject].map(
      ([id, amount]) =>
        [
          id,
          {
            damage: getObject(state, id).damage + amount,
            ...(deathtouchedObjects.has(id) ? { deathtouched: true } : {}),
          },
        ] as const,
    ),
  );

  for (const assignment of assignments) {
    emitter.emit(next, {
      type: 'damage',
      source: assignment.source,
      target: assignment.target,
      amount: assignment.amount,
      combat: true,
      ...(assignment.deathtouch ? { deathtouch: true } : {}),
    });
  }

  for (const [player, amount] of lifeByPlayer) {
    const from = next.players[player].life;
    next = updatePlayer(next, player, { life: from - amount });
    emitter.emit(next, { type: 'lifeChange', player, from, to: from - amount, reason: 'combat' });
  }

  // Lifelink is not a trigger: the life is gained as the damage is dealt (CR 702.15a).
  for (const [player, amount] of lifeGain) {
    const from = next.players[player].life;
    next = updatePlayer(next, player, { life: from + amount });
    emitter.emit(next, { type: 'lifeChange', player, from, to: from + amount, reason: 'lifelink' });
  }

  return markFirstStrikeDone(next, firstStrikeStep);
};

const markFirstStrikeDone = (state: GameState, firstStrikeStep: boolean): GameState =>
  firstStrikeStep && state.combat
    ? updateState(state, { combat: { ...state.combat, firstStrikeDone: true } })
    : state;

/** End of combat (CR 511.3): creatures are removed from combat and the state is cleared. */
export const endCombat = (state: GameState): GameState =>
  state.combat === null ? state : updateState(state, { combat: null });
