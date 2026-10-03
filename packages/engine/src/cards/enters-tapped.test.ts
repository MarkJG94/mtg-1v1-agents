import { asOracleId } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { parseManaCost } from '../mana/cost.js';
import { game } from '../testing/scenario.js';
import type { CardDefinition } from './definition.js';

/**
 * "This enters tapped" (CR 614.1c), read off a card that is not on the battlefield yet.
 *
 * The replacement belongs to the card that is arriving, so the game has to find it while
 * the card is still in hand or on the stack — by the time it is a permanent, the event it
 * modifies is over (CR 614.12). A gate that came down untapped would be a strictly better
 * card than the one that is printed.
 */

const gate: CardDefinition = {
  oracleId: asOracleId('t-gate'),
  name: 'Test Gate',
  manaCost: parseManaCost(''),
  types: ['land'],
  colours: [],
  abilities: [
    {
      kind: 'replacement',
      id: 'enters-tapped',
      applies: { kind: 'entersBattlefield', object: 'source' },
      change: { kind: 'entersTapped' },
      selfReplacement: true,
    },
  ],
};

const plain: CardDefinition = {
  ...gate,
  oracleId: asOracleId('t-plain'),
  name: 'Test Plain Land',
  abilities: [],
};

const sleeper: CardDefinition = {
  oracleId: asOracleId('t-sleeper'),
  name: 'Test Sleeper',
  manaCost: parseManaCost(''),
  types: ['creature'],
  colours: [],
  power: 1,
  toughness: 1,
  abilities: [
    {
      kind: 'replacement',
      id: 'enters-tapped',
      applies: { kind: 'entersBattlefield', object: 'source' },
      change: { kind: 'entersTapped' },
      selfReplacement: true,
    },
  ],
};

const board = () =>
  game({ definitions: [gate, plain, sleeper] })
    .player('A')
    .hand(
      { name: 'gate', definitionId: gate.oracleId },
      { name: 'plain', definitionId: plain.oracleId },
      { name: 'sleeper', definitionId: sleeper.oracleId },
    )
    .library(10)
    .player('B')
    .library(10)
    .player('A')
    .start()
    .to('precombatMain');

describe('a card that enters tapped', () => {
  it('is tapped when it is played as a land', () => {
    expect(board().playLand('gate').object('gate').tapped).toBe(true);
  });

  it('is tapped when it resolves off the stack', () => {
    expect(board().cast('sleeper').resolve().object('sleeper').tapped).toBe(true);
  });

  it('leaves a land without the ability untapped', () => {
    expect(board().playLand('plain').object('plain').tapped).toBe(false);
  });
});
