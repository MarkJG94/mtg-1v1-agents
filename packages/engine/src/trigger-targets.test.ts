import { asOracleId, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import type { CardDefinition, TargetSpec } from './cards/definition.js';
import { parseManaCost } from './mana/cost.js';
import { game } from './testing/scenario.js';

/**
 * A triggered ability's targets are chosen as it goes on the stack (CR 603.3d), by its
 * controller, from every legal way — and an ability with no legal way never gets there.
 * Before this, a trigger that targeted went on the stack with no targets at all, and
 * "When ~ enters, destroy target artifact" did nothing.
 */

let made = 0;
const sage = (target: TargetSpec): CardDefinition => {
  made += 1;
  return {
    oracleId: asOracleId(`tt-sage-${made}`),
    name: `Sage ${made}`,
    manaCost: parseManaCost(''),
    types: ['creature'],
    colours: ['G'],
    power: 2,
    toughness: 1,
    abilities: [
      {
        kind: 'triggered',
        id: 'enters',
        when: { kind: 'selfEntersBattlefield' },
        targets: [target],
        effects: [{ op: 'destroy', object: { kind: 'target', id: 't' } }],
      },
    ],
  };
};

const relic: CardDefinition = {
  oracleId: asOracleId('tt-relic'),
  name: 'Relic',
  manaCost: parseManaCost(''),
  types: ['artifact'],
  colours: [],
  abilities: [],
};

const artifact = { id: 't', filter: { kind: 'type', type: 'artifact' } } as const;

const table = (card: CardDefinition, relics: number) =>
  game({ definitions: [card, relic], seed: 'trigger-targets', recordEvents: true })
    .player('A')
    .hand({ name: 'sage', definitionId: card.oracleId })
    .library(10)
    .player('B')
    .battlefield(
      ...Array.from({ length: relics }, (_, i) => ({
        name: `relic${i}`,
        definitionId: relic.oracleId,
      })),
    )
    .library(10)
    .player('A')
    .start()
    .to('precombatMain');

/** Cast it and pass until it resolves, so its enters trigger is about to be stacked. */
const enter = (scenario: ReturnType<typeof table>) => scenario.cast('sage').pass(2);

describe('a triggered ability that targets (CR 603.3d)', () => {
  it('asks its controller for targets, offering every legal way', () => {
    const scenario = enter(table(sage(artifact), 2));
    expect(scenario.get().pendingDecision).toEqual({
      kind: 'chooseTargets',
      player: 'A',
      source: scenario.ref('sage'),
      ability: 'enters',
      options: [[scenario.target('relic0')], [scenario.target('relic1')]],
    });
  });

  it('goes on the stack with the targets chosen, and does what it says to them', () => {
    const scenario = enter(table(sage(artifact), 2));
    scenario.decide({ kind: 'chooseTargets', targets: [scenario.target('relic1')] }).resolve();
    expect(scenario.zoneOf('relic1')).toBe(playerZone('B', 'graveyard'));
    expect(scenario.zoneOf('relic0')).toBe('battlefield');
  });

  it('takes the only way there is without asking', () => {
    const scenario = enter(table(sage(artifact), 1));
    expect(scenario.get().pendingDecision?.kind).toBe('priority');
    scenario.resolve();
    expect(scenario.zoneOf('relic0')).toBe(playerZone('B', 'graveyard'));
  });

  it('with no legal target never goes on the stack at all', () => {
    const scenario = enter(table(sage(artifact), 0));
    expect(scenario.get().zones.stack).toEqual([]);
    expect(scenario.get().pendingTriggers).toEqual([]);
    expect(scenario.events()).not.toContain('trigger');
  });

  it('with "up to one" target may have none, and is still put on the stack', () => {
    const scenario = enter(table(sage({ ...artifact, upTo: true }), 1));
    const decision = scenario.get().pendingDecision;
    expect(decision?.kind === 'chooseTargets' ? decision.options : null).toEqual([
      [],
      [scenario.target('relic0')],
    ]);
    scenario.decide({ kind: 'chooseTargets', targets: [] });
    expect(scenario.events()).toContain('trigger');
    scenario.resolve();
    expect(scenario.zoneOf('relic0')).toBe('battlefield');
  });

  it('refuses targets that were not one of the ways offered', () => {
    const scenario = enter(table(sage(artifact), 2));
    expect(() =>
      scenario.decide({ kind: 'chooseTargets', targets: [scenario.target('sage')] }),
    ).toThrow();
    expect(() => scenario.decide({ kind: 'chooseTargets', targets: [] })).toThrow();
  });

  it('fizzles when its only target is gone by the time it resolves (CR 608.2b)', () => {
    const scenario = enter(table(sage(artifact), 1));
    scenario.kill('relic0').resolve();
    expect(scenario.events()).toContain('fizzle');
  });
});
