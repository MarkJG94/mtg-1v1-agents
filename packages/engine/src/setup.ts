import { type ObjectId, type PlayerId, playerIds, playerZone } from '@mtg/shared';

import type { EventEmitter } from './events/emitter.js';
import { runBatch } from './events/perform.js';
import type { DrawEvent } from './events/rules-event.js';
import { rngFromState } from './rng.js';
import type { GameState } from './state/game-state.js';
import { moveObject, objectsIn, setZone, updateState } from './state/update.js';

/**
 * Setting a game up, and the London mulligan (CR 103).
 *
 * The London mulligan is not "draw one fewer card". Every mulligan draws a fresh seven,
 * and the price is paid at the end: on keeping, a player puts one card on the bottom of
 * their library for each mulligan they took (CR 103.4b). That is why this is a little
 * state machine rather than a loop — the number of cards owed has to survive several
 * rounds of decisions, and the bottoming happens only once everybody has kept.
 *
 * Both players declare before any mulligan is taken, in turn order, and then the
 * mulligans happen together (CR 103.4). In a two-player game that ordering is visible:
 * the player on the play says first, and the other player does not learn what they chose
 * before deciding.
 */

/** The starting-deck record the `gameStart` event carries, per player. */
interface StartingDeck {
  readonly library: readonly ObjectId[];
  readonly hand: readonly ObjectId[];
}

/** Where a game is in the mulligan process. `null` once the opening hands are settled. */
export interface MulliganState {
  /** Mulligans taken so far, which is how many cards each owes the bottom (CR 103.4b). */
  readonly taken: Readonly<Record<PlayerId, number>>;
  /** Still to declare this round, in turn order. The first of them is being asked. */
  readonly deciding: readonly PlayerId[];
  /** Declared a mulligan this round; they all take it together once everyone has said. */
  readonly mulliganing: readonly PlayerId[];
  /** Kept, and still owing cards to the bottom of their library. */
  readonly bottoming: readonly PlayerId[];
}

export class MulliganError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MulliganError';
  }
}

/** Turn order from the player on the play (CR 103.4: players declare in turn order). */
const inTurnOrder = (state: GameState): readonly PlayerId[] => [
  state.config.playerOnPlay,
  ...playerIds.filter((player) => player !== state.config.playerOnPlay),
];

/** Shuffle one player's library (CR 103.1), advancing the game's own generator. */
const shuffleLibrary = (state: GameState, player: PlayerId): GameState => {
  const zone = playerZone(player, 'library');
  const rng = rngFromState(state.rng);
  const shuffled = rng.shuffled(objectsIn(state, zone));
  return updateState(setZone(state, zone, shuffled), { rng: rng.save() });
};

/**
 * Draw a whole opening hand. These go through the event pipeline like any other draw, so
 * a replacement effect that was somehow already in force would see them — and, more
 * usefully, a player whose library is too small to deal a hand is flagged as having drawn
 * from an empty library and loses to a state-based action once the game starts, rather
 * than the engine throwing.
 */
const drawHand = (state: GameState, emitter: EventEmitter, player: PlayerId): GameState => {
  const draws: DrawEvent[] = Array.from({ length: state.config.openingHandSize }, () => ({
    kind: 'draw',
    player,
  }));
  return runBatch(state, emitter, { kind: 'plain' }, draws);
};

/** Put a player's whole hand back into their library and shuffle (CR 103.4). */
const returnHandAndShuffle = (state: GameState, player: PlayerId): GameState => {
  let next = state;
  for (const id of [...objectsIn(state, playerZone(player, 'hand'))]) {
    next = moveObject(next, id, playerZone(player, 'library'));
  }
  return shuffleLibrary(next, player);
};

/**
 * Shuffle, deal opening hands, run the mulligans, and begin turn 1.
 *
 * The counterpart to `startGame`, which skips all of this and assumes the hands are
 * already dealt — which is what the scenario builder in roadmap 1.13 wants, and what
 * every test that cares about one rule rather than the whole game uses.
 */
export const setUpGame = (state: GameState, emitter: EventEmitter): GameState => {
  if (state.turn !== 0)
    throw new MulliganError(`the game has already started (turn ${state.turn})`);

  let next = state;
  for (const player of playerIds) next = shuffleLibrary(next, player);
  for (const player of playerIds) next = drawHand(next, emitter, player);

  const decks = {} as Record<PlayerId, StartingDeck>;
  for (const player of playerIds) {
    decks[player] = {
      library: [...objectsIn(next, playerZone(player, 'library'))],
      hand: [...objectsIn(next, playerZone(player, 'hand'))],
    };
  }

  emitter.emit(next, {
    type: 'gameStart',
    onPlay: next.config.playerOnPlay,
    startingLife: next.players[next.config.playerOnPlay].life,
    decks,
  });

  const taken = Object.fromEntries(playerIds.map((player) => [player, 0])) as Record<
    PlayerId,
    number
  >;

  return advanceMulligans(
    updateState(next, {
      mulligans: { taken, deciding: inTurnOrder(next), mulliganing: [], bottoming: [] },
    }),
    emitter,
  );
};

