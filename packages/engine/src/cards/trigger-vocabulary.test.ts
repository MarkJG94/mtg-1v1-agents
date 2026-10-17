import { asOracleId, playerZone } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { parseManaCost } from '../mana/cost.js';
import { objectsIn } from '../state/update.js';
import { game } from '../testing/scenario.js';
import type { TriggerWhen } from '../triggers.js';
import type { CardDefinition } from './definition.js';
import type { EffectOp } from './ops.js';

/**
 * The trigger conditions 7.1 added: the beginning of combat (CR 507.1), a spell being cast
 * (CR 601.2i), a player gaining life (CR 119.10) and a creature becoming blocked
 * (CR 509.3c). Each watcher here gains its controller 1 life, so how often it fired is
 * how much life they gained.
 */

const you = { kind: 'you' } as const;
const gainOne: EffectOp = { op: 'gainLife', player: you, amount: 1 };

let made = 0;
const watcher = (when: TriggerWhen, effects: readonly EffectOp[] = [gainOne]): CardDefinition => {
  made += 1;
  return {
    oracleId: asOracleId(`tv-watcher-${made}`),
    name: `Watcher ${made}`,
    manaCost: parseManaCost('{1}'),
    types: ['creature'],
    colours: [],
    power: 1,
    toughness: 1,
    abilities: [{ kind: 'triggered', id: 'watch', when, effects }],
  };
};

const spell = (name: string, types: CardDefinition['types'], effects: readonly EffectOp[] = []) =>
  ({
    oracleId: asOracleId(`tv-${name}`),
    name,
    manaCost: parseManaCost(''),
    types,
    colours: [],
    ...(types.includes('creature') ? { power: 1, toughness: 1 } : {}),
    abilities: types.includes('creature') ? [] : [{ kind: 'spell', effects }],
  }) as CardDefinition;

describe('"at the beginning of combat on your turn" (CR 507.1)', () => {
  const table = (when: TriggerWhen, controller: 'A' | 'B') => {
    const card = watcher(when);
    return game({ definitions: [card], seed: 'trigger-vocabulary' })
      .player('A')
      .library(10)
      .player('B')
      .library(10)
      .player(controller)
      .battlefield({ name: 'watcher', definitionId: card.oracleId })
      .player('A')
      .start()
      .to('declareAttackers');
  };

  it('fires as its controller’s beginning of combat step begins', () => {
    expect(table({ kind: 'beginningOfCombat', whose: 'self' }, 'A').lifeOf('A')).toBe(21);
  });

  it('does not fire on the opponent’s turn', () => {
    expect(table({ kind: 'beginningOfCombat', whose: 'self' }, 'B').lifeOf('B')).toBe(20);
  });

  it('"each opponent’s" fires on the opponent’s turn, and only then', () => {
    expect(table({ kind: 'beginningOfCombat', whose: 'opponent' }, 'B').lifeOf('B')).toBe(21);
    expect(table({ kind: 'beginningOfCombat', whose: 'opponent' }, 'A').lifeOf('A')).toBe(20);
  });

  it('is not an upkeep or end step trigger', () => {
    const scenario = table({ kind: 'beginningOfCombat', whose: 'any' }, 'A');
    expect(scenario.lifeOf('A')).toBe(21);
    scenario.decide({ kind: 'declareAttackers', attackers: [] }).to('end').resolve();
    expect(scenario.lifeOf('A')).toBe(21);
  });
});

describe('"whenever you cast an instant or sorcery spell" (CR 601.2i)', () => {
  const instantOrSorcery = {
    kind: 'or',
    filters: [
      { kind: 'type', type: 'instant' },
      { kind: 'type', type: 'sorcery' },
    ],
  } as const;
  const sorcery = spell('Sorcery', ['sorcery']);
  const bear = spell('Bear', ['creature']);

  const table = (when: TriggerWhen, controller: 'A' | 'B') => {
    const card = watcher(when);
    return game({ definitions: [card, sorcery, bear], seed: 'trigger-vocabulary' })
      .player('A')
      .hand(
        { name: 'sorcery', definitionId: sorcery.oracleId },
        { name: 'bear', definitionId: bear.oracleId },
      )
      .library(10)
      .player('B')
      .library(10)
      .player(controller)
      .battlefield({ name: 'watcher', definitionId: card.oracleId })
      .player('A')
      .start()
      .to('precombatMain');
  };

  it('fires for a spell the filter matches, while the spell is on the stack', () => {
    const scenario = table({ kind: 'spellCast', caster: 'you', filter: instantOrSorcery }, 'A');
    scenario.cast('sorcery');
    // Fired, and waiting for the next priority to go on the stack above it (CR 603.3b).
    expect(objectsIn(scenario.get(), 'stack')).toEqual([scenario.ref('sorcery')]);
    expect(scenario.get().pendingTriggers.map((each) => each.abilityId)).toEqual(['watch']);
    scenario.resolve();
    expect(scenario.lifeOf('A')).toBe(21);
  });

  it('does not fire for a spell the filter does not match', () => {
    const scenario = table({ kind: 'spellCast', caster: 'you', filter: instantOrSorcery }, 'A');
    scenario.cast('bear').resolve();
    expect(scenario.lifeOf('A')).toBe(20);
  });

  it('with no filter, fires for any spell', () => {
    const scenario = table({ kind: 'spellCast', caster: 'you' }, 'A');
    scenario.cast('bear').resolve();
    expect(scenario.lifeOf('A')).toBe(21);
  });

  it('"you" is the watcher’s controller, and "an opponent" the other player', () => {
    const mine = table({ kind: 'spellCast', caster: 'you' }, 'B');
    mine.cast('sorcery').resolve();
    expect(mine.lifeOf('B')).toBe(20);

    const theirs = table({ kind: 'spellCast', caster: 'opponent' }, 'B');
    theirs.cast('sorcery').resolve();
    expect(theirs.lifeOf('B')).toBe(21);
  });
});

