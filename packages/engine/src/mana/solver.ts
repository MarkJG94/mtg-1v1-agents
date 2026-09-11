import type { Color, ManaType, ObjectId, PlayerId } from '@mtg/shared';
import { COLORS } from '@mtg/shared';
import { characteristics } from '../characteristics.js';
import type { AbilityDef } from '../definition.js';
import { getObj } from '../draft.js';
import { evalCondition, simpleCtx } from '../eval.js';
import type { GameState } from '../state.js';
import { type ManaCost, type ManaPool, parseMana } from './cost.js';

/** A permanent's mana ability that could be activated right now, with every mana combination it can produce. */
export interface ManaSource {
  object: ObjectId;
  ability: number;
  options: ManaType[][];
  /** Number of distinct mana types across options; lower is less flexible. */
  flexibility: number;
}

export interface PaymentPlan {
  /** Sources to activate and which option (index into `options`) to produce. */
  taps: { source: ObjectId; ability: number; mana: ManaType[] }[];
  /** Every mana unit spent (from the pool and from the taps). */
  used: ManaType[];
  lifePaid: number;
}

/** A "pip" is one unit of cost; `accepts` are the mana types that can pay it. */
interface Pip {
  accepts: ManaType[];
}

/** A symbol with alternatives (phyrexian: colour or 2 life; {2/W}: W or two generic). */
interface Alternative {
  pips: Pip[];
  life: number;
}

const ALL: ManaType[] = ['W', 'U', 'B', 'R', 'G', 'C'];

export function costToPips(cost: ManaCost, x: number): { fixed: Pip[]; choices: Alternative[][] } {
  const fixed: Pip[] = [];
  const choices: Alternative[][] = [];
  for (const s of cost.symbols) {
    switch (s.kind) {
      case 'generic':
        for (let i = 0; i < s.amount; i++) fixed.push({ accepts: ALL });
        break;
      case 'x':
        for (let i = 0; i < x; i++) fixed.push({ accepts: ALL });
        break;
      case 'colored':
        fixed.push({ accepts: [s.color] });
        break;
      case 'colorless':
        fixed.push({ accepts: ['C'] });
        break;
      case 'snow':
        fixed.push({ accepts: ALL });
        break;
      case 'hybrid':
        fixed.push({ accepts: [s.colors[0], s.colors[1]] });
        break;
      case 'monoHybrid': {
        const generic: Pip[] = [];
        for (let i = 0; i < s.generic; i++) generic.push({ accepts: ALL });
        choices.push([
          { pips: [{ accepts: [s.color] }], life: 0 },
          { pips: generic, life: 0 },
        ]);
        break;
      }
      case 'phyrexian':
        choices.push([
          { pips: [{ accepts: [s.color] }], life: 0 },
          { pips: [], life: 2 },
        ]);
        break;
      case 'phyrexianHybrid':
        choices.push([
          { pips: [{ accepts: [s.colors[0], s.colors[1]] }], life: 0 },
          { pips: [], life: 2 },
        ]);
        break;
    }
  }
  return { fixed, choices };
}

/** Mana abilities of permanents the player controls that can be activated now (untapped, not summoning sick if a creature). */
export function manaSources(d: GameState, player: PlayerId): ManaSource[] {
  const out: ManaSource[] = [];
  for (const id of d.zones[player].battlefield) {
    const o = getObj(d, id);
    const c = characteristics(d, id);
    if (c.controller !== player) continue;
    c.abilities.forEach((a: AbilityDef, i) => {
      if (a.kind !== 'mana') return;
      if (a.cost.tap && o.tapped) return;
      if (a.cost.tap && c.types.includes('creature') && o.sick && !c.keywords.has('haste')) return;
      if (a.cost.sacrifice) return; // sacrifice mana sources are never auto-activated
      if (a.cost.life !== undefined && d.players[player].life <= a.cost.life) return;
      if (a.condition && !evalCondition(d, a.condition, simpleCtx(d, player, id))) return;
      const options: ManaType[][] = [];
      if (a.produces) options.push(parseMana(a.produces));
      if (a.choice) for (const ch of a.choice) options.push(parseMana(ch));
      if (a.anyColor) for (const col of COLORS) options.push([col]);
      if (options.length === 0) return;
      out.push({ object: id, ability: i, options, flexibility: 0 });
    });
  }
  // Flexibility is a property of the permanent: every mana type any of its abilities can produce.
  const perObject = new Map<ObjectId, Set<ManaType>>();
  for (const s of out) {
    const set = perObject.get(s.object) ?? new Set<ManaType>();
    for (const t of s.options.flat()) set.add(t);
    perObject.set(s.object, set);
  }
  for (const s of out) s.flexibility = perObject.get(s.object)!.size;
  return out;
}