/**
 * Move the mulligan process to whatever needs doing next: ask the next player to declare,
 * take the round's mulligans together, collect the cards owed to the bottom, or — when
 * there is nothing left — begin the game.
 */
export const advanceMulligans = (state: GameState, emitter: EventEmitter): GameState => {
  const mulligans = state.mulligans;
  if (!mulligans) return state;

  const asking = mulligans.deciding[0];
  if (asking !== undefined) {
    const taken = mulligans.taken[asking];
    const hand = objectsIn(state, playerZone(asking, 'hand'));
    return updateState(state, {
      pendingDecision: {
        kind: 'mulligan',
        player: asking,
        hand: [...hand],
        taken,
        // At the cap there is nothing left to draw back down to, so keeping is the only
        // legal answer and the decision says so rather than the engine deciding for them.
        options: taken >= state.config.maxMulligans ? ['keep'] : ['keep', 'mulligan'],
      },
    });
  }

  // Everyone has declared. Those who chose to mulligan do so simultaneously (CR 103.4).
  if (mulligans.mulliganing.length > 0) {
    let next = state;
    const taken = { ...mulligans.taken };

    for (const player of mulligans.mulliganing) {
      next = returnHandAndShuffle(next, player);
      next = drawHand(next, emitter, player);
      taken[player] = (taken[player] ?? 0) + 1;
      emitter.emit(next, {
        type: 'mulligan',
        player,
        toHandSize: Math.max(0, next.config.openingHandSize - taken[player]),
      });
    }

    // Only the players who mulliganed decide again; the rest have kept.
    const deciding = inTurnOrder(next).filter((player) => mulligans.mulliganing.includes(player));
    return advanceMulligans(
      updateState(next, {
        mulligans: { ...mulligans, taken, deciding, mulliganing: [] },
      }),
      emitter,
    );
  }

  // Everyone has kept. Those who mulliganed now pay for it (CR 103.4b).
  const bottoming = mulligans.bottoming[0];
  if (bottoming !== undefined) {
    return updateState(state, {
      pendingDecision: {
        kind: 'bottomCards',
        player: bottoming,
        count: mulligans.taken[bottoming],
        from: [...objectsIn(state, playerZone(bottoming, 'hand'))],
      },
    });
  }

  return updateState(state, { mulligans: null });
};

/** Answer a mulligan decision. Returns a state that may be waiting on the next one. */
export const applyMulligan = (
  state: GameState,
  emitter: EventEmitter,
  player: PlayerId,
  action: 'keep' | 'mulligan',
): GameState => {
  const mulligans = state.mulligans;
  if (!mulligans) throw new MulliganError('no mulligan is in progress');
  if (mulligans.deciding[0] !== player) {
    throw new MulliganError(`it is not ${player}'s turn to declare a mulligan`);
  }
  if (action === 'mulligan' && mulligans.taken[player] >= state.config.maxMulligans) {
    throw new MulliganError(`${player} has already taken the maximum number of mulligans`);
  }

  const deciding = mulligans.deciding.slice(1);

  if (action === 'mulligan') {
    return advanceMulligans(
      updateState(state, {
        mulligans: {
          ...mulligans,
          deciding,
          mulliganing: [...mulligans.mulliganing, player],
        },
      }),
      emitter,
    );
  }

  // A hand kept without a mulligan is final right now, so the log can say so.
  const owed = mulligans.taken[player];
  if (owed === 0) {
    emitter.emit(state, {
      type: 'keep',
      player,
      handSize: objectsIn(state, playerZone(player, 'hand')).length,
      bottomed: [],
    });
  }

  return advanceMulligans(
    updateState(state, {
      mulligans: {
        ...mulligans,
        deciding,
        bottoming: owed > 0 ? [...mulligans.bottoming, player] : mulligans.bottoming,
      },
    }),
    emitter,
  );
};

/** Answer a bottom-cards decision: those cards go under the library in the chosen order. */
export const applyBottomCards = (
  state: GameState,
  emitter: EventEmitter,
  player: PlayerId,
  cards: readonly ObjectId[],
): GameState => {
  const mulligans = state.mulligans;
  if (!mulligans) throw new MulliganError('no mulligan is in progress');
  if (mulligans.bottoming[0] !== player) {
    throw new MulliganError(`${player} does not owe any cards to the bottom`);
  }

  const owed = mulligans.taken[player];
  if (cards.length !== owed) {
    throw new MulliganError(`expected ${owed} card(s) for the bottom, got ${cards.length}`);
  }

  const hand = new Set(objectsIn(state, playerZone(player, 'hand')));
  let next = state;
  for (const id of cards) {
    if (!hand.has(id)) throw new MulliganError(`card ${id} is not in ${player}'s hand`);
    hand.delete(id);
    // 'end' of the library array is the bottom; the chosen order is preserved.
    next = moveObject(next, id, playerZone(player, 'library'), 'end');
  }

  emitter.emit(next, {
    type: 'keep',
    player,
    handSize: objectsIn(next, playerZone(player, 'hand')).length,
    bottomed: [...cards],
  });

  return advanceMulligans(
    updateState(next, {
      mulligans: { ...mulligans, bottoming: mulligans.bottoming.slice(1) },
    }),
    emitter,
  );
};
