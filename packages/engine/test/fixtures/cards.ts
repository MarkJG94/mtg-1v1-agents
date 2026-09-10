import type { AbilityDef, CardDefinition, Keyword } from '../../src/definition.js';

/**
 * Hand-built card definitions used only by engine tests and benchmarks. Names are Magic cards where the
 * definition matches the printed card, but the engine never depends on any of them.
 */
const list: CardDefinition[] = [];

function card(def: Omit<CardDefinition, 'id'>): CardDefinition {
  const full: CardDefinition = { id: def.name, ...def };
  list.push(full);
  return full;
}

function kw(...keywords: Keyword[]): AbilityDef[] {
  return keywords.map((k) => ({ kind: 'keyword', keyword: k }));
}

// ---- Lands ------------------------------------------------------------------------------------
for (const [name, color] of [
  ['Plains', 'W'],
  ['Island', 'U'],
  ['Swamp', 'B'],
  ['Mountain', 'R'],
  ['Forest', 'G'],
] as const) {
  card({ name, types: ['land'], supertypes: ['basic'], subtypes: [name], colors: [] });
  void color;
}
card({ name: 'Tropical Island', types: ['land'], subtypes: ['Forest', 'Island'] });
card({
  name: 'Simic Guildgate',
  types: ['land'],
  subtypes: ['Gate'],
  abilities: [
    { kind: 'replacement', replaces: { event: 'etb', filter: 'self', tapped: true } },
    { kind: 'mana', cost: { tap: true }, choice: ['{G}', '{U}'] },
  ],
});
card({
  name: 'City of Brass',
  types: ['land'],
  abilities: [{ kind: 'mana', cost: { tap: true }, anyColor: true }],
});
card({
  name: 'Wooded Foothills',
  types: ['land'],
  abilities: [
    {
      kind: 'activated',
      cost: { tap: true, life: 1, sacrifice: 'self' },
      effects: [
        {
          op: 'search',
          filter: { type: 'land', subtype: ['Mountain', 'Forest'] },
          count: 1,
          to: 'battlefield',
        },
      ],
    },
  ],
});
card({
  name: 'Karplusan Forest',
  types: ['land'],
  abilities: [
    { kind: 'mana', cost: { tap: true }, produces: '{C}' },
    { kind: 'mana', cost: { tap: true, life: 1 }, choice: ['{R}', '{G}'] },
  ],
});
card({
  name: 'Urborg, Tomb of Yawgmoth',
  types: ['land'],
  supertypes: ['legendary'],
  abilities: [
    { kind: 'static', effect: { type: 'addType', affects: { type: 'land' }, subtypes: ['Swamp'] } },
  ],
});
card({
  name: 'Wasteland',
  types: ['land'],
  abilities: [
    { kind: 'mana', cost: { tap: true }, produces: '{C}' },
    {
      kind: 'activated',
      cost: { tap: true, sacrifice: 'self' },
      targets: [{ id: 't', filter: { type: 'land', not: { supertype: 'basic' } } }],
      effects: [{ op: 'destroy', target: '$t' }],
    },
  ],
});

