import {
  type CardDefinition,
  canBeTargeted,
  type EffectContext,
  type GameState,
  hasType,
  isSorcerySpeed,
  manaValue,
  matchesFilter,
  parseManaCost,
  spellAbilityOf,
  type TargetSpec,
} from '@mtg/engine';
import { checkRulesInvariants, game, type Scenario } from '@mtg/engine/testing';
import { asOracleId, type EventTarget, playerIds } from '@mtg/shared';
import type { CheckProblem } from './checks.js';

/**
 * The executability smoke test (docs/03 "Validation", step 4).
 *
 * A script can be shaped correctly, agree with Scryfall, claim every sentence, and still
 * be nonsense: a target the card cannot have, an op given an argument that makes the
 * engine throw, an ability that leaves the game with nothing to answer. The only way to
 * find that out is to play it.
 *
 * So the card is put into small synthetic games and cast. What is checked is not that it
 * did the right thing — no validator can know that — but that the engine came out the
 * other side in a legal, answerable state without throwing. A card that cannot be cast in
 * a scenario (no legal target on an empty board) is skipped there rather than failed:
 * having no target is a normal fact about Magic, not a broken script.
 */

export interface SmokeResult {
  readonly problems: readonly CheckProblem[];
  /** Scenarios where the card could not be cast at all, which is not a failure. */
  readonly skipped: readonly string[];
  readonly cast: number;
}

const ANY_LAND = asOracleId('validator-any-land');
const VANILLA = asOracleId('validator-vanilla');

/** A land that taps for any colour, so the card's own cost is never what stops it. */
const anyLand: CardDefinition = {
  oracleId: ANY_LAND,
  name: 'Validator Land',
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
        [{ type: 'C', amount: 1 }],
      ],
    },
  ],
};

const vanilla: CardDefinition = {
  oracleId: VANILLA,
  name: 'Validator Bear',
  manaCost: parseManaCost('{1}{G}'),
  types: ['creature'],
  colours: ['G'],
  power: 2,
  toughness: 2,
  abilities: [],
};

export interface SmokeScenario {
  readonly name: string;
  /** Creatures the opponent has out when the card is cast. */
  readonly opposing: number;
  /** Cast on the opponent's turn, which only something with flash can do. */
  readonly onOpponentsTurn: boolean;
}

/** Exported so the differential harness (docs/09) can play the same three boards. */
export const smokeScenarios: readonly SmokeScenario[] = [
  { name: 'an empty board', opposing: 0, onOpponentsTurn: false },
  { name: 'a 2/2 opposite', opposing: 1, onOpponentsTurn: false },
  { name: "the opponent's turn", opposing: 1, onOpponentsTurn: true },
];

/**
 * The most lands a scenario will build.
 *
 * The board is made big enough that the card's own cost is never what stops it, which is
 * a fine rule until a card costs `{1000000}`. Gleemax does, and the smoke test set about
 * building a million lands, three times, and never came back — found by running the
 * coverage report over every card Scryfall has, which is what that report is for.
 *
 * Twenty is past anything a real game pays; a card that wants more is skipped with a
 * reason, the way a card with no legal target is, rather than silently played on a board
 * that could not pay for it.
 */
const MOST_LANDS = 20;

export const smokeTest = (definition: CardDefinition): SmokeResult => {
  const problems: CheckProblem[] = [];
  const skipped: string[] = [];
  let cast = 0;

  for (const scenario of smokeScenarios) {
    if (scenario.onOpponentsTurn && isSorcerySpeed(definition)) {
      skipped.push(`${scenario.name}: sorcery speed`);
      continue;
    }
    if (landsFor(definition) > MOST_LANDS) {
      skipped.push(
        `${scenario.name}: costs ${manaValue(definition.manaCost)}, more than a board this ` +
          'size can pay',
      );
      continue;
    }

    try {
      const played = playSmokeScenario(definition, scenario);
      const outcome = played === 'skipped' ? 'skipped' : checkSettled(played);
      if (outcome === 'skipped') {
        skipped.push(`${scenario.name}: nothing legal to target`);
        continue;
      }
      cast += 1;
      problems.push(...outcome);
    } catch (error) {
      problems.push({
        check: 'executability',
        message: `${scenario.name}: the engine threw — ${(error as Error).message}`,
      });
    }
  }

  return { problems, skipped, cast };
};

