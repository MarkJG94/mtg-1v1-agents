/**
 * The vocabulary card tags are written in (docs/04 "Sideboarding agent"; roadmap 4.6).
 *
 * Here rather than in `@mtg/cards`, which reads the tags off a script, because the
 * sideboarding agent that uses them lives in `@mtg/agents`, and the agents package may
 * import nothing but `@mtg/engine/view` and this one (ADR 0009).
 */

export const cardKinds = [
  'creature',
  'artifact',
  'enchantment',
  'planeswalker',
  'land',
  'instant',
  'sorcery',
  /** Any spell on the stack: what a counterspell answers, and what every nonland card is. */
  'spell',
  /** Damage that can go to a player. */
  'burn',
  'counterspell',
  'lifegain',
  /** Returns cards from a graveyard, or otherwise uses one. */
  'graveyard',
] as const;
export type CardKind = (typeof cardKinds)[number];

export interface CardTags {
  readonly is: readonly CardKind[];
  readonly vs: readonly CardKind[];
}