// ---- Vanilla and keyword creatures ------------------------------------------------------------
card({
  name: 'Grizzly Bears',
  manaCost: '{1}{G}',
  types: ['creature'],
  subtypes: ['Bear'],
  power: 2,
  toughness: 2,
});
card({
  name: 'Hill Giant',
  manaCost: '{3}{R}',
  types: ['creature'],
  subtypes: ['Giant'],
  power: 3,
  toughness: 3,
});
card({
  name: 'Trained Armodon',
  manaCost: '{1}{G}{G}',
  types: ['creature'],
  subtypes: ['Elephant'],
  power: 3,
  toughness: 3,
});
card({
  name: 'Centaur Courser',
  manaCost: '{2}{G}',
  types: ['creature'],
  subtypes: ['Centaur'],
  power: 3,
  toughness: 3,
});
card({
  name: 'Craw Wurm',
  manaCost: '{4}{G}{G}',
  types: ['creature'],
  subtypes: ['Wurm'],
  power: 6,
  toughness: 4,
});
card({
  name: 'Wind Drake',
  manaCost: '{2}{U}',
  types: ['creature'],
  subtypes: ['Drake'],
  power: 2,
  toughness: 2,
  abilities: kw('flying'),
});
card({
  name: 'Giant Spider',
  manaCost: '{3}{G}',
  types: ['creature'],
  subtypes: ['Spider'],
  power: 2,
  toughness: 4,
  abilities: kw('reach'),
});
card({
  name: 'Raging Goblin',
  manaCost: '{R}',
  types: ['creature'],
  subtypes: ['Goblin'],
  power: 1,
  toughness: 1,
  abilities: kw('haste'),
});
card({
  name: 'Serra Angel',
  manaCost: '{3}{W}{W}',
  types: ['creature'],
  subtypes: ['Angel'],
  power: 4,
  toughness: 4,
  abilities: kw('flying', 'vigilance'),
});
card({
  name: 'Vampire Nighthawk',
  manaCost: '{1}{B}{B}',
  types: ['creature'],
  subtypes: ['Vampire'],
  power: 2,
  toughness: 3,
  abilities: kw('flying', 'deathtouch', 'lifelink'),
});
card({
  name: 'Ambush Viper',
  manaCost: '{1}{G}',
  types: ['creature'],
  subtypes: ['Snake'],
  power: 2,
  toughness: 1,
  abilities: kw('flash', 'deathtouch'),
});
card({
  name: 'White Knight',
  manaCost: '{W}{W}',
  types: ['creature'],
  subtypes: ['Knight'],
  power: 2,
  toughness: 2,
  abilities: [
    { kind: 'keyword', keyword: 'first strike' },
    { kind: 'keyword', keyword: 'protection', from: { color: 'B' } },
  ],
});
card({
  name: 'Black Knight',
  manaCost: '{B}{B}',
  types: ['creature'],
  subtypes: ['Knight'],
  power: 2,
  toughness: 2,
  abilities: [
    { kind: 'keyword', keyword: 'first strike' },
    { kind: 'keyword', keyword: 'protection', from: { color: 'W' } },
  ],
});
card({
  name: 'Boros Swiftblade',
  manaCost: '{R}{W}',
  types: ['creature'],
  subtypes: ['Human'],
  power: 1,
  toughness: 2,
  abilities: kw('double strike'),
});
card({
  name: 'Boggart Brute',
  manaCost: '{2}{R}',
  types: ['creature'],
  subtypes: ['Goblin'],
  power: 3,
  toughness: 2,
  abilities: kw('menace'),
});
card({
  name: 'Rampaging Baloths',
  manaCost: '{4}{G}{G}',
  types: ['creature'],
  subtypes: ['Beast'],
  power: 6,
  toughness: 6,
  abilities: kw('trample'),
});
card({
  name: 'Phantom Warrior',
  manaCost: '{1}{U}{U}',
  types: ['creature'],
  subtypes: ['Illusion'],
  power: 2,
  toughness: 2,
  abilities: [{ kind: 'static', effect: { type: 'cantBeBlocked', affects: 'self' } }],
});
card({
  name: 'Wall of Stone',
  manaCost: '{1}{R}{R}',
  types: ['creature'],
  subtypes: ['Wall'],
  power: 0,
  toughness: 8,
  abilities: kw('defender'),
});
card({
  name: 'Darksteel Sentinel',
  manaCost: '{6}',
  types: ['artifact', 'creature'],
  subtypes: ['Golem'],
  power: 3,
  toughness: 3,
  abilities: kw('indestructible', 'vigilance', 'flash'),
});
card({
  name: 'Invisible Stalker',
  manaCost: '{1}{U}',
  types: ['creature'],
  subtypes: ['Human'],
  power: 1,
  toughness: 1,
  abilities: [
    { kind: 'keyword', keyword: 'hexproof' },
    { kind: 'static', effect: { type: 'cantBeBlocked', affects: 'self' } },
  ],
});
card({
  name: 'Silhana Ledgewalker',
  manaCost: '{1}{G}',
  types: ['creature'],
  subtypes: ['Elf'],
  power: 1,
  toughness: 1,
  abilities: [
    { kind: 'keyword', keyword: 'hexproof' },
    {
      kind: 'static',
      effect: { type: 'cantBeBlockedBy', affects: 'self', by: { lacksKeyword: 'flying' } },
    },
  ],
});
card({
  name: 'Simic Sky Swallower',
  manaCost: '{5}{G}{U}',
  types: ['creature'],
  subtypes: ['Leviathan'],
  power: 6,
  toughness: 6,
  abilities: kw('flying', 'trample', 'shroud'),
});
card({
  name: 'Warded Crocodile',
  manaCost: '{2}{G}',
  types: ['creature'],
  subtypes: ['Crocodile'],
  power: 3,
  toughness: 3,
  abilities: [{ kind: 'keyword', keyword: 'ward', cost: { mana: '{2}' } }],
});
card({
  name: 'Isamaru, Hound of Konda',
  manaCost: '{W}',
  types: ['creature'],
  supertypes: ['legendary'],
  subtypes: ['Dog'],
  power: 2,
  toughness: 2,
});
card({
  name: 'Drudge Skeletons',
  manaCost: '{1}{B}',
  types: ['creature'],
  subtypes: ['Skeleton'],
  power: 1,
  toughness: 1,
  abilities: [
    { kind: 'activated', cost: { mana: '{B}' }, effects: [{ op: 'regenerate', target: '~' }] },
  ],
});
card({
  name: 'Llanowar Elves',
  manaCost: '{G}',
  types: ['creature'],
  subtypes: ['Elf'],
  power: 1,
  toughness: 1,
  abilities: [{ kind: 'mana', cost: { tap: true }, produces: '{G}' }],
});
card({
  name: 'Prodigal Sorcerer',
  manaCost: '{2}{U}',
  types: ['creature'],
  subtypes: ['Human'],
  power: 1,
  toughness: 1,
  abilities: [
    {
      kind: 'activated',
      cost: { tap: true },
      targets: [{ id: 't', filter: { any: true } }],
      effects: [{ op: 'damage', amount: 1, to: '$t' }],
    },
  ],
});
card({
  name: 'Mogg Fanatic',
  manaCost: '{R}',
  types: ['creature'],
  subtypes: ['Goblin'],
  power: 1,
  toughness: 1,
  abilities: [
    {
      kind: 'activated',
      cost: { sacrifice: 'self' },
      targets: [{ id: 't', filter: { any: true } }],
      effects: [{ op: 'damage', amount: 1, to: '$t' }],
    },
  ],
});
card({
  name: 'Elvish Visionary',
  manaCost: '{1}{G}',
  types: ['creature'],
  subtypes: ['Elf'],
  power: 1,
  toughness: 1,
  abilities: [{ kind: 'triggered', trigger: { on: 'etb' }, effects: [{ op: 'draw', count: 1 }] }],
});
card({
  name: 'Blood Artist',
  manaCost: '{1}{B}',
  types: ['creature'],
  subtypes: ['Vampire'],
  power: 0,
  toughness: 1,
  abilities: [
    {
      kind: 'triggered',
      trigger: { on: 'dies', filter: { type: 'creature' } },
      targets: [{ id: 'p', filter: { player: 'any' } }],
      effects: [
        { op: 'loseLife', amount: 1, player: '$p' },
        { op: 'gainLife', amount: 1 },
      ],
    },
  ],
});
card({
  name: "Ajani's Pridemate",
  manaCost: '{1}{W}',
  types: ['creature'],
  subtypes: ['Cat'],
  power: 2,
  toughness: 2,
  abilities: [
    {
      kind: 'triggered',
      trigger: { on: 'lifeGain' },
      effects: [{ op: 'addCounters', target: '~', counter: '+1/+1', count: 1 }],
    },
  ],
});
card({
  name: 'Grim Lavamancer',
  manaCost: '{R}',
  types: ['creature'],
  subtypes: ['Human'],
  power: 1,
  toughness: 1,
  abilities: [
    {
      kind: 'activated',
      cost: { mana: '{R}', tap: true, exileFromGraveyard: { count: 2 } },
      targets: [{ id: 't', filter: { any: true } }],
      effects: [{ op: 'damage', amount: 2, to: '$t' }],
    },
  ],
});
card({
  name: 'Kitchen Finks',
  manaCost: '{1}{G/W}{G/W}',
  types: ['creature'],
  subtypes: ['Ouphe'],
  power: 3,
  toughness: 2,
  abilities: [
    { kind: 'triggered', trigger: { on: 'etb' }, effects: [{ op: 'gainLife', amount: 2 }] },
  ],
});
card({
  name: 'Gitaxian Probe',
  manaCost: '{U/P}',
  types: ['sorcery'],
  abilities: [
    {
      kind: 'spell',
      effects: [
        { op: 'reveal', hand: 'opponent' },
        { op: 'draw', count: 1 },
      ],
    },
  ],
});
card({
  name: 'Wall of Omens',
  manaCost: '{1}{W}',
  types: ['creature'],
  subtypes: ['Wall'],
  power: 0,
  toughness: 4,
  abilities: [
    { kind: 'keyword', keyword: 'defender' },
    { kind: 'triggered', trigger: { on: 'etb' }, effects: [{ op: 'draw', count: 1 }] },
  ],
});
card({
  name: 'Tarmogoyf',
  manaCost: '{1}{G}',
  types: ['creature'],
  subtypes: ['Lhurgoyf'],
  power: { countTypes: 'inAllGraveyards' },
  toughness: { add: [{ countTypes: 'inAllGraveyards' }, 1] },
});
card({
  name: 'Ball Lightning',
  manaCost: '{R}{R}{R}',
  types: ['creature'],
  subtypes: ['Elemental'],
  power: 6,
  toughness: 1,
  abilities: [
    { kind: 'keyword', keyword: 'trample' },
    { kind: 'keyword', keyword: 'haste' },
    {
      kind: 'triggered',
      trigger: { on: 'endStep', who: 'any' },
      effects: [{ op: 'sacrifice', target: '~' }],
    },
  ],
});
card({
  name: 'Intervening Angel',
  manaCost: '{2}{W}',
  types: ['creature'],
  subtypes: ['Angel'],
  power: 2,
  toughness: 2,
  abilities: [
    { kind: 'keyword', keyword: 'flying' },
    // "At the beginning of your upkeep, if you control another creature, you gain 2 life."
    {
      kind: 'triggered',
      trigger: { on: 'upkeep' },
      condition: { controls: { type: 'creature', other: true } },
      effects: [{ op: 'gainLife', amount: 2 }],
    },
  ],
});
card({
  name: 'Goblin Piker',
  manaCost: '{1}{R}',
  types: ['creature'],
  subtypes: ['Goblin'],
  power: 2,
  toughness: 1,
});
card({
  name: 'Jackal Familiar',
  manaCost: '{R}',
  types: ['creature'],
  subtypes: ['Jackal'],
  power: 2,
  toughness: 2,
  abilities: [
    {
      kind: 'static',
      effect: { type: 'cantAttack', affects: 'self' },
      condition: { not: { controls: { type: 'creature', other: true } } },
    },
    {
      kind: 'static',
      effect: { type: 'cantBlock', affects: 'self' },
      condition: { not: { controls: { type: 'creature', other: true } } },
    },
  ],
});