describe('"whenever you gain life" (CR 119.10)', () => {
  /** "Whenever you gain life, each opponent loses 1 life." */
  const drain = (): CardDefinition =>
    watcher({ kind: 'lifeGained', player: 'you' }, [
      { op: 'loseLife', player: { kind: 'opponent' }, amount: 1 },
    ]);

  it('fires once for each life-gain event', () => {
    const card = drain();
    const heal = spell('Heal', ['sorcery'], [{ op: 'gainLife', player: you, amount: 3 }]);
    const scenario = game({ definitions: [card, heal], seed: 'trigger-vocabulary' })
      .player('A')
      .battlefield({ name: 'watcher', definitionId: card.oracleId })
      .hand({ name: 'heal', definitionId: heal.oracleId })
      .library(10)
      .player('B')
      .library(10)
      .player('A')
      .start()
      .to('precombatMain');
    scenario.cast('heal').resolve();
    expect(scenario.lifeOf('A')).toBe(23);
    expect(scenario.lifeOf('B')).toBe(19);
  });

  it('"you" is the watcher’s controller: the other player’s gain is not theirs', () => {
    const heal = spell('Heal', ['sorcery'], [{ op: 'gainLife', player: you, amount: 3 }]);
    const table = (player: 'you' | 'opponent' | 'any') => {
      // Not a life gain itself: "whenever a player gains life, you gain 1 life" triggers
      // itself for ever.
      const card = watcher({ kind: 'lifeGained', player }, [
        { op: 'loseLife', player: { kind: 'opponent' }, amount: 1 },
      ]);
      return game({ definitions: [card, heal], seed: 'trigger-vocabulary' })
        .player('A')
        .hand({ name: 'heal', definitionId: heal.oracleId })
        .library(10)
        .player('B')
        .battlefield({ name: 'watcher', definitionId: card.oracleId })
        .library(10)
        .player('A')
        .start()
        .to('precombatMain')
        .cast('heal')
        .resolve();
    };
    // A gains 3 with B's watcher on the table, which costs A 1 if it fires.
    expect(table('you').lifeOf('A')).toBe(23);
    expect(table('opponent').lifeOf('A')).toBe(22);
    expect(table('any').lifeOf('A')).toBe(22);
  });

  it('two lifelink creatures dealing combat damage together are two life gains', () => {
    const card = drain();
    const scenario = game({ definitions: [card], seed: 'trigger-vocabulary' })
      .player('A')
      .battlefield(
        { name: 'watcher', definitionId: card.oracleId, summoningSick: true },
        { name: 'one', power: 2, toughness: 2, keywords: { lifelink: true } },
        { name: 'two', power: 2, toughness: 2, keywords: { lifelink: true } },
      )
      .library(10)
      .player('B')
      .library(10)
      .player('A')
      .start()
      .to('declareAttackers');
    // B has nothing to block with, so there is no block to declare. The two triggers fire
    // together, so A orders them (CR 603.3b) — which is itself the sign there are two.
    scenario.attack('one', 'two');
    for (let i = 0; i < 50 && scenario.get().step !== 'postcombatMain'; i += 1) {
      const asked = scenario.get().pendingDecision;
      if (asked?.kind === 'orderTriggers') {
        scenario.decide({ kind: 'orderTriggers', order: asked.triggers });
      } else scenario.pass();
    }
    scenario.resolve();
    expect(scenario.lifeOf('A')).toBe(24);
    // 4 combat damage, and 1 for each of the two life gains.
    expect(scenario.lifeOf('B')).toBe(14);
  });
});

describe('"whenever ~ becomes blocked" (CR 509.3c)', () => {
  const table = () => {
    const card = watcher({ kind: 'selfBecomesBlocked' });
    return game({ definitions: [card], seed: 'trigger-vocabulary' })
      .player('A')
      .battlefield({ name: 'watcher', definitionId: card.oracleId })
      .library(10)
      .player('B')
      .battlefield(
        { name: 'left', power: 0, toughness: 4 },
        { name: 'right', power: 0, toughness: 4 },
      )
      .library(10)
      .player('A')
      .start()
      .to('declareAttackers')
      .attack('watcher')
      .to('declareBlockers');
  };

  it('fires once however many creatures block it', () => {
    const scenario = table();
    scenario.decide({
      kind: 'declareBlockers',
      blocks: [
        { blocker: scenario.ref('left'), blocking: [scenario.ref('watcher')] },
        { blocker: scenario.ref('right'), blocking: [scenario.ref('watcher')] },
      ],
    });
    scenario.decide({
      kind: 'orderBlockers',
      order: [scenario.ref('left'), scenario.ref('right')],
    });
    scenario.resolve();
    expect(scenario.lifeOf('A')).toBe(21);
  });

  it('does not fire when it is not blocked', () => {
    const scenario = table();
    scenario.decide({ kind: 'declareBlockers', blocks: [] }).resolve();
    expect(scenario.lifeOf('A')).toBe(20);
    expect(objectsIn(scenario.get(), playerZone('A', 'graveyard'))).toEqual([]);
  });
});
