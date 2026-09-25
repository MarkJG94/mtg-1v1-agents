import {
  type CardDefinition,
  createGameState,
  createObject,
  createRng,
  type GameState,
} from '@mtg/engine';
import { type DeckSlot, type OracleId, type PlayerId, playerIds, playerZone } from '@mtg/shared';

/**
 * A deck as the evolution loop holds it (docs/05): sixty cards to play with and fifteen
 * to sideboard from, each a card name and a count.
 */
export interface Deck {
  readonly main: readonly DeckSlot[];
  readonly side: readonly DeckSlot[];
}

export const cardCount = (slots: readonly DeckSlot[]): number =>
  slots.reduce((sum, slot) => sum + slot.count, 0);

/** Every card in a deck, main and side together, by name. */
export const cardsIn = (deck: Deck): Map<OracleId, number> => {
  const counts = new Map<OracleId, number>();
  for (const slot of [...deck.main, ...deck.side]) {
    counts.set(slot.oracleId, (counts.get(slot.oracleId) ?? 0) + slot.count);
  }
  return counts;
};

export interface DeckBoardOptions {
  readonly decks: Readonly<Record<PlayerId, Deck>>;
  /** Every card either deck holds. A card with no definition cannot be played. */
  readonly definitions: ReadonlyMap<OracleId, CardDefinition>;
  readonly seed: string;
  /** The player who chooses who plays first (CR 103.1). */
  readonly chooser: PlayerId;
  readonly turnCap: number;
}

export class MissingDefinitionError extends Error {
  constructor(oracleId: OracleId) {
    super(`no card definition for ${oracleId}; every card in a deck must be scripted`);
    this.name = 'MissingDefinitionError';
  }
}

/**
 * A game between two decks, not yet set up: each main deck in its owner's library, the
 * definitions of every card in play, and the chooser named, so `setUpGame` asks who plays
 * first before it shuffles and deals (CR 103.1-103.3). Sideboards stay out of the game —
 * they are the match's business, not the game's (CR 100.4a).
 */
export const deckBoard = (options: DeckBoardOptions): GameState => {
  const definitions: CardDefinition[] = [];
  const needed = new Set<OracleId>();
  for (const player of playerIds) {
    for (const slot of options.decks[player].main) needed.add(slot.oracleId);
  }
  for (const oracleId of needed) {
    const definition = options.definitions.get(oracleId);
    if (definition === undefined) throw new MissingDefinitionError(oracleId);
    definitions.push(definition);
  }

  let state = createGameState({
    rng: createRng(options.seed).save(),
    definitions,
    // Replaced by the chooser's answer before anything is dealt.
    onPlay: options.chooser,
    chooser: options.chooser,
    turnCap: options.turnCap,
  });
  for (const player of playerIds) {
    for (const slot of options.decks[player].main) {
      for (let copy = 0; copy < slot.count; copy += 1) {
        state = createObject(state, {
          definitionId: slot.oracleId,
          owner: player,
          zone: playerZone(player, 'library'),
        }).state;
      }
    }
  }
  return state;
};