// ---- Instants and sorceries -------------------------------------------------------------------
card({
  name: 'Lightning Bolt',
  manaCost: '{R}',
  types: ['instant'],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 't', filter: { any: true } }],
      effects: [{ op: 'damage', amount: 3, to: '$t' }],
    },
  ],
});
card({
  name: 'Shock',
  manaCost: '{R}',
  types: ['instant'],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 't', filter: { any: true } }],
      effects: [{ op: 'damage', amount: 2, to: '$t' }],
    },
  ],
});
card({
  name: 'Sudden Shock',
  manaCost: '{1}{R}',
  types: ['instant'],
  abilities: [
    { kind: 'keyword', keyword: 'split second' },
    {
      kind: 'spell',
      targets: [{ id: 't', filter: { any: true } }],
      effects: [{ op: 'damage', amount: 2, to: '$t' }],
    },
  ],
});
card({
  name: 'Fireball',
  manaCost: '{X}{R}',
  types: ['sorcery'],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 't', filter: { any: true } }],
      effects: [{ op: 'damage', amount: 'x', to: '$t' }],
    },
  ],
});
card({
  name: 'Giant Growth',
  manaCost: '{G}',
  types: ['instant'],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 't', filter: { type: 'creature' } }],
      effects: [{ op: 'pump', target: '$t', power: 3, toughness: 3 }],
    },
  ],
});
card({
  name: 'Counterspell',
  manaCost: '{U}{U}',
  types: ['instant'],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 't', filter: { spell: true } }],
      effects: [{ op: 'counter', target: '$t' }],
    },
  ],
});
card({
  name: 'Mana Leak',
  manaCost: '{1}{U}',
  types: ['instant'],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 't', filter: { spell: true } }],
      effects: [
        {
          op: 'unless',
          player: '$t',
          cost: { mana: '{3}' },
          effects: [{ op: 'counter', target: '$t' }],
        },
      ],
    },
  ],
});
card({
  name: 'Abrupt Decay',
  manaCost: '{B}{G}',
  types: ['instant'],
  abilities: [
    { kind: 'keyword', keyword: 'cant be countered' },
    {
      kind: 'spell',
      targets: [{ id: 't', filter: { notType: 'land', mvLTE: 3 } }],
      effects: [{ op: 'destroy', target: '$t' }],
    },
  ],
});
card({
  name: 'Doom Blade',
  manaCost: '{1}{B}',
  types: ['instant'],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 't', filter: { type: 'creature', not: { color: 'B' } } }],
      effects: [{ op: 'destroy', target: '$t' }],
    },
  ],
});
card({
  name: 'Wrath of God',
  manaCost: '{2}{W}{W}',
  types: ['sorcery'],
  abilities: [
    {
      kind: 'spell',
      effects: [{ op: 'destroyAll', filter: { type: 'creature' }, noRegenerate: true }],
    },
  ],
});
card({
  name: 'Pyroclasm',
  manaCost: '{1}{R}',
  types: ['sorcery'],
  abilities: [
    { kind: 'spell', effects: [{ op: 'damageEach', filter: { type: 'creature' }, amount: 2 }] },
  ],
});
card({
  name: 'Idle Engine',
  manaCost: '{1}',
  types: ['artifact'],
  abilities: [{ kind: 'activated', cost: {}, effects: [{ op: 'noop' }] }],
});
card({
  name: 'Naturalize',
  manaCost: '{1}{G}',
  types: ['instant'],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 't', filter: { type: ['artifact', 'enchantment'] } }],
      effects: [{ op: 'destroy', target: '$t' }],
    },
  ],
});
card({
  name: 'Divination',
  manaCost: '{2}{U}',
  types: ['sorcery'],
  abilities: [{ kind: 'spell', effects: [{ op: 'draw', count: 2 }] }],
});
card({
  name: 'Dark Ritual',
  manaCost: '{B}',
  types: ['instant'],
  abilities: [{ kind: 'spell', effects: [{ op: 'addMana', mana: '{B}{B}{B}' }] }],
});
card({
  name: 'Unsummon',
  manaCost: '{U}',
  types: ['instant'],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 't', filter: { type: 'creature' } }],
      effects: [{ op: 'bounce', target: '$t' }],
    },
  ],
});
card({
  name: 'Mind Rot',
  manaCost: '{2}{B}',
  types: ['sorcery'],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 'p', filter: { player: 'any' } }],
      effects: [{ op: 'discard', count: 2, player: '$p' }],
    },
  ],
});
card({
  name: 'Rampant Growth',
  manaCost: '{1}{G}',
  types: ['sorcery'],
  abilities: [
    {
      kind: 'spell',
      effects: [
        {
          op: 'search',
          filter: { type: 'land', supertype: 'basic' },
          count: 1,
          to: 'battlefield',
          tapped: true,
        },
      ],
    },
  ],
});
card({
  name: 'Fog',
  manaCost: '{G}',
  types: ['instant'],
  abilities: [
    {
      kind: 'spell',
      effects: [
        {
          op: 'createEffect',
          effect: {
            type: 'preventDamage',
            affects: { anyPermanent: true },
            amount: 'all',
            combat: true,
          },
          duration: 'untilEndOfTurn',
        },
        {
          op: 'createEffect',
          effect: { type: 'preventDamage', affects: 'you', amount: 'all', combat: true },
          duration: 'untilEndOfTurn',
        },
        {
          op: 'createEffect',
          effect: { type: 'preventDamage', affects: 'you', amount: 'all', combat: true },
          duration: 'untilEndOfTurn',
        },
      ],
    },
  ],
});
card({
  name: 'Healing Salve',
  manaCost: '{W}',
  types: ['instant'],
  abilities: [
    {
      kind: 'spell',
      modes: [
        {
          label: 'gain 3 life',
          targets: [{ id: 'p', filter: { player: 'any' } }],
          effects: [{ op: 'gainLife', amount: 3, player: '$p' }],
        },
        {
          label: 'prevent 3 damage',
          targets: [{ id: 't', filter: { any: true } }],
          effects: [{ op: 'preventDamage', target: '$t', amount: 3 }],
        },
      ],
      effects: [],
    },
  ],
});
card({
  name: 'Raise the Alarm',
  manaCost: '{1}{W}',
  types: ['instant'],
  abilities: [
    {
      kind: 'spell',
      effects: [
        {
          op: 'createToken',
          token: {
            name: 'Soldier',
            types: ['creature'],
            subtypes: ['Soldier'],
            colors: ['W'],
            power: 1,
            toughness: 1,
          },
          count: 2,
        },
      ],
    },
  ],
});
card({
  name: 'Threaten',
  manaCost: '{2}{R}',
  types: ['sorcery'],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 't', filter: { type: 'creature' } }],
      effects: [
        { op: 'gainControl', target: '$t', duration: 'untilEndOfTurn' },
        { op: 'untap', target: '$t' },
        { op: 'grantAbility', target: '$t', ability: { kind: 'keyword', keyword: 'haste' } },
      ],
    },
  ],
});
card({
  name: 'Prey Upon',
  manaCost: '{G}',
  types: ['sorcery'],
  abilities: [
    {
      kind: 'spell',
      targets: [
        { id: 'a', filter: { type: 'creature', controller: 'you' } },
        { id: 'b', filter: { type: 'creature', controller: 'opponent' } },
      ],
      effects: [{ op: 'fight', a: '$a', b: '$b' }],
    },
  ],
});
card({
  name: 'Temporary Beast',
  manaCost: '{2}{G}',
  types: ['sorcery'],
  abilities: [
    {
      kind: 'spell',
      effects: [
        {
          op: 'createToken',
          token: {
            name: 'Beast',
            types: ['creature'],
            subtypes: ['Beast'],
            colors: ['G'],
            power: 3,
            toughness: 3,
          },
        },
        {
          op: 'delayedTrigger',
          trigger: { on: 'nextEndStep' },
          effects: [
            {
              op: 'forEach',
              filter: { name: 'Beast', controller: 'you', isToken: true },
              as: 'b',
              effects: [{ op: 'sacrifice', target: 'b' }],
            },
          ],
        },
      ],
    },
  ],
});
card({
  name: 'Time Walk',
  manaCost: '{1}{U}',
  types: ['sorcery'],
  abilities: [{ kind: 'spell', effects: [{ op: 'extraTurn' }] }],
});
card({
  name: 'Preordain',
  manaCost: '{U}',
  types: ['sorcery'],
  abilities: [
    {
      kind: 'spell',
      effects: [
        { op: 'scry', count: 2 },
        { op: 'draw', count: 1 },
      ],
    },
  ],
});
card({
  name: 'Sign in Blood',
  manaCost: '{B}{B}',
  types: ['sorcery'],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 'p', filter: { player: 'any' } }],
      effects: [
        { op: 'draw', count: 2, player: '$p' },
        { op: 'loseLife', amount: 2, player: '$p' },
      ],
    },
  ],
});
card({
  name: 'Fling',
  manaCost: '{1}{R}',
  types: ['instant'],
  abilities: [
    {
      kind: 'spell',
      additionalCost: { sacrifice: { type: 'creature' } },
      targets: [{ id: 't', filter: { any: true } }],
      effects: [{ op: 'damage', amount: 2, to: '$t' }],
    },
  ],
});
card({
  name: 'Tormenting Voice',
  manaCost: '{1}{R}',
  types: ['sorcery'],
  abilities: [
    { kind: 'spell', additionalCost: { discard: 1 }, effects: [{ op: 'draw', count: 2 }] },
  ],
});
card({
  name: 'Swords to Plowshares',
  manaCost: '{W}',
  types: ['instant'],
  abilities: [
    {
      kind: 'spell',
      targets: [{ id: 't', filter: { type: 'creature' } }],
      effects: [
        { op: 'bind', as: 'p', value: { power: '$t' } },
        { op: 'exile', target: '$t' },
        { op: 'gainLife', amount: { bound: 'p' }, player: '$t' },
      ],
    },
  ],
});