function poolUnits(pool: ManaPool): ManaType[] {
  const out: ManaType[] = [];
  for (const t of ALL) for (let i = 0; i < pool[t]; i++) out.push(t);
  return out;
}

/** Maximum bipartite matching between pips and mana units. Returns matched pip count and the assignment. */
function match(pips: Pip[], units: ManaType[]): { count: number; pipToUnit: number[] } {
  const pipToUnit = new Array<number>(pips.length).fill(-1);
  const unitToPip = new Array<number>(units.length).fill(-1);
  // Most-constrained pips first improves greedy matching before augmentation.
  const order = pips
    .map((_, i) => i)
    .sort((a, b) => pips[a]!.accepts.length - pips[b]!.accepts.length);
  const tryAssign = (p: number, seen: boolean[]): boolean => {
    for (let u = 0; u < units.length; u++) {
      if (seen[u] || !pips[p]!.accepts.includes(units[u]!)) continue;
      seen[u] = true;
      if (unitToPip[u] === -1 || tryAssign(unitToPip[u]!, seen)) {
        unitToPip[u] = p;
        pipToUnit[p] = u;
        return true;
      }
    }
    return false;
  };
  let count = 0;
  for (const p of order) if (tryAssign(p, new Array<boolean>(units.length).fill(false))) count++;
  return { count, pipToUnit };
}

interface Solved {
  taps: { source: ManaSource; option: number }[];
  used: ManaType[];
  lifePaid: number;
}

/**
 * Finds a way to pay `cost` from the pool plus untapped sources. Exact for legality (exhaustive with pruning);
 * prefers fewer taps, then less flexible sources, so flexible mana stays available.
 */
export function solvePayment(
  cost: ManaCost,
  pool: ManaPool,
  sources: ManaSource[],
  x: number,
  life: number,
): Solved | null {
  const { fixed, choices } = costToPips(cost, x);
  let best: Solved | null = null;
  const pick = new Array<number>(choices.length).fill(0);
  const total = choices.reduce((acc, c) => acc * c.length, 1);
  for (let combo = 0; combo < total; combo++) {
    let rest = combo;
    for (let i = 0; i < choices.length; i++) {
      pick[i] = rest % choices[i]!.length;
      rest = Math.floor(rest / choices[i]!.length);
    }
    let lifePaid = 0;
    const pips = fixed.slice();
    choices.forEach((alts, i) => {
      const alt = alts[pick[i]!]!;
      lifePaid += alt.life;
      pips.push(...alt.pips);
    });
    if (lifePaid > 0 && life <= lifePaid) continue;
    const s = solvePips(pips, pool, sources);
    if (s) {
      const candidate: Solved = { ...s, lifePaid };
      if (!best || better(candidate, best)) best = candidate;
    }
  }
  return best;
}

function better(a: Solved, b: Solved): boolean {
  if (a.lifePaid !== b.lifePaid) return a.lifePaid < b.lifePaid;
  if (a.taps.length !== b.taps.length) return a.taps.length < b.taps.length;
  const fa = a.taps.reduce((acc, t) => acc + t.source.flexibility, 0);
  const fb = b.taps.reduce((acc, t) => acc + t.source.flexibility, 0);
  return fa < fb;
}

