import {
  type CardDefinition,
  characteristicsOf,
  type GameState,
  isSorcerySpeed,
} from '@mtg/engine';
import type { ObjectId, PlayerId } from '@mtg/shared';
import { playScenarioTest } from './scenario-tests.js';
import type { ScenarioTest } from './schema.js';
import { playSmokeScenario, smokeScenarios } from './smoke.js';

/**
 * The differential harness (docs/09 "Differential test").
 *
 * Once phase 3 can write a script for a card that already has a hand-written one, the two
 * are claims about the same piece of cardboard and have to agree. This plays both in the
 * same games — the validator's three smoke boards, and whatever scenario tests the hand
 * script carries — and compares what the games look like afterwards.
 *
 * What it compares is the *whole* resulting position, not the expectations the hand script
 * declared. A scenario test asks "did the damage land"; this asks "is this the same game",
 * so an auto script that also drew a card, or left something tapped, or put the card in
 * the wrong zone, is caught by a test nobody had to think to write. That is the entire
 * value of a differential test, and it is why the fingerprint below is deliberately
 * wide rather than a summary of the interesting bits.
 *
 * Object ids line up between the two runs because both build the same board in the same
 * order from the same seed; something one script created and the other did not shows up as
 * a line the other side does not have, which is exactly the disagreement it is.
 */

export interface Disagreement {
  /** The scenario both scripts played. */
  readonly scenario: string;
  /** The line that differed, hand script first. */
  readonly detail: string;
}

export interface DifferentialResult {
  readonly oracleId: string;
  /** Scenarios both scripts played to the end. */
  readonly compared: number;
  /** Scenarios neither could be played in, which is not a failure. */
  readonly skipped: readonly string[];
  readonly disagreements: readonly Disagreement[];
}

export const differentialTest = (
  hand: CardDefinition,
  auto: CardDefinition,
  tests: readonly ScenarioTest[] = [],
): DifferentialResult => {
  const disagreements: Disagreement[] = [];
  const skipped: string[] = [];
  let compared = 0;

  for (const scenario of smokeScenarios) {
    if (scenario.onOpponentsTurn && (isSorcerySpeed(hand) || isSorcerySpeed(auto))) {
      skipped.push(`${scenario.name}: sorcery speed`);
      continue;
    }

    const left = attempt(() => playSmokeScenario(hand, scenario));
    const right = attempt(() => playSmokeScenario(auto, scenario));
    if (left === 'skipped' && right === 'skipped') {
      skipped.push(`${scenario.name}: nothing legal to target`);
      continue;
    }
    compared += 1;
    disagreements.push(...compare(scenario.name, left, right));
  }

  for (const test of tests) {
    // A test that names an ability by id is written against one of the two scripts, and
    // the other is free to call its abilities whatever it likes: an id is a label for the
    // script's own use, not a characteristic of the card. Comparing through one of those
    // would report a naming difference as a behavioural one, which is noise in the only
    // report that is supposed to be all signal.
    const named = test.activate ?? test.activateMana;
    if (named !== undefined && !(hasAbility(hand, named) && hasAbility(auto, named))) {
      skipped.push(`${test.name}: the two scripts name their abilities differently`);
      continue;
    }

    const left = attempt(() => playScenarioTest(hand, test).get());
    const right = attempt(() => playScenarioTest(auto, test).get());
    compared += 1;
    disagreements.push(...compare(test.name, left, right));
  }

  return { oracleId: hand.oracleId, compared, skipped, disagreements };
};

const hasAbility = (definition: CardDefinition, id: string): boolean =>
  definition.abilities.some((ability) => 'id' in ability && ability.id === id);

// --- Playing both sides ---

/** A game, a scenario that could not be played, or the message the engine threw. */
type Outcome = GameState | 'skipped' | { readonly threw: string };

const attempt = (play: () => GameState | 'skipped'): Outcome => {
  try {
    return play();
  } catch (error) {
    // A throw is a result too: one script blowing up where the other does not is the
    // loudest disagreement there is, and swallowing it would hide it.
    return { threw: (error as Error).message };
  }
};