// ---- Enchantments, artifacts, auras -----------------------------------------------------------
card({
  name: 'Glorious Anthem',
  manaCost: '{1}{W}{W}',
  types: ['enchantment'],
  abilities: [
    {
      kind: 'static',
      effect: {
        type: 'pt',
        affects: { type: 'creature', controller: 'you' },
        power: 1,
        toughness: 1,
      },
    },
  ],
});
card({
  name: 'Humility',
  manaCost: '{2}{W}{W}',
  types: ['enchantment'],
  abilities: [
    {
      kind: 'static',
      effect: { type: 'loseAbility', affects: { type: 'creature' }, keyword: 'all' },
      also: [{ type: 'setPT', affects: { type: 'creature' }, power: 1, toughness: 1 }],
    },
  ],
});
card({
  name: 'Blood Moon',
  manaCost: '{2}{R}',
  types: ['enchantment'],
  abilities: [
    {
      kind: 'static',
      effect: {
        type: 'setTypes',
        affects: { type: 'land', not: { supertype: 'basic' } },
        types: ['land'],
        subtypes: ['Mountain'],
      },
    },
  ],
});
card({
  name: 'Opalescence',
  manaCost: '{2}{W}{W}',
  types: ['enchantment'],
  abilities: [
    {
      kind: 'static',
      effect: {
        type: 'addType',
        affects: { type: 'enchantment', other: true, not: { subtype: 'Aura' } },
        types: ['creature'],
      },
      also: [
        {
          type: 'setPT',
          affects: { type: 'enchantment', other: true, not: { subtype: 'Aura' } },
          power: { manaValue: 'self' },
          toughness: { manaValue: 'self' },
        },
      ],
    },
  ],
});
card({
  name: 'Pacifism',
  manaCost: '{1}{W}',
  types: ['enchantment'],
  subtypes: ['Aura'],
  abilities: [
    { kind: 'spell', targets: [{ id: 'e', filter: { type: 'creature' } }], effects: [] },
    {
      kind: 'static',
      effect: { type: 'cantAttack', affects: 'attached' },
      also: [{ type: 'cantBlock', affects: 'attached' }],
    },
  ],
});
card({
  name: 'Control Magic',
  manaCost: '{2}{U}{U}',
  types: ['enchantment'],
  subtypes: ['Aura'],
  abilities: [
    { kind: 'spell', targets: [{ id: 'e', filter: { type: 'creature' } }], effects: [] },
    { kind: 'static', effect: { type: 'control', affects: 'attached', controller: 'you' } },
  ],
});
card({
  name: 'Holy Strength',
  manaCost: '{W}',
  types: ['enchantment'],
  subtypes: ['Aura'],
  abilities: [
    { kind: 'spell', targets: [{ id: 'e', filter: { type: 'creature' } }], effects: [] },
    { kind: 'static', effect: { type: 'pt', affects: 'attached', power: 1, toughness: 2 } },
  ],
});
card({
  name: 'Bonesplitter',
  manaCost: '{1}',
  types: ['artifact'],
  subtypes: ['Equipment'],
  abilities: [
    { kind: 'static', effect: { type: 'pt', affects: 'attached', power: 2, toughness: 0 } },
    {
      kind: 'activated',
      cost: { mana: '{1}' },
      timing: 'sorcery',
      targets: [{ id: 'c', filter: { type: 'creature', controller: 'you' } }],
      effects: [{ op: 'attach', target: '~', to: '$c' }],
    },
  ],
});
card({
  name: 'Sol Ring',
  manaCost: '{1}',
  types: ['artifact'],
  abilities: [{ kind: 'mana', cost: { tap: true }, produces: '{C}{C}' }],
});
card({
  name: 'Rest in Peace',
  manaCost: '{1}{W}',
  types: ['enchantment'],
  abilities: [
    {
      kind: 'replacement',
      replaces: { event: 'dies', filter: { type: 'creature' }, instead: 'exile' },
    },
  ],
});
card({
  name: 'Hardened Scales',
  manaCost: '{G}',
  types: ['enchantment'],
  abilities: [
    {
      kind: 'replacement',
      replaces: {
        event: 'counterPlaced',
        filter: { type: 'creature', controller: 'you' },
        extra: 1,
      },
    },
  ],
});
card({
  name: 'Circle of Protection: Red',
  manaCost: '{1}{W}',
  types: ['enchantment'],
  abilities: [
    {
      kind: 'replacement',
      replaces: { event: 'damage', to: 'you', prevent: 'all', from: { color: 'R' } },
    },
  ],
});
card({
  name: "Thalia's Tax",
  manaCost: '{1}{W}',
  types: ['enchantment'],
  abilities: [
    {
      kind: 'static',
      effect: { type: 'costIncrease', affects: { notType: 'creature' }, amount: 1 },
    },
  ],
});
card({
  name: 'Reliquary Tower',
  types: ['land'],
  abilities: [
    { kind: 'mana', cost: { tap: true }, produces: '{C}' },
    { kind: 'static', effect: { type: 'maxHandSize', player: 'you', size: 'unlimited' } },
  ],
});

