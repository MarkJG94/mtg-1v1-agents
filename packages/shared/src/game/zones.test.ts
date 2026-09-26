import { describe, expect, it } from 'vitest';
import {
  allZoneIds,
  isHiddenZone,
  isOrderedZone,
  isSharedZone,
  kindOfZone,
  ownerOfZone,
  playerZone,
  playerZoneKinds,
  sharedZoneKinds,
} from './zones.js';

describe('zone ids', () => {
  it('builds a player zone id', () => {
    expect(playerZone('A', 'hand')).toBe('A:hand');
    expect(playerZone('B', 'graveyard')).toBe('B:graveyard');
  });

  it('lists every zone exactly once', () => {
    expect(allZoneIds).toHaveLength(playerZoneKinds.length * 2 + sharedZoneKinds.length);
    expect(new Set(allZoneIds).size).toBe(allZoneIds.length);
  });

  it('covers both players for every per-player kind', () => {
    for (const kind of playerZoneKinds) {
      expect(allZoneIds).toContain(`A:${kind}`);
      expect(allZoneIds).toContain(`B:${kind}`);
    }
  });
});

describe('ownerOfZone', () => {
  it('names the owner of a per-player zone', () => {
    expect(ownerOfZone('A:library')).toBe('A');
    expect(ownerOfZone('B:hand')).toBe('B');
  });

  it('returns null for shared zones', () => {
    for (const zone of sharedZoneKinds) expect(ownerOfZone(zone)).toBeNull();
  });
});

describe('kindOfZone', () => {
  it('strips the player prefix', () => {
    expect(kindOfZone('A:library')).toBe('library');
    expect(kindOfZone('B:graveyard')).toBe('graveyard');
  });

  it('returns a shared zone unchanged', () => {
    expect(kindOfZone('battlefield')).toBe('battlefield');
    expect(kindOfZone('stack')).toBe('stack');
  });

  it('agrees with ownerOfZone across every zone', () => {
    for (const zone of allZoneIds) {
      const shared = isSharedZone(zone);
      expect(ownerOfZone(zone) === null).toBe(shared);
      expect(kindOfZone(zone)).toBeTruthy();
    }
  });
});

describe('zone properties', () => {
  it('treats libraries and hands as hidden', () => {
    expect(isHiddenZone('A:library')).toBe(true);
    expect(isHiddenZone('B:hand')).toBe(true);
  });

  it('treats public zones as visible', () => {
    for (const zone of ['battlefield', 'stack', 'exile', 'command', 'A:graveyard'] as const) {
      expect(isHiddenZone(zone)).toBe(false);
    }
  });

  it('treats libraries and the stack as ordered', () => {
    expect(isOrderedZone('A:library')).toBe(true);
    expect(isOrderedZone('stack')).toBe(true);
    expect(isOrderedZone('battlefield')).toBe(false);
    expect(isOrderedZone('A:hand')).toBe(false);
  });
});

describe('the battlefield is shared, not per player (ADR 0002)', () => {
  it('has no owner, so a control change never moves an object between zones', () => {
    expect(isSharedZone('battlefield')).toBe(true);
    expect(ownerOfZone('battlefield')).toBeNull();
    expect(allZoneIds).not.toContain('A:battlefield');
    expect(allZoneIds).not.toContain('B:battlefield');
  });
});
