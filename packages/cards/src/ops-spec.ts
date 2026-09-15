import type { OpName } from '@mtg/engine';

/**
 * What each op's arguments are, and which of the script vocabularies each one is written
 * in (docs/03 "Effect ops").
 *
 * This is the table the loader converts a script's `{ op: damage, to: $t, amount: 3 }`
 * with, and it doubles as the reference for what an op takes — there is nowhere else that
 * says `damage` wants a target and a quantity. The validator in roadmap 2.2 reads the
 * same table, so a script that names an argument no op has is caught rather than ignored.
 */

export type ArgKind =
  | 'target'
  | 'object'
  | 'player'
  | 'quantity'
  | 'quantityOrAll'
  | 'filter'
  | 'condition'
  | 'effects'
  | 'raw';

export interface OpSpec {
  readonly args: Readonly<Record<string, ArgKind>>;
  readonly required: readonly string[];
  /**
   * Script spellings for arguments the engine names differently, as pairs rather than an
   * object — the only one so far is `if`'s `then`, which the engine calls `thenDo`
   * because an object with a `then` property is a thenable, and a table with one as a
   * *key* would be the same hazard in a different place.
   */
  readonly aliases?: readonly (readonly [script: string, engine: string])[];
}

export const opSpecs: Readonly<Record<OpName, OpSpec>> = {
  // Damage and life
  damage: {
    args: { to: 'target', amount: 'quantity', from: 'object' },
    required: ['to', 'amount'],
  },
  gainLife: { args: { player: 'player', amount: 'quantity' }, required: ['player', 'amount'] },
  loseLife: { args: { player: 'player', amount: 'quantity' }, required: ['player', 'amount'] },
  poison: { args: { player: 'player', amount: 'quantity' }, required: ['player', 'amount'] },
  fight: { args: { first: 'object', second: 'object' }, required: ['first', 'second'] },

  // Cards and zones
  draw: { args: { player: 'player', count: 'quantity' }, required: ['player', 'count'] },
  mill: { args: { player: 'player', count: 'quantity' }, required: ['player', 'count'] },
  discardAtRandom: {
    args: { player: 'player', count: 'quantity' },
    required: ['player', 'count'],
  },
  destroy: { args: { object: 'object' }, required: ['object'] },
  exile: { args: { object: 'object' }, required: ['object'] },
  bounce: { args: { object: 'object' }, required: ['object'] },
  sacrifice: { args: { object: 'object' }, required: ['object'] },
  moveZone: { args: { object: 'object', to: 'raw' }, required: ['object', 'to'] },
  shuffle: { args: { player: 'player' }, required: ['player'] },
  createToken: {
    args: { controller: 'player', token: 'raw', count: 'quantity' },
    required: ['controller', 'token'],
  },

  // Permanents
  tap: { args: { object: 'object' }, required: ['object'] },
  untap: { args: { object: 'object' }, required: ['object'] },
  addCounters: {
    args: { object: 'object', counter: 'raw', amount: 'quantity' },
    required: ['object', 'counter', 'amount'],
  },
  removeCounters: {
    args: { object: 'object', counter: 'raw', amount: 'quantity' },
    required: ['object', 'counter', 'amount'],
  },
  attach: { args: { attachment: 'object', to: 'object' }, required: ['attachment', 'to'] },

  // Continuous effects
  pump: {
    args: { object: 'object', power: 'quantity', toughness: 'quantity', duration: 'raw' },
    required: ['object', 'power', 'toughness'],
  },
  setPowerToughness: {
    args: { object: 'object', power: 'quantity', toughness: 'quantity', duration: 'raw' },
    required: ['object', 'power', 'toughness'],
  },
  switchPowerToughness: {
    args: { object: 'object', duration: 'raw' },
    required: ['object'],
  },
  grantKeyword: {
    args: { object: 'object', keyword: 'raw', duration: 'raw' },
    required: ['object', 'keyword'],
  },
  removeAbilities: { args: { object: 'object', duration: 'raw' }, required: ['object'] },
  becomesCreature: {
    args: { object: 'object', power: 'quantity', toughness: 'quantity', duration: 'raw' },
    required: ['object', 'power', 'toughness'],
  },
  setColours: {
    args: { object: 'object', colours: 'raw', duration: 'raw' },
    required: ['object', 'colours'],
  },
  gainControl: {
    args: { object: 'object', player: 'player', duration: 'raw' },
    required: ['object', 'player'],
  },

  // Replacement and prevention
  preventDamage: {
    args: { to: 'target', amount: 'quantityOrAll', duration: 'raw' },
    required: ['to', 'amount'],
  },
  regenerate: { args: { object: 'object' }, required: ['object'] },

  // The stack and the turn
  counter: { args: { object: 'object' }, required: ['object'] },
  addMana: { args: { player: 'player', produce: 'raw' }, required: ['player', 'produce'] },
  extraTurn: { args: { player: 'player' }, required: ['player'] },
  winGame: { args: { player: 'player' }, required: ['player'] },
  loseGame: { args: { player: 'player' }, required: ['player'] },
  delayedTrigger: { args: { ability: 'raw', once: 'raw' }, required: ['ability'] },

  // Control flow
  sequence: { args: { effects: 'effects' }, required: ['effects'] },
  forEach: { args: { of: 'filter', effects: 'effects' }, required: ['of', 'effects'] },
  if: {
    args: { condition: 'condition', thenDo: 'effects', otherwise: 'effects' },
    required: ['thenDo'],
    aliases: [['then', 'thenDo']],
  },
};
