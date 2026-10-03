import { asOracleId } from '@mtg/shared';
import type { CardDefinition } from '../cards/definition.js';
import { parseManaCost } from '../mana/cost.js';

/**
 * A handful of cards for the fuzzer to actually play (roadmap 1.13, finished in 4.2).
 *
 * The fuzzer has always dealt out objects with a `definitionId` the game had no
 * definition for, and said so: "without card definitions nothing can be cast, so what
 * this exercises is the framework". 2.1 gave the engine definitions and 4.2 wired
 * `legalActions` into the priority decision, and with both in place that limit is a
 * choice rather than a fact — so it is lifted here.
 *
 * Deliberately small and deliberately nasty. The point is not a realistic deck; it is to
 * reach the code paths a passing-only fuzzer never did — paying costs, choosing targets,
 * putting things on the stack, resolving them, and the state-based actions that follow —
 * with the shapes most likely to break something: a spell that can target either player
 * or any creature, a creature that dies to its own drawback, an aura-free pump that can
 * be pointed at the opponent's creature as easily as your own.
 *
 * These live in the engine's testing entry point rather than in `@mtg/cards`, because the
 * engine may not depend on the card package (docs/01) and a fuzzer that needed a YAML
 * loader would be a fuzzer that could not run inside the engine's own suite.
 */

const id = (name: string) => asOracleId(`fuzz-${name}`);

export const fuzzLand: CardDefinition = {
  oracleId: id('land'),
  name: 'Fuzz Land',
  manaCost: parseManaCost(''),
  types: ['land'],
  colours: [],
  abilities: [
    {
      kind: 'mana',
      id: 'any',
      modes: [
        [{ type: 'W', amount: 1 }],
        [{ type: 'U', amount: 1 }],
        [{ type: 'B', amount: 1 }],
        [{ type: 'R', amount: 1 }],
        [{ type: 'G', amount: 1 }],
      ],
    },
  ],
};

export const fuzzCreature: CardDefinition = {
  oracleId: id('creature'),
  name: 'Fuzz Bear',
  manaCost: parseManaCost('{1}{G}'),
  types: ['creature'],
  colours: ['G'],
  power: 2,
  toughness: 2,
  abilities: [],
};

/** A creature with a trigger, so resolution has to put an ability on the stack too. */
export const fuzzTrigger: CardDefinition = {
  oracleId: id('trigger'),
  name: 'Fuzz Scout',
  manaCost: parseManaCost('{2}'),
  types: ['creature'],
  colours: [],
  power: 1,
  toughness: 3,
  abilities: [
    {
      kind: 'triggered',
      id: 'enters',
      when: { kind: 'selfEntersBattlefield' },
      effects: [{ op: 'gainLife', player: { kind: 'you' }, amount: 1 }],
    },
  ],
};

/** Targets anything, including a player, so the target enumeration has real work to do. */
export const fuzzBurn: CardDefinition = {
  oracleId: id('burn'),
  name: 'Fuzz Bolt',
  manaCost: parseManaCost('{R}'),
  types: ['instant'],
  colours: ['R'],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 't', filter: { kind: 'any' } }],
      effects: [{ op: 'damage', to: { kind: 'chosen', id: 't' }, amount: 2 }],
    },
  ],
};

/** Only ever legal with a creature on the board, which is the interesting case. */
export const fuzzRemoval: CardDefinition = {
  oracleId: id('removal'),
  name: 'Fuzz Doom',
  manaCost: parseManaCost('{1}{B}'),
  types: ['sorcery'],
  colours: ['B'],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 't', filter: { kind: 'creature' } }],
      effects: [{ op: 'destroy', object: { kind: 'target', id: 't' } }],
    },
  ],
};

export const fuzzDeck: readonly CardDefinition[] = [
  fuzzLand,
  fuzzCreature,
  fuzzTrigger,
  fuzzBurn,
  fuzzRemoval,
];
