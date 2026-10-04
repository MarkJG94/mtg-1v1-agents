import { asOracleId, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { createEventEmitter } from '../events/emitter.js';
import { runEvent } from '../events/perform.js';
import { parseManaCost } from '../mana/cost.js';
import { objectsIn } from '../state/update.js';
import { keywords } from '../targeting.js';
import { game } from '../testing/scenario.js';
import type { CardDefinition } from './definition.js';

/**
 * "Whenever ~ deals combat damage to a player, draw a card" (CR 510.3a): it triggers as the
 * damage is dealt — once each time it is, and not at all when none is.
 */

const ninja = (keywords: CardDefinition['keywords'] = undefined): CardDefinition => ({
  oracleId: asOracleId(`cd-ninja-${keywords === undefined ? 'plain' : 'double'}`),
  name: 'Test Ninja',
  manaCost: parseManaCost('{1}{U}'),
  types: ['creature'],
  colours: ['U'],
  power: 2,
  toughness: 2,
  ...(keywords === undefined ? {} : { keywords }),
  abilities: [
    {
      kind: 'triggered',
      id: 'hit',
      when: { kind: 'selfDealsCombatDamageToPlayer' },
      effects: [{ op: 'draw', player: { kind: 'you' }, count: 1 }],
    },
  ],
});

const plain = ninja();

const table = (definition: CardDefinition = plain) =>
  game({ definitions: [definition], seed: 'combat-damage' })
    .player('A')
    .battlefield({ name: 'ninja', definitionId: definition.oracleId })
    .library(10)
    .player('B')
    .battlefield({ name: 'wall', power: 0, toughness: 4 })
    .library(10)
    .player('A')
    .start()
    .to('declareAttackers');

const handOf = (scenario: ReturnType<typeof table>) =>
  objectsIn(scenario.get(), playerZone('A', 'hand')).length;

/** Through blocks and damage, and whatever the damage put on the stack. */
const throughCombat = (scenario: ReturnType<typeof table>, block: boolean) => {
  scenario.attack('ninja');
  scenario.to('declareBlockers');
  if (block) scenario.block({ blocker: 'wall', blocking: 'ninja' });
  else scenario.decide({ kind: 'declareBlockers', blocks: [] });
  return scenario.to('postcombatMain').resolve();
};

describe('a trigger on dealing combat damage to a player (CR 510.3a)', () => {
  it('fires when the creature connects, and does what it says', () => {
    const scenario = table();
    const before = handOf(scenario);
    throughCombat(scenario, false);
    expect(scenario.lifeOf('B')).toBe(18);
    expect(handOf(scenario)).toBe(before + 1);
  });

  it('does not fire when the creature is blocked and deals its damage to a creature', () => {
    const scenario = table();
    const before = handOf(scenario);
    throughCombat(scenario, true);
    expect(scenario.lifeOf('B')).toBe(20);
    expect(handOf(scenario)).toBe(before);
  });

  it('fires once for each time it deals the damage: twice with double strike', () => {
    const scenario = table(ninja(keywords({ doubleStrike: true })));
    const before = handOf(scenario);
    throughCombat(scenario, false);
    expect(scenario.lifeOf('B')).toBe(16);
    expect(handOf(scenario)).toBe(before + 2);
  });

  it('does not fire for combat damage of zero, which is no damage dealt', () => {
    const scenario = table();
    const after = runEvent(scenario.get(), createEventEmitter(), {
      kind: 'damage',
      source: scenario.ref('ninja'),
      controller: 'A',
      target: { kind: 'player', player: 'B' },
      amount: 0,
      combat: true,
      deathtouch: false,
      lifelink: false,
    });
    expect(after.pendingTriggers).toEqual([]);
  });

  it('does not fire for damage that is not combat damage', () => {
    const scenario = table();
    const emitter = createEventEmitter();
    const after = runEvent(scenario.get(), emitter, {
      kind: 'damage',
      source: scenario.ref('ninja'),
      controller: 'A',
      target: { kind: 'player', player: 'B' },
      amount: 2,
      combat: false,
      deathtouch: false,
      lifelink: false,
    });
    expect(after.players.B.life).toBe(18);
    expect(after.pendingTriggers).toEqual([]);
  });
});
