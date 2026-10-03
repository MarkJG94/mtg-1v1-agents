import {
  type CardDefinition,
  type CardType,
  characteristicsOf,
  hasType,
  manaValue,
  parseManaCost,
} from '@mtg/engine';
import { game, type Scenario } from '@mtg/engine/testing';
import { asOracleId, type EventTarget, type PlayerId } from '@mtg/shared';
import type { ScenarioTest } from './schema.js';

/**
 * Playing a card's own tests (docs/09 "Card tests").
 *
 * The test in the YAML is a description of a board, one action and an expectation; this
 * turns it into a real game and checks what actually happened. Nothing here knows anything
 * about any particular card — everything it does comes from the declaration — which is
 * what lets somebody add a test by copying the one above theirs.
 *
 * Failures come back as sentences rather than as a thrown assertion, so a test file can
 * report every card that broke instead of stopping at the first.
 */

const ANY_LAND = asOracleId('scenario-any-land');
const BAIT = asOracleId('scenario-bait');

/** The same any-colour land the validator's smoke test uses: cost is never the obstacle. */
const anyLand: CardDefinition = {
  oracleId: ANY_LAND,
  name: 'Test Land',
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

/**
 * Something for a counterspell to answer: a spell the opponent casts. A creature by
 * default, because that is what most cards that care about the stack are pointed at, and
 * whatever types the test asked for otherwise — "counter target noncreature spell" cannot
 * be tested against a creature.
 *
 * Flash, so it can be cast in the caster's own main phase: a counterspell can only be
 * tested against a spell that is actually on the stack when the caster has priority.
 */
const baitFor = (types: readonly CardType[]): CardDefinition => ({
  oracleId: BAIT,
  name: 'Test Bait',
  manaCost: parseManaCost('{1}'),
  types,
  colours: [],
  ...(types.includes('creature') ? { power: 1, toughness: 1 } : {}),
  flash: true,
  abilities: [],
});

/**
 * A definition for a permanent the setup asked for by type. Its oracle id is derived from
 * what the test declared, so the same prop in two tests is the same card and a game only
 * ever holds one definition for it.
 */
type PermanentSpec = NonNullable<NonNullable<ScenarioTest['setup']>['you']>['permanents'];

const propOracleId = (permanent: NonNullable<PermanentSpec>[number]) =>
  asOracleId(
    `scenario-prop-${permanent.types.join('-')}-${permanent.power ?? ''}-${permanent.toughness ?? ''}`,
  );

const propDefinition = (permanent: NonNullable<PermanentSpec>[number]): CardDefinition => ({
  oracleId: propOracleId(permanent),
  name: `Test ${permanent.types.join(' ')}`,
  manaCost: parseManaCost(''),
  types: permanent.types,
  colours: [],
  ...(permanent.power !== undefined ? { power: permanent.power } : {}),
  ...(permanent.toughness !== undefined ? { toughness: permanent.toughness } : {}),
  abilities: [],
});

/** `opponentSpell` as the runner wants it: a name and what kind of spell it is. */
const spellSpec = (
  spell: NonNullable<NonNullable<ScenarioTest['setup']>['opponentSpell']>,
): { readonly name: string; readonly types: readonly CardType[] } =>
  typeof spell === 'string' ? { name: spell, types: ['creature'] } : spell;

/** Play a card's scenario test and hand back the game, for the differential harness. */
export const playScenarioTest = (definition: CardDefinition, test: ScenarioTest): Scenario =>
  play(definition, test);

export const runScenarioTest = (
  definition: CardDefinition,
  test: ScenarioTest,
): readonly string[] => {
  try {
    return check(play(definition, test), test);
  } catch (error) {
    return [`threw: ${(error as Error).message}`];
  }
};

// --- Playing it ---

const play = (definition: CardDefinition, test: ScenarioTest): Scenario => {
  const lands = test.setup?.lands ?? Math.max(1, manaValue(definition.manaCost) + 1);
  const alreadyOut =
    hasType(definition, 'land') || test.activate !== undefined || test.activateMana !== undefined;
  const spell =
    test.setup?.opponentSpell === undefined ? null : spellSpec(test.setup.opponentSpell);
  const props = [
    ...(test.setup?.you?.permanents ?? []),
    ...(test.setup?.opponent?.permanents ?? []),
  ];

  let board: Scenario = game({
    definitions: [
      definition,
      anyLand,
      baitFor(spell?.types ?? ['creature']),
      ...props.map(propDefinition),
    ],
    seed: test.name,
  }).player('A');
  for (let i = 0; i < lands; i += 1) {
    board = board.battlefield({ name: `land${i}`, definitionId: ANY_LAND });
  }

  // A card being activated is already out; one being cast — or played, for a land — is in
  // hand. A land placed straight onto the battlefield never enters, so anything that
  // happens as it enters would silently not happen.
  board =
    alreadyOut && !hasType(definition, 'land')
      ? board.battlefield({ name: 'this', definitionId: definition.oracleId })
      : board.hand({ name: 'this', definitionId: definition.oracleId });

  board = withSide(board, 'A', test.setup?.you);
  board = board.player('B');
  if (spell !== null) {
    board = board
      .battlefield({ definitionId: ANY_LAND }, { definitionId: ANY_LAND })
      .hand({ name: spell.name, definitionId: BAIT });
  }
  board = withSide(board, 'B', test.setup?.opponent);

  let started = board.player('A').start().to('precombatMain');

  // The opponent casts first, in their own priority window, so there is a real spell on
  // the stack to answer rather than one poked into the zone. Casting it gives them
  // priority back (CR 117.3c), so they pass it on before the answer is cast.
  if (spell !== null) {
    started = started.pass().player('B').cast(spell.name).pass().player('A');
  }

  const targets = (test.targets ?? []).map((name) => targetFor(started, name));
  const acted = act(started, definition, test, targets);

  return test.kill === undefined ? acted : acted.kill(test.kill).resolve();
};

const act = (
  started: Scenario,
  definition: CardDefinition,
  test: ScenarioTest,
  targets: readonly EventTarget[],
): Scenario => {
  if (test.activateMana !== undefined) {
    const inPlay = hasType(definition, 'land') ? started.playLand('this') : started;
    return inPlay.activateMana('this', test.activateMana);
  }
  if (test.activate !== undefined) {
    const loyalty = definition.abilities.some(
      (ability) => ability.kind === 'loyalty' && ability.id === test.activate,
    );
    return loyalty
      ? started.activateLoyalty('this', test.activate, targets).resolve()
      : started.activate('this', test.activate, { targets }).resolve();
  }
  // A land is played, not cast (CR 305.1).
  if (hasType(definition, 'land')) return started.playLand('this');
  return started.cast('this', { targets }).resolve();
};

const withSide = (
  board: Scenario,
  player: PlayerId,
  side: ScenarioTest['setup'] extends undefined ? never : NonNullable<ScenarioTest['setup']>['you'],
): Scenario => {
  let next = board.library(10);
  for (const creature of side?.creatures ?? []) {
    next = next.battlefield({
      name: creature.name,
      power: creature.power,
      toughness: creature.toughness,
      ...(creature.keywords !== undefined
        ? { keywords: Object.fromEntries(creature.keywords.map((each) => [each, true])) }
        : {}),
      ...(creature.tapped !== undefined ? { tapped: creature.tapped } : {}),
    });
  }
  // A non-creature permanent is a card, not a bag of characteristics: its types come from
  // the definition built for it above, so `definitionId` rather than `power`/`toughness`.
  for (const permanent of side?.permanents ?? []) {
    next = next.battlefield({
      name: permanent.name,
      definitionId: propOracleId(permanent),
      ...(permanent.keywords !== undefined
        ? { keywords: Object.fromEntries(permanent.keywords.map((each) => [each, true])) }
        : {}),
      ...(permanent.tapped !== undefined ? { tapped: permanent.tapped } : {}),
    });
  }
  for (let i = 0; i < (side?.handSize ?? 0); i += 1) next = next.hand({});
  if (side?.life !== undefined) next = next.life(side.life);
  return next.player(player);
};

const targetFor = (scenario: Scenario, name: string): EventTarget =>
  name === 'you'
    ? { kind: 'player', player: 'A' }
    : name === 'opponent'
      ? { kind: 'player', player: 'B' }
      : scenario.target(name);

// --- Checking it ---

const check = (scenario: Scenario, test: ScenarioTest): readonly string[] => {
  const problems: string[] = [];
  const state = scenario.get();
  const seat = (who: string): PlayerId => (who === 'you' ? 'A' : 'B');
  const say = (what: string, expected: unknown, actual: unknown) =>
    problems.push(`${what}: expected ${String(expected)}, got ${String(actual)}`);

  for (const [who, life] of Object.entries(test.expect.life ?? {})) {
    const actual = scenario.lifeOf(seat(who));
    if (actual !== life) say(`${who}'s life`, life, actual);
  }

  for (const [who, size] of Object.entries(test.expect.handSize ?? {})) {
    const actual = state.zones[`${seat(who)}:hand`].length;
    if (actual !== size) say(`${who}'s hand`, size, actual);
  }

  for (const [who, count] of Object.entries(test.expect.permanents ?? {})) {
    // Control is a characteristic, not a stored field: a stolen creature still *says* it
    // belongs to its old controller (CR 613.1b), so this has to be asked properly.
    const actual = state.zones.battlefield.filter(
      (object) => characteristicsOf(state, object).controller === seat(who),
    ).length;
    if (actual !== count) say(`permanents ${who} controls`, count, actual);
  }

  for (const [name, zone] of Object.entries(test.expect.zone ?? {})) {
    const actual = scenario.zoneOf(name);
    if (actual !== zone) say(`where ${name} is`, zone, actual);
  }

  for (const [name, power] of Object.entries(test.expect.power ?? {})) {
    const actual = scenario.power(name);
    if (actual !== power) say(`${name}'s power`, power, actual);
  }

  for (const [name, toughness] of Object.entries(test.expect.toughness ?? {})) {
    const actual = scenario.toughness(name);
    if (actual !== toughness) say(`${name}'s toughness`, toughness, actual);
  }

  for (const [name, tapped] of Object.entries(test.expect.tapped ?? {})) {
    const actual = scenario.object(name).tapped;
    if (actual !== tapped) say(`whether ${name} is tapped`, tapped, actual);
  }

  for (const [name, counters] of Object.entries(test.expect.counters ?? {})) {
    for (const [kind, amount] of Object.entries(counters)) {
      const actual = scenario.object(name).counters[kind] ?? 0;
      if (actual !== amount) say(`${kind} counters on ${name}`, amount, actual);
    }
  }

  for (const [name, keywords] of Object.entries(test.expect.keywords ?? {})) {
    const actual = characteristicsOf(state, scenario.ref(name)).keywords;
    for (const keyword of keywords) {
      if (actual[keyword] !== true) problems.push(`${name} should have ${keyword}`);
    }
  }

  if (test.expect.manaPool !== undefined) {
    const actual = state.players.A.manaPool.length;
    if (actual !== test.expect.manaPool) say('mana in the pool', test.expect.manaPool, actual);
  }

  if (test.expect.extraTurns !== undefined) {
    const actual = state.extraTurns.length;
    if (actual !== test.expect.extraTurns) say('extra turns owed', test.expect.extraTurns, actual);
  }

  return problems;
};