// ---- Planeswalkers ----------------------------------------------------------------------------
card({
  name: 'Jace Beleren',
  manaCost: '{1}{U}{U}',
  types: ['planeswalker'],
  subtypes: ['Jace'],
  loyalty: 3,
  abilities: [
    {
      kind: 'loyalty',
      cost: 2,
      effects: [{ op: 'forEachPlayer', as: 'p', effects: [{ op: 'draw', count: 1, player: 'p' }] }],
    },
    {
      kind: 'loyalty',
      cost: -1,
      targets: [{ id: 'p', filter: { player: 'any' } }],
      effects: [{ op: 'draw', count: 1, player: '$p' }],
    },
    {
      kind: 'loyalty',
      cost: -10,
      targets: [{ id: 'p', filter: { player: 'any' } }],
      effects: [{ op: 'mill', count: 20, player: '$p' }],
    },
  ],
});
card({
  name: 'Ajani Goldmane',
  manaCost: '{2}{W}{W}',
  types: ['planeswalker'],
  subtypes: ['Ajani'],
  loyalty: 4,
  abilities: [
    { kind: 'loyalty', cost: 1, effects: [{ op: 'gainLife', amount: 2 }] },
    {
      kind: 'loyalty',
      cost: -1,
      effects: [
        {
          op: 'forEach',
          filter: { type: 'creature', controller: 'you' },
          as: 'c',
          effects: [{ op: 'addCounters', target: 'c', counter: '+1/+1', count: 1 }],
        },
      ],
    },
  ],
});

