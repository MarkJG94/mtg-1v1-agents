export type PlayerId = 'A' | 'B';
export const PLAYERS: readonly PlayerId[] = ['A', 'B'];
export function opponentOf(p: PlayerId): PlayerId {
  return p === 'A' ? 'B' : 'A';
}

/** Numeric id of a card, token, or copy. Stable for a card across zones; see `instance`. */
export type ObjectId = number;

export type ZoneName =
  | 'library'
  | 'hand'
  | 'battlefield'
  | 'graveyard'
  | 'exile'
  | 'stack'
  | 'command';

export type Step =
  | 'untap'
  | 'upkeep'
  | 'draw'
  | 'main1'
  | 'beginCombat'
  | 'declareAttackers'
  | 'declareBlockers'
  | 'firstStrikeDamage'
  | 'combatDamage'
  | 'endCombat'
  | 'main2'
  | 'end'
  | 'cleanup';

export const STEPS: readonly Step[] = [
  'untap',
  'upkeep',
  'draw',
  'main1',
  'beginCombat',
  'declareAttackers',
  'declareBlockers',
  'firstStrikeDamage',
  'combatDamage',
  'endCombat',
  'main2',
  'end',
  'cleanup',
];

export type Color = 'W' | 'U' | 'B' | 'R' | 'G';
export const COLORS: readonly Color[] = ['W', 'U', 'B', 'R', 'G'];
export type ManaType = Color | 'C';
export const MANA_TYPES: readonly ManaType[] = ['W', 'U', 'B', 'R', 'G', 'C'];

export type CardType =
  | 'creature'
  | 'instant'
  | 'sorcery'
  | 'artifact'
  | 'enchantment'
  | 'land'
  | 'planeswalker'
  | 'kindred';

export type Supertype = 'legendary' | 'basic' | 'snow';
