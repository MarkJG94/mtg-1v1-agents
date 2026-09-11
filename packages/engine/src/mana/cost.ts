import type { Color, ManaType } from '@mtg/shared';

/** One mana symbol of a cost. */
export type ManaSymbol =
  | { kind: 'generic'; amount: number }
  | { kind: 'x' }
  | { kind: 'colored'; color: Color }
  | { kind: 'colorless' }
  | { kind: 'snow' }
  | { kind: 'hybrid'; colors: [Color, Color] }
  | { kind: 'monoHybrid'; color: Color; generic: number }
  | { kind: 'phyrexian'; color: Color }
  | { kind: 'phyrexianHybrid'; colors: [Color, Color] };

export interface ManaCost {
  symbols: ManaSymbol[];
}

const COLOR_SET = new Set(['W', 'U', 'B', 'R', 'G']);

function isColor(s: string): s is Color {
  return COLOR_SET.has(s);
}

const parseCache = new Map<string, ManaCost>();

/** Parses "{2}{G}{G/U}{R/P}{X}" into symbols. Empty string is a zero cost. Results are cached and must not be mutated. */
export function parseManaCost(text: string | undefined): ManaCost {
  if (!text) return { symbols: [] };
  const cached = parseCache.get(text);
  if (cached) return cached;
  const parsed = parseManaCostUncached(text);
  parseCache.set(text, parsed);
  return parsed;
}

function parseManaCostUncached(text: string): ManaCost {
  const symbols: ManaSymbol[] = [];
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    const raw = m[1]!.toUpperCase();
    if (/^\d+$/.test(raw)) {
      const amount = Number(raw);
      if (amount > 0) symbols.push({ kind: 'generic', amount });
    } else if (raw === 'X') symbols.push({ kind: 'x' });
    else if (raw === 'C') symbols.push({ kind: 'colorless' });
    else if (raw === 'S') symbols.push({ kind: 'snow' });
    else if (isColor(raw)) symbols.push({ kind: 'colored', color: raw });
    else if (raw.includes('/')) {
      const parts = raw.split('/');
      if (parts.length === 2) {
        const [a, b] = parts as [string, string];
        if (isColor(a) && isColor(b)) symbols.push({ kind: 'hybrid', colors: [a, b] });
        else if (isColor(a) && b === 'P') symbols.push({ kind: 'phyrexian', color: a });
        else if (/^\d+$/.test(a) && isColor(b))
          symbols.push({ kind: 'monoHybrid', color: b, generic: Number(a) });
        else throw new Error(`Unknown mana symbol {${m[1]}}`);
      } else if (parts.length === 3 && parts[2] === 'P') {
        const [a, b] = parts as [string, string, string];
        if (isColor(a) && isColor(b)) symbols.push({ kind: 'phyrexianHybrid', colors: [a, b] });
        else throw new Error(`Unknown mana symbol {${m[1]}}`);
      } else throw new Error(`Unknown mana symbol {${m[1]}}`);
    } else throw new Error(`Unknown mana symbol {${m[1]}}`);
    m = re.exec(text);
  }
  return { symbols };
}

/** Mana value (CR 202.3). X counts as 0 except while on the stack, which callers handle. */
export function manaValue(cost: ManaCost, x = 0): number {
  let total = 0;
  for (const s of cost.symbols) {
    switch (s.kind) {
      case 'generic':
        total += s.amount;
        break;
      case 'x':
        total += x;
        break;
      case 'monoHybrid':
        total += s.generic;
        break;
      case 'hybrid':
      case 'phyrexianHybrid':
      case 'phyrexian':
      case 'colored':
      case 'colorless':
      case 'snow':
        total += 1;
        break;
    }
  }
  return total;
}

/** Colours a mana cost contributes to a card's colour (CR 105.2, 202.2). */
export function costColors(cost: ManaCost): Color[] {
  const out = new Set<Color>();
  for (const s of cost.symbols) {
    if (s.kind === 'colored' || s.kind === 'phyrexian' || s.kind === 'monoHybrid') out.add(s.color);
    else if (s.kind === 'hybrid' || s.kind === 'phyrexianHybrid') {
      out.add(s.colors[0]);
      out.add(s.colors[1]);
    }
  }
  return ['W', 'U', 'B', 'R', 'G'].filter((c): c is Color => out.has(c as Color));
}

function formatSymbol(s: ManaSymbol): string {
  switch (s.kind) {
    case 'generic':
      return `{${s.amount}}`;
    case 'x':
      return '{X}';
    case 'colored':
      return `{${s.color}}`;
    case 'colorless':
      return '{C}';
    case 'snow':
      return '{S}';
    case 'hybrid':
      return `{${s.colors[0]}/${s.colors[1]}}`;
    case 'monoHybrid':
      return `{${s.generic}/${s.color}}`;
    case 'phyrexian':
      return `{${s.color}/P}`;
    case 'phyrexianHybrid':
      return `{${s.colors[0]}/${s.colors[1]}/P}`;
  }
}

export function formatManaCost(cost: ManaCost): string {
  return cost.symbols.map(formatSymbol).join('');
}

export function addCosts(a: ManaCost, b: ManaCost): ManaCost {
  return { symbols: [...a.symbols, ...b.symbols] };
}

export function reduceGeneric(cost: ManaCost, amount: number): ManaCost {
  if (amount <= 0) return cost;
  const symbols: ManaSymbol[] = [];
  let remaining = amount;
  for (const s of cost.symbols) {
    if (s.kind === 'generic' && remaining > 0) {
      const take = Math.min(remaining, s.amount);
      remaining -= take;
      if (s.amount - take > 0) symbols.push({ kind: 'generic', amount: s.amount - take });
    } else symbols.push(s);
  }
  return { symbols };
}

export type ManaPool = Record<ManaType, number>;

export function emptyPool(): ManaPool {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
}

export function poolTotal(pool: ManaPool): number {
  return pool.W + pool.U + pool.B + pool.R + pool.G + pool.C;
}

/** Parses a produced-mana string like "{G}{G}" or "GG" into a list of mana types. */
export function parseMana(text: string): ManaType[] {
  const out: ManaType[] = [];
  for (const ch of text.replace(/[{}]/g, '')) {
    const up = ch.toUpperCase();
    if (up === 'W' || up === 'U' || up === 'B' || up === 'R' || up === 'G' || up === 'C')
      out.push(up);
    else throw new Error(`Unknown mana type ${ch}`);
  }
  return out;
}