/**
 * Play one scenario and hand back the game it left behind, or `'skipped'` when there was
 * nothing legal to target. The state rather than a verdict, because the differential
 * harness judges the same game by a different standard: not "is this legal" but "did the
 * two scripts do the same thing".
 */
export const playSmokeScenario = (
  definition: CardDefinition,
  scenario: SmokeScenario,
): GameState | 'skipped' => {
  // Enough lands to pay for anything a real card costs, and a library each so nobody decks
  // while the card is being tried.
  const lands = Math.min(landsFor(definition), MOST_LANDS);
  const caster = scenario.onOpponentsTurn ? 'B' : 'A';

  let board: Scenario = game({
    definitions: [definition, anyLand, vanilla],
    seed: 'validator',
  }).player(caster);
  for (let i = 0; i < lands; i += 1) board = board.battlefield({ definitionId: ANY_LAND });
  board = board.hand({ name: 'subject', definitionId: definition.oracleId }).library(10);

  board = board.player(caster === 'A' ? 'B' : 'A').library(10);
  for (let i = 0; i < scenario.opposing; i += 1) {
    board = board.battlefield({ definitionId: VANILLA });
  }

  // On the opponent's turn the caster only holds priority once the active player has
  // passed it (CR 117.3a), so the scenario has to get there before anything can be cast.
  const opened = board.start().to('precombatMain');
  const started = (scenario.onOpponentsTurn ? opened.pass() : opened).player(caster);

  // A land is played, not cast (CR 305.1), and playing it is the whole of its behaviour
  // until an ability of it is activated.
  if (hasType(definition, 'land')) return started.get();

  const targets = chooseTargets(started.get(), started.ref('subject'), caster, definition);
  if (targets === null) return 'skipped';

  return started.cast('subject', { targets }).resolve().get();
};

/**
 * What a card must leave behind: a legal position, and either a finished game or
 * something for a player to answer. A state that is neither is one the engine cannot be
 * driven out of, which is the failure this is looking for.
 */
const checkSettled = (state: GameState): readonly CheckProblem[] => {
  const problems = checkRulesInvariants(state).map((message) => ({
    check: 'executability' as const,
    message: `left the game in an illegal state: ${message}`,
  }));

  if (state.result === null && state.pendingDecision === null) {
    problems.push({
      check: 'executability',
      message: 'left the game with nothing to answer and no result',
    });
  }

  return problems;
};

const landsFor = (definition: CardDefinition): number =>
  Math.max(6, manaValue(definition.manaCost) + 2);

/** Legal targets for every target the card asks for, or `null` if there are none. */
const chooseTargets = (
  state: GameState,
  source: ReturnType<Scenario['ref']>,
  controller: (typeof playerIds)[number],
  definition: CardDefinition,
): readonly EventTarget[] | null => {
  const specs: readonly TargetSpec[] = spellAbilityOf(definition)?.targets ?? [];
  if (specs.length === 0) return [];

  const context: EffectContext = { source, controller, targets: {}, x: 0 };
  const chosen: EventTarget[] = [];

  for (const spec of specs) {
    const wanted = spec.count ?? 1;
    const legal = candidates(state).filter(
      (target) =>
        matchesFilter(state, context, spec.filter, target) &&
        canBeTargeted(state, target, { controller, colours: definition.colours }).legal &&
        !chosen.some((already) => sameTarget(already, target)),
    );

    if (legal.length < wanted) return spec.upTo === true ? chosen : null;
    chosen.push(...legal.slice(0, wanted));
  }

  return chosen;
};

const candidates = (state: GameState): readonly EventTarget[] => [
  ...playerIds.map((player) => ({ kind: 'player' as const, player })),
  ...state.zones.battlefield.map((object) => ({ kind: 'object' as const, object })),
  ...state.zones.stack.map((object) => ({ kind: 'object' as const, object })),
];

const sameTarget = (left: EventTarget, right: EventTarget): boolean =>
  left.kind === 'player' && right.kind === 'player'
    ? left.player === right.player
    : left.kind === 'object' && right.kind === 'object' && left.object === right.object;