function solvePips(
  pips: Pip[],
  pool: ManaPool,
  sources: ManaSource[],
): Omit<Solved, 'lifePaid'> | null {
  const units = poolUnits(pool);
  if (pips.length === 0) return { taps: [], used: [] };
  const m0 = match(pips, units);
  if (m0.count === pips.length) return { taps: [], used: usedUnits(m0.pipToUnit, units) };

  // Sources ordered least flexible first so the DFS finds cheap plans early.
  const ordered = sources
    .slice()
    .sort((a, b) => a.flexibility - b.flexibility || a.object - b.object);
  const maxPer = ordered.map((s) => Math.max(...s.options.map((o) => o.length)));
  const suffixMax: number[] = new Array(ordered.length + 1).fill(0);
  for (let i = ordered.length - 1; i >= 0; i--) suffixMax[i] = suffixMax[i + 1]! + maxPer[i]!;

  let best: {
    taps: { source: ManaSource; option: number }[];
    units: ManaType[];
    pipToUnit: number[];
    flex: number;
  } | null = null;
  const chosen: { source: ManaSource; option: number }[] = [];
  let nodes = 0;
  const NODE_LIMIT = 20000;

  const dfs = (i: number, produced: ManaType[]): void => {
    if (++nodes > NODE_LIMIT) return;
    if (best && chosen.length > best.taps.length) return;
    const all = units.concat(produced);
    if (all.length >= pips.length) {
      const m = match(pips, all);
      if (m.count === pips.length) {
        const flex = chosen.reduce((acc, c) => acc + c.source.flexibility, 0);
        if (
          !best ||
          chosen.length < best.taps.length ||
          (chosen.length === best.taps.length && flex < best.flex)
        ) {
          best = { taps: chosen.slice(), units: all, pipToUnit: m.pipToUnit, flex };
        }
        return;
      }
    }
    if (i >= ordered.length) return;
    if (all.length + suffixMax[i]! < pips.length) return;
    const src = ordered[i]!;
    // A permanent can be tapped once even if it has several mana abilities.
    const objectUsed = chosen.some((c) => c.source.object === src.object);
    if (!objectUsed) {
      for (let opt = 0; opt < src.options.length; opt++) {
        chosen.push({ source: src, option: opt });
        dfs(i + 1, produced.concat(src.options[opt]!));
        chosen.pop();
      }
    }
    dfs(i + 1, produced);
  };
  dfs(0, []);
  if (!best) return null;
  const b = best as {
    taps: { source: ManaSource; option: number }[];
    units: ManaType[];
    pipToUnit: number[];
    flex: number;
  };
  return { taps: b.taps, used: usedUnits(b.pipToUnit, b.units) };
}

function usedUnits(pipToUnit: number[], units: ManaType[]): ManaType[] {
  const out: ManaType[] = [];
  for (const u of pipToUnit) if (u >= 0) out.push(units[u]!);
  return out;
}

export function canPay(
  cost: ManaCost,
  pool: ManaPool,
  sources: ManaSource[],
  x: number,
  life: number,
): boolean {
  return solvePayment(cost, pool, sources, x, life) !== null;
}

/** Largest X such that the cost is payable. */
export function maxX(
  cost: ManaCost,
  pool: ManaPool,
  sources: ManaSource[],
  life: number,
  cap = 20,
): number {
  let lo = -1;
  for (let x = 0; x <= cap; x++) {
    if (canPay(cost, pool, sources, x, life)) lo = x;
    else break;
  }
  return lo;
}

export function toPlan(s: Solved): PaymentPlan {
  return {
    taps: s.taps.map((t) => ({
      source: t.source.object,
      ability: t.source.ability,
      mana: t.source.options[t.option]!,
    })),
    used: s.used,
    lifePaid: s.lifePaid,
  };
}

export function colorOf(t: ManaType): Color | null {
  return t === 'C' ? null : t;
}