const describe = (outcome: Outcome): string =>
  outcome === 'skipped'
    ? 'could not be played here'
    : `the engine threw — ${'threw' in outcome ? outcome.threw : ''}`;

/**
 * Two outcomes, and what differs. A run that never finished is reported as one line
 * rather than as a diff of the position it never reached: "the auto script threw" is the
 * whole story, and spelling out every line the other side had would bury it.
 */
const compare = (scenario: string, left: Outcome, right: Outcome): readonly Disagreement[] => {
  const finished = (outcome: Outcome): outcome is GameState =>
    outcome !== 'skipped' && !('threw' in outcome);

  if (!finished(left) || !finished(right)) {
    const ours = finished(left) ? 'played it to the end' : describe(left);
    const theirs = finished(right) ? 'played it to the end' : describe(right);
    return ours === theirs
      ? []
      : [{ scenario, detail: `hand script ${ours}; auto script ${theirs}` }];
  }

  const ours = fingerprint(left);
  const theirs = fingerprint(right);
  const missing = ours.filter((line) => !theirs.includes(line));
  const extra = theirs.filter((line) => !ours.includes(line));

  return [
    ...missing.map((line) => ({
      scenario,
      detail: `hand script has "${line}", the auto one does not`,
    })),
    ...extra.map((line) => ({
      scenario,
      detail: `auto script has "${line}", the hand one does not`,
    })),
  ];
};

// --- The fingerprint ---

/**
 * Everything about a finished game that a card could have changed, as sorted lines. Lines
 * rather than a hash, so a disagreement says what differed instead of only that something
 * did.
 */
const fingerprint = (state: GameState): readonly string[] => {
  const lines: string[] = [
    `turn ${state.turn} ${state.step}, active ${state.activePlayer}`,
    `result ${state.result === null ? 'none' : JSON.stringify(state.result)}`,
    `extra turns ${state.extraTurns.length}`,
    `decision ${state.pendingDecision?.kind ?? 'none'}`,
  ];

  for (const player of ['A', 'B'] as const) {
    lines.push(...playerLines(state, player));
  }

  for (const object of [...state.objects.keys()].sort((left, right) => left - right)) {
    lines.push(objectLine(state, object));
  }

  return lines;
};

const playerLines = (state: GameState, player: PlayerId): readonly string[] => {
  const seat = state.players[player];
  return [
    `${player} life ${seat.life}`,
    `${player} mana pool ${seat.manaPool.length}`,
    `${player} poison ${seat.poison}`,
    `${player} hand ${state.zones[`${player}:hand`].length}`,
    `${player} library ${state.zones[`${player}:library`].length}`,
    `${player} graveyard ${state.zones[`${player}:graveyard`].length}`,
  ];
};

const objectLine = (state: GameState, id: ObjectId): string => {
  const object = state.objects.get(id);
  if (object === undefined) return `${id} gone`;

  // Characteristics rather than the stored fields: a creature that is a 1/1 because of an
  // effect is not the same board position as one that is a 1/1 because it is printed that
  // way, and only the card's script can tell the two runs apart (CR 613).
  const now = characteristicsOf(state, id);
  const counters = Object.entries(object.counters)
    .filter(([, amount]) => amount !== 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, amount]) => `${kind}=${amount}`)
    .join(',');
  const keywords = Object.entries(now.keywords)
    .filter(([, has]) => has === true)
    .map(([keyword]) => keyword)
    .sort()
    .join(',');

  return [
    `${id} "${now.name ?? '?'}" in ${object.zone}`,
    `controlled by ${now.controller}`,
    `${now.power ?? '-'}/${now.toughness ?? '-'}`,
    `damage ${object.damage}`,
    object.tapped ? 'tapped' : 'untapped',
    `counters [${counters}]`,
    `keywords [${keywords}]`,
  ].join(', ');
};
