import type { CardDefinition, GameState } from '@mtg/engine';
import { Rng, step } from '@mtg/engine';
import { randomAnswer, scenario } from '@mtg/engine/testing';

export interface DifferentialResult {
  identical: boolean;
  differences: string[];
}

const BASICS: CardDefinition[] = (['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'] as const).map(
  (n) => ({
    id: `diff:${n}`,
    name: n,
    types: ['land'],
    supertypes: ['basic'],
    subtypes: [n],
  }),
);
const BEAR: CardDefinition = {
  id: 'diff:bear',
  name: 'Diff Bear',
  types: ['creature'],
  power: 2,
  toughness: 2,
};
const FILLER: CardDefinition = {
  id: 'diff:filler',
  name: 'Diff Filler',
  types: ['sorcery'],
  manaCost: '{9}',
  abilities: [{ kind: 'spell', effects: [{ op: 'noop' }] }],
};

/** A compact, definition-id-independent summary of a game state for comparing two scripts' behaviour. */
function summarize(s: GameState, names: Record<string, string>): string {
  const parts: string[] = [];
  for (const p of ['A', 'B'] as const) {
    const ps = s.players[p];
    parts.push(`${p}:life=${ps.life}`);
    for (const z of ['battlefield', 'graveyard', 'hand', 'exile'] as const) {
      const items = s.zones[p][z].map((id) => {
        const o = s.objects[id]!;
        const n = names[o.definitionId] ?? o.definitionId;
        return `${n}${o.tapped ? '(T)' : ''}${Object.keys(o.counters).length ? JSON.stringify(o.counters) : ''}`;
      });
      parts.push(`${p}.${z}=[${items.sort().join(',')}]`);
    }
  }
  parts.push(`result=${JSON.stringify(s.result)}`);
  return parts.join(' ');
}

/**
 * Differential test (docs/09 §2): two definitions of the same card must behave identically in the smoke
 * scenarios when driven by the same seeded random decisions.
 */
export function differentialTest(
  a: CardDefinition,
  b: CardDefinition,
  seeds: number[] = [1, 2, 3, 4, 5],
): DifferentialResult {
  const differences: string[] = [];
  const run = (def: CardDefinition, seed: number, opponentBoard: string[]): string => {
    const definitions: Record<string, CardDefinition> = {
      [def.id]: def,
      [BEAR.id]: BEAR,
      [FILLER.id]: FILLER,
    };
    for (const l of BASICS) definitions[l.id] = l;
    const names: Record<string, string> = { [def.id]: 'CARD' };
    const lands = BASICS.flatMap((l) => Array(6).fill(l.name) as string[]);
    const sc = scenario(definitions)
      .player('A')
      .hand(def.name)
      .battlefield(...lands)
      .library('Diff Filler', 'Diff Filler')
      .player('B')
      .battlefield(...opponentBoard)
      .library('Diff Filler', 'Diff Filler')
      .withSeed(seed)
      .start();
    let s = sc.state;
    const rng = Rng.from(`diff:${seed}`);
    let n = 0;
    const turn = s.turn;
    while (!s.result && s.pendingDecision && s.turn <= turn + 1 && n++ < 300) {
      const dec = s.pendingDecision;
      let answer = randomAnswer(s, dec, rng, { passBias: 0.4 });
      if (dec.kind === 'priority' && n === 1) {
        const play = dec.actions.find((x) => x.kind === 'cast' || x.kind === 'playLand');
        if (play) answer = { kind: 'priority', action: play };
      }
      s = step(s, answer).state;
    }
    return summarize(s, names);
  };
  for (const seed of seeds) {
    for (const board of [[], ['Diff Bear']]) {
      const ra = run(a, seed, board);
      const rb = run(b, seed, board);
      if (ra !== rb) differences.push(`seed ${seed}, board [${board}]:\n  A: ${ra}\n  B: ${rb}`);
    }
  }
  return { identical: differences.length === 0, differences };
}