export const CARDS: Record<string, CardDefinition> = Object.fromEntries(list.map((c) => [c.id, c]));

export function names(...ns: string[]): string[] {
  for (const n of ns) if (!CARDS[n]) throw new Error(`unknown test card ${n}`);
  return ns;
}

/** A simple 40-card mono-red deck for random-game fuzzing. */
export function redDeck(): string[] {
  const out: string[] = [];
  const add = (n: string, k: number) => {
    for (let i = 0; i < k; i++) out.push(n);
  };
  add('Mountain', 16);
  add('Raging Goblin', 4);
  add('Goblin Piker', 4);
  add('Hill Giant', 3);
  add('Boggart Brute', 3);
  add('Lightning Bolt', 4);
  add('Shock', 3);
  add('Fireball', 2);
  add('Mogg Fanatic', 1);
  return out;
}

/** A 40-card green-white deck with a broader mechanic mix. */
export function greenWhiteDeck(): string[] {
  const out: string[] = [];
  const add = (n: string, k: number) => {
    for (let i = 0; i < k; i++) out.push(n);
  };
  add('Forest', 9);
  add('Plains', 7);
  add('Llanowar Elves', 3);
  add('Grizzly Bears', 3);
  add('Elvish Visionary', 2);
  add('Serra Angel', 2);
  add('White Knight', 2);
  add('Giant Spider', 2);
  add('Kitchen Finks', 2);
  add('Giant Growth', 2);
  add('Pacifism', 1);
  add('Glorious Anthem', 1);
  add('Raise the Alarm', 1);
  add('Wrath of God', 1);
  add('Ajani Goldmane', 1);
  add('Rampant Growth', 1);
  return out;
}

/** A 40-card blue-black deck with counters, removal and card draw. */
export function blueBlackDeck(): string[] {
  const out: string[] = [];
  const add = (n: string, k: number) => {
    for (let i = 0; i < k; i++) out.push(n);
  };
  add('Island', 8);
  add('Swamp', 8);
  add('Wind Drake', 3);
  add('Vampire Nighthawk', 2);
  add('Phantom Warrior', 2);
  add('Prodigal Sorcerer', 2);
  add('Drudge Skeletons', 2);
  add('Blood Artist', 2);
  add('Counterspell', 2);
  add('Mana Leak', 2);
  add('Doom Blade', 2);
  add('Unsummon', 1);
  add('Divination', 1);
  add('Mind Rot', 1);
  add('Jace Beleren', 1);
  add('Dark Ritual', 1);
  return out;
}
