import type { CardDefinition, Decision, GameState } from '@mtg/engine';
import { Rng, step } from '@mtg/engine';
import { checkInvariants, randomAnswer, scenario } from '@mtg/engine/testing';

/** Helper cards for the synthetic smoke games; never part of any deck. */
const BASICS: CardDefinition[] = (['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'] as const).map(
  (n) => ({
    id: `smoke:${n}`,
    name: n,
    types: ['land'],
    supertypes: ['basic'],
    subtypes: [n],
  }),
);
const BEAR: CardDefinition = {
  id: 'smoke:bear',
  name: 'Smoke Bear',
  types: ['creature'],
  power: 2,
  toughness: 2,
};
const TRINKET: CardDefinition = {
  id: 'smoke:trinket',
  name: 'Smoke Trinket',
  types: ['artifact'],
  manaCost: '{1}',
};
const CHARM: CardDefinition = {
  id: 'smoke:charm',
  name: 'Smoke Charm',
  types: ['enchantment'],
  manaCost: '{1}',
};
const SPELL: CardDefinition = {
  id: 'smoke:spell',
  name: 'Smoke Spell',
  types: ['sorcery'],
  manaCost: '{1}',
  abilities: [{ kind: 'spell', effects: [{ op: 'noop' }] }],
};
const LIBRARY: CardDefinition = {
  id: 'smoke:filler',
  name: 'Smoke Filler',
  types: ['sorcery'],
  manaCost: '{9}',
  abilities: [{ kind: 'spell', effects: [{ op: 'noop' }] }],
};

export interface SmokeResult {
  ok: boolean;
  reasons: string[];
  /** Decisions answered across all scenarios. */
  decisions: number;
}

const STEP_BUDGET = 400;

function drive(
  state: GameState,
  rng: Rng,
  budget: number,
  until: (s: GameState) => boolean,
): { state: GameState; decisions: number } {
  let s = state;
  let n = 0;
  while (!s.result && s.pendingDecision && !until(s) && n < budget) {
    const dec: Decision = s.pendingDecision;
    const answer = randomAnswer(s, dec, rng, {
      passBias: dec.kind === 'priority' && dec.actions.length > 1 ? 0.5 : 0,
    });
    s = step(s, answer).state;
    checkInvariants(s);
    n++;
  }
  return { state: s, decisions: n };
}

/**
 * Executability smoke test (docs/03 §Validation.4): the card is put into synthetic games with plenty of mana —
 * an empty board, a board with a vanilla 2/2, and an opponent's turn with the caster holding priority — and
 * cast/played/activated with random choices. Any engine error, unfulfillable decision or budget overrun fails.
 */
