import { asOracleId, type ObjectId, type PlayerId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { parseManaCost } from './mana/cost.js';
import { stateFromSeed } from './rng.js';
import { createGameState, type GameState } from './state/game-state.js';
import { createObject, updateObject, updatePlayer } from './state/update.js';
import {
  allTargets,
  canBeTargeted,
  isLegalTarget,
  type Keywords,
  legalTargetsAmong,
  noKeywords,
  objectTarget,
  playerTarget,
  wardCostsFor,
} from './targeting.js';

const creature = asOracleId('oracle-creature');

const withCreature = (
  controller: PlayerId,
  keywords: Partial<Keywords> = {},
): { state: GameState; id: ObjectId } => {
  const base = createGameState({ rng: stateFromSeed('1'), onPlay: 'A' });
  const created = createObject(base, {
    definitionId: creature,
    owner: controller,
    zone: 'battlefield',
    keywords: { ...noKeywords, ...keywords },
  });
  return { state: created.state, id: created.object.id };
};

const fromA = { controller: 'A' as PlayerId, colours: [] };
const fromARed = { controller: 'A' as PlayerId, colours: ['R' as const] };

describe('an ordinary permanent', () => {
  it('can be targeted by either player', () => {
    const { state, id } = withCreature('B');
    expect(isLegalTarget(state, objectTarget(id), fromA)).toBe(true);
    expect(isLegalTarget(state, objectTarget(id), { controller: 'B', colours: [] })).toBe(true);
  });

  it('carries no ward cost', () => {
    const { state, id } = withCreature('B');
    expect(canBeTargeted(state, objectTarget(id), fromA)).toEqual({ legal: true, ward: null });
  });
});

describe('shroud (CR 702.18)', () => {
  it('stops an opponent targeting it', () => {
    const { state, id } = withCreature('B', { shroud: true });
    expect(canBeTargeted(state, objectTarget(id), fromA)).toEqual({
      legal: false,
      reason: 'shroud',
    });
  });

  it('stops its own controller targeting it too', () => {
    const { state, id } = withCreature('A', { shroud: true });
    expect(canBeTargeted(state, objectTarget(id), fromA)).toEqual({
      legal: false,
      reason: 'shroud',
    });
  });
});

describe('hexproof (CR 702.11)', () => {
  it('stops an opponent targeting it', () => {
    const { state, id } = withCreature('B', { hexproof: true });
    expect(canBeTargeted(state, objectTarget(id), fromA)).toEqual({
      legal: false,
      reason: 'hexproof',
    });
  });

  it('lets its own controller target it, which is the whole difference from shroud', () => {
    const { state, id } = withCreature('A', { hexproof: true });
    expect(isLegalTarget(state, objectTarget(id), fromA)).toBe(true);
  });
});

describe('protection (CR 702.16)', () => {
  it('stops a source of the named colour', () => {
    const { state, id } = withCreature('B', { protectionFrom: ['R'] });
    expect(canBeTargeted(state, objectTarget(id), fromARed)).toEqual({
      legal: false,
      reason: 'protection',
    });
  });

  it('does not stop a source of another colour', () => {
    const { state, id } = withCreature('B', { protectionFrom: ['R'] });
    expect(isLegalTarget(state, objectTarget(id), { controller: 'A', colours: ['U'] })).toBe(true);
  });

  it('does not stop a colourless source', () => {
    const { state, id } = withCreature('B', { protectionFrom: ['R'] });
    expect(isLegalTarget(state, objectTarget(id), fromA)).toBe(true);
  });

  it('stops a multicoloured source that includes the named colour', () => {
    const { state, id } = withCreature('B', { protectionFrom: ['R'] });
    expect(isLegalTarget(state, objectTarget(id), { controller: 'A', colours: ['U', 'R'] })).toBe(
      false,
    );
  });

  it('stops its own controller as readily as an opponent', () => {
    const { state, id } = withCreature('A', { protectionFrom: ['R'] });
    expect(isLegalTarget(state, objectTarget(id), fromARed)).toBe(false);
  });
});

describe('ward (CR 702.21)', () => {
  const ward = parseManaCost('{2}');

  it('does not make the target illegal, it adds a cost', () => {
    const { state, id } = withCreature('B', { ward });
    expect(canBeTargeted(state, objectTarget(id), fromA)).toEqual({ legal: true, ward });
  });

  it('only applies to an opponent’s spell', () => {
    const { state, id } = withCreature('A', { ward });
    expect(canBeTargeted(state, objectTarget(id), fromA)).toEqual({ legal: true, ward: null });
  });

  it('is reported once per warded target', () => {
    const first = withCreature('B', { ward });
    const second = createObject(first.state, {
      definitionId: creature,
      owner: 'B',
      zone: 'battlefield',
      keywords: { ...noKeywords, ward },
    });
    const targets = [objectTarget(first.id), objectTarget(second.object.id)];
    expect(wardCostsFor(second.state, targets, fromA)).toEqual([ward, ward]);
  });

  it('is not collected for targets that carry none', () => {
    const { state, id } = withCreature('B');
    expect(wardCostsFor(state, [objectTarget(id)], fromA)).toEqual([]);
  });
});

describe('targeting players', () => {
  it('allows it by default', () => {
    const { state } = withCreature('B');
    expect(isLegalTarget(state, playerTarget('B'), fromA)).toBe(true);
  });

  it('respects a player’s hexproof, as Leyline of Sanctity grants', () => {
    const { state } = withCreature('B');
    const protectedPlayer = updatePlayer(state, 'B', {
      keywords: { ...noKeywords, hexproof: true },
    });
    expect(canBeTargeted(protectedPlayer, playerTarget('B'), fromA)).toEqual({
      legal: false,
      reason: 'hexproof',
    });
    // They can still target themselves.
    expect(
      isLegalTarget(protectedPlayer, playerTarget('B'), { controller: 'B', colours: [] }),
    ).toBe(true);
  });
});

describe('an object that has gone', () => {
  it('is not a legal target', () => {
    const { state } = withCreature('B');
    expect(canBeTargeted(state, objectTarget(999 as ObjectId), fromA)).toEqual({
      legal: false,
      reason: 'gone',
    });
  });
});

describe('legalTargetsAmong', () => {
  it('keeps only what may be targeted', () => {
    const plain = withCreature('B');
    const hexproofed = createObject(plain.state, {
      definitionId: creature,
      owner: 'B',
      zone: 'battlefield',
      keywords: { ...noKeywords, hexproof: true },
    });

    const candidates = allTargets(hexproofed.state);
    const legal = legalTargetsAmong(hexproofed.state, candidates, fromA);
    expect(legal).toContainEqual(objectTarget(plain.id));
    expect(legal).not.toContainEqual(objectTarget(hexproofed.object.id));
    expect(legal).toContainEqual(playerTarget('B'));
  });

  it('returns nothing when everything is protected', () => {
    const { state, id } = withCreature('B', { shroud: true });
    const noPlayers = updatePlayer(
      updatePlayer(state, 'A', { keywords: { ...noKeywords, shroud: true } }),
      'B',
      { keywords: { ...noKeywords, shroud: true } },
    );
    expect(legalTargetsAmong(noPlayers, allTargets(noPlayers), fromA)).toEqual([]);
    expect(isLegalTarget(noPlayers, objectTarget(id), fromA)).toBe(false);
  });
});

describe('keywords change with the board', () => {
  it('follows a permanent that gains hexproof', () => {
    const { state, id } = withCreature('B');
    expect(isLegalTarget(state, objectTarget(id), fromA)).toBe(true);

    const granted = updateObject(state, id, { keywords: { ...noKeywords, hexproof: true } });
    expect(isLegalTarget(granted, objectTarget(id), fromA)).toBe(false);
  });
});
