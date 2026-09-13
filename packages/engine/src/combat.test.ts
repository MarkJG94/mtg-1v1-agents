import { asOracleId, type ObjectId, type PlayerId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import {
  assignCombatDamage,
  availableBlockers,
  canBlock,
  dealCombatDamage,
  declareAttackers,
  declareBlockers,
  endCombat,
  IllegalCombatError,
  legalAttackers,
  needsFirstStrikeStep,
  orderBlockers,
} from './combat.js';
import { createEventEmitter, type EventEmitter } from './events/emitter.js';
import { stateFromSeed } from './rng.js';
import { createGameState, type GameState } from './state/game-state.js';
import { createObject, getObject, updateObject } from './state/update.js';
import { type Keywords, keywords } from './targeting.js';

const creature = asOracleId('oracle-creature');

interface Spec {
  readonly power: number;
  readonly toughness: number;
  readonly keywords?: Partial<Keywords>;
  readonly tapped?: boolean;
  readonly summoningSick?: boolean;
}

/** Build a board: A's creatures attack, B's block. A is the active player. */
const board = (a: readonly Spec[], b: readonly Spec[] = []) => {
  let state: GameState = createGameState({ rng: stateFromSeed('1'), onPlay: 'A' });
  state = { ...state, turn: 1, step: 'declareAttackers' };

  const make = (owner: PlayerId, spec: Spec): ObjectId => {
    const created = createObject(state, {
      definitionId: creature,
      owner,
      zone: 'battlefield',
      power: spec.power,
      toughness: spec.toughness,
      keywords: keywords(spec.keywords ?? {}),
    });
    state = updateObject(created.state, created.object.id, {
      tapped: spec.tapped ?? false,
      summoningSick: spec.summoningSick ?? false,
    });
    return created.object.id;
  };

  const mine = a.map((spec) => make('A', spec));
  const theirs = b.map((spec) => make('B', spec));
  return { state, mine, theirs, emitter: createEventEmitter() };
};

const defenderB = { kind: 'player', player: 'B' } as const;

const attackWith = (
  state: GameState,
  emitter: EventEmitter,
  attackers: readonly ObjectId[],
): GameState =>
  declareAttackers(
    state,
    emitter,
    attackers.map((attacker) => ({ attacker, defender: defenderB })),
  );

describe('declaring attackers (CR 508)', () => {
  it('offers an untapped, settled creature', () => {
    const { state, mine } = board([{ power: 2, toughness: 2 }]);
    expect(legalAttackers(state)).toEqual(mine);
  });

  it('refuses a tapped creature', () => {
    const { state } = board([{ power: 2, toughness: 2, tapped: true }]);
    expect(legalAttackers(state)).toEqual([]);
  });

  it('refuses a summoning-sick creature (CR 302.6)', () => {
    const { state } = board([{ power: 2, toughness: 2, summoningSick: true }]);
    expect(legalAttackers(state)).toEqual([]);
  });

  it('allows a summoning-sick creature with haste (CR 702.10)', () => {
    const { state, mine } = board([
      { power: 2, toughness: 2, summoningSick: true, keywords: { haste: true } },
    ]);
    expect(legalAttackers(state)).toEqual(mine);
  });

  it('refuses a creature with defender (CR 702.3)', () => {
    const { state } = board([{ power: 0, toughness: 4, keywords: { defender: true } }]);
    expect(legalAttackers(state)).toEqual([]);
  });

  it('refuses the opponent’s creatures', () => {
    const { state } = board([], [{ power: 2, toughness: 2 }]);
    expect(legalAttackers(state)).toEqual([]);
  });

  it('taps the attackers', () => {
    const { state, emitter, mine } = board([{ power: 2, toughness: 2 }]);
    const attacking = attackWith(state, emitter, mine);
    expect(getObject(attacking, mine[0] as ObjectId).tapped).toBe(true);
  });

  it('leaves a vigilant attacker untapped (CR 702.20)', () => {
    const { state, emitter, mine } = board([
      { power: 2, toughness: 2, keywords: { vigilance: true } },
    ]);
    const attacking = attackWith(state, emitter, mine);
    expect(getObject(attacking, mine[0] as ObjectId).tapped).toBe(false);
  });

  it('records the attack and emits an attack event', () => {
    const { state, emitter, mine } = board([{ power: 2, toughness: 2 }]);
    const attacking = attackWith(state, emitter, mine);
    expect(attacking.combat?.attackers).toHaveLength(1);
    expect(emitter.events.some((event) => event.type === 'attack')).toBe(true);
  });

  it('refuses an illegal attacker', () => {
    const { state, emitter, mine } = board([{ power: 2, toughness: 2, tapped: true }]);
    expect(() => attackWith(state, emitter, mine)).toThrow(IllegalCombatError);
  });

  it('refuses the same creature twice', () => {
    const { state, emitter, mine } = board([{ power: 2, toughness: 2 }]);
    const twice = [mine[0] as ObjectId, mine[0] as ObjectId];
    expect(() => attackWith(state, emitter, twice)).toThrow(/twice/);
  });
});

describe('declaring blockers (CR 509)', () => {
  it('lets an untapped defender block', () => {
    const { state, emitter, mine, theirs } = board(
      [{ power: 2, toughness: 2 }],
      [{ power: 1, toughness: 1 }],
    );
    const attacking = attackWith(state, emitter, mine);
    expect(availableBlockers(attacking)).toEqual(theirs);
    expect(canBlock(attacking, theirs[0] as ObjectId, mine[0] as ObjectId)).toBe(true);
  });

  it('refuses a tapped blocker', () => {
    const { state, emitter, mine, theirs } = board(
      [{ power: 2, toughness: 2 }],
      [{ power: 1, toughness: 1, tapped: true }],
    );
    const attacking = attackWith(state, emitter, mine);
    expect(canBlock(attacking, theirs[0] as ObjectId, mine[0] as ObjectId)).toBe(false);
  });

  it('stops a ground creature blocking a flyer (CR 702.9b)', () => {
    const { state, emitter, mine, theirs } = board(
      [{ power: 2, toughness: 2, keywords: { flying: true } }],
      [{ power: 1, toughness: 1 }],
    );
    const attacking = attackWith(state, emitter, mine);
    expect(canBlock(attacking, theirs[0] as ObjectId, mine[0] as ObjectId)).toBe(false);
  });

  it('lets a flyer block a flyer', () => {
    const { state, emitter, mine, theirs } = board(
      [{ power: 2, toughness: 2, keywords: { flying: true } }],
      [{ power: 1, toughness: 1, keywords: { flying: true } }],
    );
    const attacking = attackWith(state, emitter, mine);
    expect(canBlock(attacking, theirs[0] as ObjectId, mine[0] as ObjectId)).toBe(true);
  });

  it('lets reach block a flyer (CR 702.17)', () => {
    const { state, emitter, mine, theirs } = board(
      [{ power: 2, toughness: 2, keywords: { flying: true } }],
      [{ power: 1, toughness: 1, keywords: { reach: true } }],
    );
    const attacking = attackWith(state, emitter, mine);
    expect(canBlock(attacking, theirs[0] as ObjectId, mine[0] as ObjectId)).toBe(true);
  });

  it('refuses a single block on a creature with menace (CR 702.110b)', () => {
    const { state, emitter, mine, theirs } = board(
      [{ power: 3, toughness: 3, keywords: { menace: true } }],
      [
        { power: 1, toughness: 1 },
        { power: 1, toughness: 1 },
      ],
    );
    const attacking = attackWith(state, emitter, mine);
    expect(() =>
      declareBlockers(attacking, emitter, [
        { blocker: theirs[0] as ObjectId, blocking: [mine[0] as ObjectId] },
      ]),
    ).toThrow(/menace/);
  });

  it('allows a double block on menace', () => {
    const { state, emitter, mine, theirs } = board(
      [{ power: 3, toughness: 3, keywords: { menace: true } }],
      [
        { power: 1, toughness: 1 },
        { power: 1, toughness: 1 },
      ],
    );
    const attacking = attackWith(state, emitter, mine);
    const blocked = declareBlockers(attacking, emitter, [
      { blocker: theirs[0] as ObjectId, blocking: [mine[0] as ObjectId] },
      { blocker: theirs[1] as ObjectId, blocking: [mine[0] as ObjectId] },
    ]);
    expect(blocked.combat?.attackers[0]?.blockedBy).toHaveLength(2);
  });

  it('marks the attacker blocked', () => {
    const { state, emitter, mine, theirs } = board(
      [{ power: 2, toughness: 2 }],
      [{ power: 1, toughness: 1 }],
    );
    const blocked = declareBlockers(attackWith(state, emitter, mine), emitter, [
      { blocker: theirs[0] as ObjectId, blocking: [mine[0] as ObjectId] },
    ]);
    expect(blocked.combat?.attackers[0]?.blocked).toBe(true);
  });

  it('settles the damage order automatically for a single blocker', () => {
    const { state, emitter, mine, theirs } = board(
      [{ power: 2, toughness: 2 }],
      [{ power: 1, toughness: 1 }],
    );
    const blocked = declareBlockers(attackWith(state, emitter, mine), emitter, [
      { blocker: theirs[0] as ObjectId, blocking: [mine[0] as ObjectId] },
    ]);
    expect(blocked.combat?.attackers[0]?.orderSettled).toBe(true);
  });

  it('leaves the order unsettled for a double block', () => {
    const { state, emitter, mine, theirs } = board(
      [{ power: 3, toughness: 3 }],
      [
        { power: 1, toughness: 1 },
        { power: 1, toughness: 1 },
      ],
    );
    const blocked = declareBlockers(attackWith(state, emitter, mine), emitter, [
      { blocker: theirs[0] as ObjectId, blocking: [mine[0] as ObjectId] },
      { blocker: theirs[1] as ObjectId, blocking: [mine[0] as ObjectId] },
    ]);
    expect(blocked.combat?.attackers[0]?.orderSettled).toBe(false);
  });

  it('refuses the same blocker twice', () => {
    const { state, emitter, mine, theirs } = board(
      [{ power: 2, toughness: 2 }],
      [{ power: 1, toughness: 1 }],
    );
    const attacking = attackWith(state, emitter, mine);
    expect(() =>
      declareBlockers(attacking, emitter, [
        { blocker: theirs[0] as ObjectId, blocking: [mine[0] as ObjectId] },
        { blocker: theirs[0] as ObjectId, blocking: [mine[0] as ObjectId] },
      ]),
    ).toThrow(/twice/);
  });
});

describe('ordering blockers (CR 509.2)', () => {
  const doubleBlock = () => {
    const built = board(
      [{ power: 3, toughness: 3 }],
      [
        { power: 1, toughness: 1 },
        { power: 1, toughness: 1 },
      ],
    );
    const blocked = declareBlockers(
      attackWith(built.state, built.emitter, built.mine),
      built.emitter,
      [
        { blocker: built.theirs[0] as ObjectId, blocking: [built.mine[0] as ObjectId] },
        { blocker: built.theirs[1] as ObjectId, blocking: [built.mine[0] as ObjectId] },
      ],
    );
    return { ...built, state: blocked };
  };

  it('reorders the blockers and settles the order', () => {
    const { state, mine, theirs } = doubleBlock();
    const reversed = [theirs[1] as ObjectId, theirs[0] as ObjectId];
    const ordered = orderBlockers(state, mine[0] as ObjectId, reversed);
    expect(ordered.combat?.attackers[0]?.blockedBy).toEqual(reversed);
    expect(ordered.combat?.attackers[0]?.orderSettled).toBe(true);
  });

  it('refuses an order that is not a permutation of the blockers', () => {
    const { state, mine, theirs } = doubleBlock();
    expect(() => orderBlockers(state, mine[0] as ObjectId, [theirs[0] as ObjectId])).toThrow(
      /permutation/,
    );
  });
});

describe('the first-strike damage step (CR 510.4)', () => {
  const attacking = (specs: readonly Spec[]) => {
    const built = board(specs);
    return attackWith(built.state, built.emitter, built.mine);
  };

  it('does not happen with no first or double strikers', () => {
    expect(needsFirstStrikeStep(attacking([{ power: 2, toughness: 2 }]))).toBe(false);
  });

  it('happens when an attacker has first strike', () => {
    expect(
      needsFirstStrikeStep(
        attacking([{ power: 2, toughness: 2, keywords: { firstStrike: true } }]),
      ),
    ).toBe(true);
  });

  it('happens when an attacker has double strike', () => {
    expect(
      needsFirstStrikeStep(
        attacking([{ power: 2, toughness: 2, keywords: { doubleStrike: true } }]),
      ),
    ).toBe(true);
  });

  it('happens when a blocker has first strike', () => {
    const built = board(
      [{ power: 2, toughness: 2 }],
      [{ power: 1, toughness: 1, keywords: { firstStrike: true } }],
    );
    const blocked = declareBlockers(
      attackWith(built.state, built.emitter, built.mine),
      built.emitter,
      [{ blocker: built.theirs[0] as ObjectId, blocking: [built.mine[0] as ObjectId] }],
    );
    expect(needsFirstStrikeStep(blocked)).toBe(true);
  });
});

describe('combat damage (CR 510)', () => {
  const attackAndBlock = (a: readonly Spec[], b: readonly Spec[], block = true) => {
    const built = board(a, b);
    let state = attackWith(built.state, built.emitter, built.mine);
    if (block && built.theirs.length > 0) {
      state = declareBlockers(
        state,
        built.emitter,
        built.theirs.map((blocker) => ({ blocker, blocking: [built.mine[0] as ObjectId] })),
      );
    }
    return { ...built, state };
  };

  it('an unblocked attacker damages the defending player', () => {
    const { state, emitter } = attackAndBlock([{ power: 3, toughness: 3 }], []);
    const after = dealCombatDamage(state, emitter, false);
    expect(after.players.B.life).toBe(17);
  });

  it('a blocked attacker deals no damage to the player', () => {
    const { state, emitter } = attackAndBlock(
      [{ power: 3, toughness: 3 }],
      [{ power: 1, toughness: 1 }],
    );
    const after = dealCombatDamage(state, emitter, false);
    expect(after.players.B.life).toBe(20);
  });

  it('attacker and blocker damage each other simultaneously, so they trade', () => {
    const { state, emitter, mine, theirs } = attackAndBlock(
      [{ power: 2, toughness: 2 }],
      [{ power: 2, toughness: 2 }],
    );
    const after = dealCombatDamage(state, emitter, false);
    // Neither dies here — that is a state-based action in 1.7 — but both are marked.
    expect(getObject(after, mine[0] as ObjectId).damage).toBe(2);
    expect(getObject(after, theirs[0] as ObjectId).damage).toBe(2);
  });

  it('trample carries the excess to the player (CR 702.19b)', () => {
    const { state, emitter, theirs } = attackAndBlock(
      [{ power: 5, toughness: 5, keywords: { trample: true } }],
      [{ power: 1, toughness: 2 }],
    );
    const after = dealCombatDamage(state, emitter, false);
    expect(getObject(after, theirs[0] as ObjectId).damage).toBe(2);
    expect(after.players.B.life).toBe(17);
  });

  it('without trample the whole attack stays on the blocker', () => {
    const { state, emitter, theirs } = attackAndBlock(
      [{ power: 5, toughness: 5 }],
      [{ power: 1, toughness: 2 }],
    );
    const after = dealCombatDamage(state, emitter, false);
    expect(getObject(after, theirs[0] as ObjectId).damage).toBe(5);
    expect(after.players.B.life).toBe(20);
  });

  it('deathtouch makes one point lethal, so trample carries the rest (CR 702.2b)', () => {
    const { state, emitter, theirs } = attackAndBlock(
      [{ power: 5, toughness: 5, keywords: { trample: true, deathtouch: true } }],
      [{ power: 1, toughness: 4 }],
    );
    const after = dealCombatDamage(state, emitter, false);
    expect(getObject(after, theirs[0] as ObjectId).damage).toBe(1);
    expect(after.players.B.life).toBe(16);
  });

  it('lifelink gains life as the damage is dealt (CR 702.15a)', () => {
    const { state, emitter } = attackAndBlock(
      [{ power: 3, toughness: 3, keywords: { lifelink: true } }],
      [],
    );
    const after = dealCombatDamage(state, emitter, false);
    expect(after.players.A.life).toBe(23);
    expect(after.players.B.life).toBe(17);
  });

  it('lifelink counts damage dealt to a blocker too', () => {
    const { state, emitter } = attackAndBlock(
      [{ power: 3, toughness: 3, keywords: { lifelink: true } }],
      [{ power: 1, toughness: 5 }],
    );
    expect(dealCombatDamage(state, emitter, false).players.A.life).toBe(23);
  });

  it('assigns lethal down the damage order before moving on (CR 510.1a)', () => {
    const built = board(
      [{ power: 3, toughness: 3 }],
      [
        { power: 1, toughness: 2 },
        { power: 1, toughness: 2 },
      ],
    );
    const blocked = declareBlockers(
      attackWith(built.state, built.emitter, built.mine),
      built.emitter,
      [
        { blocker: built.theirs[0] as ObjectId, blocking: [built.mine[0] as ObjectId] },
        { blocker: built.theirs[1] as ObjectId, blocking: [built.mine[0] as ObjectId] },
      ],
    );
    const after = dealCombatDamage(blocked, built.emitter, false);
    // First blocker takes lethal (2), the last soaks up the remainder (1).
    expect(getObject(after, built.theirs[0] as ObjectId).damage).toBe(2);
    expect(getObject(after, built.theirs[1] as ObjectId).damage).toBe(1);
  });

  it('a first striker deals damage in the first step and not the second', () => {
    const { state, emitter, theirs } = attackAndBlock(
      [{ power: 2, toughness: 2, keywords: { firstStrike: true } }],
      [{ power: 2, toughness: 2 }],
    );
    const firstStep = dealCombatDamage(state, emitter, true);
    expect(getObject(firstStep, theirs[0] as ObjectId).damage).toBe(2);

    const secondStep = dealCombatDamage(firstStep, emitter, false);
    expect(getObject(secondStep, theirs[0] as ObjectId).damage).toBe(2);
  });

  it('an ordinary creature deals nothing in the first-strike step', () => {
    const { state, emitter, theirs } = attackAndBlock(
      [{ power: 2, toughness: 2 }],
      [{ power: 2, toughness: 2 }],
    );
    expect(getObject(dealCombatDamage(state, emitter, true), theirs[0] as ObjectId).damage).toBe(0);
  });

  it('double strike deals damage in both steps (CR 702.4b)', () => {
    const { state, emitter, theirs } = attackAndBlock(
      [{ power: 2, toughness: 2, keywords: { doubleStrike: true } }],
      [{ power: 1, toughness: 9 }],
    );
    const firstStep = dealCombatDamage(state, emitter, true);
    expect(getObject(firstStep, theirs[0] as ObjectId).damage).toBe(2);
    const secondStep = dealCombatDamage(firstStep, emitter, false);
    expect(getObject(secondStep, theirs[0] as ObjectId).damage).toBe(4);
  });

  it('emits a combatDamage marker and a damage event per assignment', () => {
    const { state, emitter } = attackAndBlock([{ power: 3, toughness: 3 }], []);
    dealCombatDamage(state, emitter, false);
    expect(emitter.events.some((event) => event.type === 'combatDamage')).toBe(true);
    expect(emitter.events.filter((event) => event.type === 'damage')).toHaveLength(1);
  });

  it('a zero-power creature deals no damage at all', () => {
    const { state, emitter } = attackAndBlock([{ power: 0, toughness: 4 }], []);
    const after = dealCombatDamage(state, emitter, false);
    expect(after.players.B.life).toBe(20);
    expect(emitter.events.filter((event) => event.type === 'damage')).toHaveLength(0);
  });

  it('damage already marked counts toward lethal within the turn', () => {
    const built = board(
      [{ power: 4, toughness: 4, keywords: { trample: true } }],
      [{ power: 1, toughness: 3 }],
    );
    const hurt = updateObject(built.state, built.theirs[0] as ObjectId, { damage: 1 });
    const blocked = declareBlockers(attackWith(hurt, built.emitter, built.mine), built.emitter, [
      { blocker: built.theirs[0] as ObjectId, blocking: [built.mine[0] as ObjectId] },
    ]);
    const after = dealCombatDamage(blocked, built.emitter, false);
    // Two more damage is lethal on a 3-toughness creature already marked with one.
    expect(after.players.B.life).toBe(18);
  });
});

describe('an attacker whose blockers have all gone (CR 509.1h)', () => {
  it('still deals no damage to the player', () => {
    const built = board([{ power: 3, toughness: 3 }], [{ power: 1, toughness: 1 }]);
    let state = declareBlockers(attackWith(built.state, built.emitter, built.mine), built.emitter, [
      { blocker: built.theirs[0] as ObjectId, blocking: [built.mine[0] as ObjectId] },
    ]);
    // The blocker leaves before damage.
    state = updateObject(state, built.theirs[0] as ObjectId, { zone: 'B:graveyard' });
    expect(assignCombatDamage(state, false)).toEqual([]);
  });

  it('unless it has trample, which then hits the player in full', () => {
    const built = board(
      [{ power: 3, toughness: 3, keywords: { trample: true } }],
      [{ power: 1, toughness: 1 }],
    );
    let state = declareBlockers(attackWith(built.state, built.emitter, built.mine), built.emitter, [
      { blocker: built.theirs[0] as ObjectId, blocking: [built.mine[0] as ObjectId] },
    ]);
    state = updateObject(state, built.theirs[0] as ObjectId, { zone: 'B:graveyard' });
    expect(dealCombatDamage(state, built.emitter, false).players.B.life).toBe(17);
  });
});

describe('end of combat (CR 511.3)', () => {
  it('clears the combat state', () => {
    const { state, emitter, mine } = board([{ power: 2, toughness: 2 }]);
    const attacking = attackWith(state, emitter, mine);
    expect(attacking.combat).not.toBeNull();
    expect(endCombat(attacking).combat).toBeNull();
  });
});
