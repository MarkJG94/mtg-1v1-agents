import { readFileSync } from 'node:fs';
import type { CardType, Supertype } from '@mtg/shared';

/** The subset of a Scryfall `oracle-cards` bulk entry the system uses (docs/03, docs/06 `cards` table). */
export interface ScryfallCard {
  oracle_id: string;
  id: string;
  name: string;
  mana_cost?: string;
  cmc: number;
  colors?: string[];
  color_identity: string[];
  type_line: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  keywords: string[];
  layout: string;
  legalities: Record<string, string>;
  image_uris?: Record<string, string>;
  set?: string;
  rarity?: string;
  card_faces?: { name: string; mana_cost?: string; type_line: string; oracle_text?: string }[];
}

/** Layouts the engine can represent in v1 (double-faced, split, adventure etc. come with Phase 7). */
export const SUPPORTED_LAYOUTS = new Set([
  'normal',
  'leveler',
  'class',
  'case',
  'mutate',
  'prototype',
]);

/** Base pool (docs/05 `legalityFilter: vintage`): anything printed for constructed play. */
export function isBaseLegal(card: ScryfallCard): boolean {
  const v = card.legalities.vintage;
  return (
    (v === 'legal' || v === 'restricted' || v === 'banned') && SUPPORTED_LAYOUTS.has(card.layout)
  );
}

export interface ParsedTypeLine {
  supertypes: Supertype[];
  types: CardType[];
  subtypes: string[];
}

const SUPERTYPE_WORDS: Record<string, Supertype> = {
  Legendary: 'legendary',
  Basic: 'basic',
  Snow: 'snow',
};
const TYPE_WORDS: Record<string, CardType> = {
  Creature: 'creature',
  Instant: 'instant',
  Sorcery: 'sorcery',
  Artifact: 'artifact',
  Enchantment: 'enchantment',
  Land: 'land',
  Planeswalker: 'planeswalker',
  Kindred: 'kindred',
  Tribal: 'kindred',
};

/** Parses "Legendary Creature — Elf Warrior" into supertypes/types/subtypes. Unknown words (World, Ongoing…) are ignored. */
export function parseTypeLine(typeLine: string): ParsedTypeLine {
  const [left, right] = typeLine.split(/\s[—–-]\s/);
  const out: ParsedTypeLine = { supertypes: [], types: [], subtypes: [] };
  for (const word of (left ?? '').split(/\s+/).filter(Boolean)) {
    const st = SUPERTYPE_WORDS[word];
    const t = TYPE_WORDS[word];
    if (st) out.supertypes.push(st);
    else if (t) out.types.push(t);
  }
  if (right) out.subtypes = right.split(/\s+/).filter(Boolean);
  return out;
}

/** In-memory index of the Scryfall projection: by oracle id and by (case-insensitive) name. */
export class CardDatabase {
  private readonly byOracle = new Map<string, ScryfallCard>();
  private readonly byName = new Map<string, ScryfallCard>();

  constructor(cards: Iterable<ScryfallCard>) {
    for (const c of cards) {
      this.byOracle.set(c.oracle_id, c);
      const key = c.name.toLowerCase();
      // Prefer the first printing seen for a name; the bulk file has one entry per oracle id already.
      if (!this.byName.has(key)) this.byName.set(key, c);
    }
  }

  static fromBulkFile(path: string): CardDatabase {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ScryfallCard[];
    return new CardDatabase(raw);
  }

  get size(): number {
    return this.byOracle.size;
  }

  get(oracleId: string): ScryfallCard | undefined {
    return this.byOracle.get(oracleId);
  }

  named(name: string): ScryfallCard | undefined {
    return this.byName.get(name.toLowerCase());
  }

  all(): ScryfallCard[] {
    return [...this.byOracle.values()];
  }

  filter(pred: (c: ScryfallCard) => boolean): ScryfallCard[] {
    return this.all().filter(pred);
  }
}