export function smokeTest(def: CardDefinition, seeds: number[] = [1, 2, 3]): SmokeResult {
  const definitions: Record<string, CardDefinition> = {
    [def.id]: def,
    [BEAR.id]: BEAR,
    [LIBRARY.id]: LIBRARY,
    [TRINKET.id]: TRINKET,
    [CHARM.id]: CHARM,
    [SPELL.id]: SPELL,
  };
  for (const b of BASICS) definitions[b.id] = b;
  const reasons: string[] = [];
  let decisions = 0;

  const variants: {
    name: string;
    ownBoard: string[];
    opponentBoard: string[];
    opponentsTurn: boolean;
    respondTo: boolean;
  }[] = [
    {
      name: 'empty board',
      ownBoard: [],
      opponentBoard: [],
      opponentsTurn: false,
      respondTo: false,
    },
    {
      name: 'vanilla 2/2, artifact and enchantment on the other side',
      ownBoard: ['Smoke Bear'],
      opponentBoard: ['Smoke Bear', 'Smoke Trinket', 'Smoke Charm'],
      opponentsTurn: false,
      respondTo: false,
    },
    {
      name: "opponent's turn, holding priority",
      ownBoard: [],
      opponentBoard: ['Smoke Bear'],
      opponentsTurn: true,
      respondTo: false,
    },
    {
      name: "responding to the opponent's spell",
      ownBoard: [],
      opponentBoard: ['Smoke Bear'],
      opponentsTurn: true,
      respondTo: true,
    },
  ];

  for (const seed of seeds) {
    let playedSomewhere = false;
    for (const v of variants) {
      const rng = Rng.from(`smoke:${def.id}:${seed}:${v.name}`);
      try {
        const lands = BASICS.flatMap((b) => Array(6).fill(b.name) as string[]);
        let b = scenario(definitions)
          .player('A')
          .hand(def.name, 'Smoke Filler')
          .battlefield(...lands, ...v.ownBoard)
          .library('Smoke Filler', 'Smoke Filler', 'Smoke Filler')
          .player('B')
          .library('Smoke Filler', 'Smoke Filler', 'Smoke Filler')
          .battlefield(...v.opponentBoard, 'Forest', 'Forest')
          .hand(...(v.respondTo ? ['Smoke Spell'] : []));
        if (v.opponentsTurn) b = b.activePlayer('B');
        const sc = b.start();
        let s = sc.state;
        // On the opponent's turn B acts first: casts its spell when asked to, otherwise passes.
        if (v.opponentsTurn) {
          const first = s.pendingDecision;
          if (first?.kind === 'priority' && first.player === 'B') {
            const castSpell = v.respondTo
              ? first.actions.find((a) => a.kind === 'cast')
              : undefined;
            s = step(s, { kind: 'priority', action: castSpell ?? { kind: 'pass' } }).state;
            decisions++;
            if (castSpell) {
              const after = s.pendingDecision;
              if (after?.kind === 'priority' && after.player === 'B') {
                s = step(s, { kind: 'priority', action: { kind: 'pass' } }).state;
                decisions++;
              }
            }
          }
        }
        const dec = s.pendingDecision;
        if (dec?.kind !== 'priority' || dec.player !== 'A') continue;
        const cardId = Object.values(s.objects).find(
          (o) => o.definitionId === def.id && o.zone === 'hand',
        )?.id;
        if (cardId === undefined) throw new Error('card not in hand');
        const play = dec.actions.find(
          (a) => (a.kind === 'playLand' || a.kind === 'cast') && a.object === cardId,
        );
        if (!play) continue;
        playedSomewhere = true;
        s = step(s, { kind: 'priority', action: play }).state;
        checkInvariants(s);
        decisions++;
        let r = drive(
          s,
          rng,
          STEP_BUDGET,
          (x) =>
            x.pendingDecision?.kind === 'priority' && x.stack.length === 0 && x.frames.length === 0,
        );
        s = r.state;
        decisions += r.decisions;
        if (r.decisions >= STEP_BUDGET)
          reasons.push(`${v.name} (seed ${seed}): step budget exceeded while resolving`);
        if (s.result) continue;
        // Activate each activated/loyalty ability of the permanent once, if legal.
        for (let i = 0; i < 6 && !s.result; i++) {
          const d2 = s.pendingDecision;
          if (d2?.kind !== 'priority' || d2.player !== 'A') break;
          const act = d2.actions.find(
            (a) => (a.kind === 'activate' || a.kind === 'loyalty') && a.source === cardId,
          );
          if (!act) break;
          s = step(s, { kind: 'priority', action: act }).state;
          checkInvariants(s);
          decisions++;
          r = drive(
            s,
            rng,
            STEP_BUDGET,
            (x) =>
              x.pendingDecision?.kind === 'priority' &&
              x.stack.length === 0 &&
              x.frames.length === 0,
          );
          s = r.state;
          decisions += r.decisions;
          if (r.decisions >= STEP_BUDGET)
            reasons.push(`${v.name} (seed ${seed}): step budget exceeded after activating`);
        }
        // Let the turn finish so cleanup, end-step triggers and delayed triggers run.
        const turn = s.turn;
        r = drive(s, rng, STEP_BUDGET, (x) => x.turn > turn + 1);
        decisions += r.decisions;
        if (r.decisions >= STEP_BUDGET)
          reasons.push(`${v.name} (seed ${seed}): step budget exceeded finishing the turn`);
      } catch (e) {
        reasons.push(`${v.name} (seed ${seed}): ${(e as Error).message}`);
      }
    }
    if (!playedSomewhere)
      reasons.push(
        `seed ${seed}: card could not be played or cast in any scenario with 30 lands available`,
      );
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], decisions };
}
