import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CardProjection } from '@mtg/cards';
import { readCardPool } from '../cards.js';
import type { OpenDatabase } from './open.js';

/**
 * docs/06 `cards`: the Scryfall projection the API searches and names cards from, "rebuilt
 * on fetch" (roadmap 6.1). At boot the server compares the bulk data's version — Scryfall's
 * `updatedAt` from `meta.json`, or the file's size and time without one — with the version
 * the table holds, and reloads the table in one transaction only when they differ.
 */

export interface CatalogueLoad {
  readonly version: string;
  readonly loaded: boolean;
  readonly cards: number;
}

const versionOf = (cardsPath: string): string => {
  const meta = join(dirname(cardsPath), 'meta.json');
  if (existsSync(meta)) {
    const updatedAt = (JSON.parse(readFileSync(meta, 'utf8')) as { updatedAt?: unknown }).updatedAt;
    if (typeof updatedAt === 'string') return updatedAt;
  }
  const stat = statSync(cardsPath);
  return `${stat.size}:${stat.mtimeMs}`;
};

/** A card may be drawn by a run in the base format (5.3's rule) when this is set. */
const legalBase = (card: CardProjection): number => {
  const vintage = card.legalities.vintage;
  return !card.digital && (vintage === 'legal' || vintage === 'restricted') ? 1 : 0;
};

export const loadCatalogue = (database: OpenDatabase, cardsPath: string): CatalogueLoad => {
  const { sqlite } = database;
  const version = versionOf(cardsPath);
  const held = sqlite.prepare('SELECT scryfall_updated_at AS version FROM cards LIMIT 1').get() as
    | { version: string | null }
    | undefined;
  if (held?.version === version) {
    const { n } = sqlite.prepare('SELECT count(*) AS n FROM cards').get() as { n: number };
    return { version, loaded: false, cards: n };
  }
  const pool = readCardPool(cardsPath);
  const insert = sqlite.prepare(
    `INSERT OR REPLACE INTO cards (oracle_id, name, mana_cost, mana_value, colors, color_identity,
       type_line, oracle_text, power, toughness, loyalty, keywords, layout, legal_base,
       preferred_printing_id, image_uri, scryfall_updated_at, projection)
     VALUES (@oracleId, @name, @manaCost, @manaValue, @colors, @colorIdentity, @typeLine,
       @oracleText, @power, @toughness, @loyalty, @keywords, @layout, @legalBase, @printing,
       NULL, @version, @projection)`,
  );
  sqlite.transaction(() => {
    sqlite.prepare('DELETE FROM cards').run();
    for (const card of pool) {
      insert.run({
        oracleId: card.oracleId,
        name: card.name,
        manaCost: card.manaCost,
        manaValue: card.manaValue,
        colors: JSON.stringify(card.colors),
        colorIdentity: JSON.stringify(card.colorIdentity),
        typeLine: card.typeLine,
        oracleText: card.oracleText,
        power: card.power,
        toughness: card.toughness,
        loyalty: card.loyalty,
        keywords: JSON.stringify(card.keywords),
        layout: card.layout,
        legalBase: legalBase(card),
        printing: card.id,
        version,
        projection: JSON.stringify(card),
      });
    }
  })();
  const { n } = sqlite.prepare('SELECT count(*) AS n FROM cards').get() as { n: number };
  return { version, loaded: true, cards: n };
};
