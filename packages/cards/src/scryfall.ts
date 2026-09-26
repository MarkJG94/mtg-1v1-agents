import { z } from 'zod';

/**
 * The Scryfall projection: the subset of a card the rest of the system uses (docs/03).
 *
 * `pnpm fetch:scryfall` writes one of these per line to `data/scryfall/cards.jsonl`, and
 * the validator checks a script against one. The type lives here, with the card code,
 * rather than in the script that writes it — a validator reading a slightly different
 * shape than the fetcher writes would be the quietest kind of bug.
 *
 * Fields are Scryfall's own names and Scryfall's own strings: `power` is `"2"` or `"*"`,
 * not a number, because `*` is a real answer and the projection is not the place to lose
 * it.
 */

/** The subset of a Scryfall card the rest of the system uses. */
export interface CardProjection {
  id: string;
  oracleId: string;
  name: string;
  manaCost: string | null;
  manaValue: number;
  colors: string[];
  colorIdentity: string[];
  typeLine: string;
  oracleText: string;
  power: string | null;
  toughness: string | null;
  loyalty: string | null;
  keywords: string[];
  layout: string;
  /** Legality per format, straight from Scryfall (`legal`, `not_legal`, `banned`, `restricted`). */
  legalities: Record<string, string>;
  /** Present on multi-faced cards; the auto-scripter needs the per-face text. */
  faces?: Array<{
    name: string;
    manaCost: string | null;
    typeLine: string;
    oracleText: string;
    power: string | null;
    toughness: string | null;
    loyalty: string | null;
  }>;
  setCode: string;
  rarity: string;
  reserved: boolean;
  /** Digital-only cards (Alchemy, Arena-only sets) are excluded from play. */
  digital: boolean;
}

/**
 * Parsed at the edge, where a line of JSONL becomes a card. Everything downstream can
 * then rely on the shape rather than hoping.
 */
export const cardProjectionSchema = z.object({
  id: z.string(),
  oracleId: z.string(),
  name: z.string(),
  manaCost: z.string().nullable(),
  manaValue: z.number(),
  colors: z.array(z.string()),
  colorIdentity: z.array(z.string()),
  typeLine: z.string(),
  oracleText: z.string(),
  power: z.string().nullable(),
  toughness: z.string().nullable(),
  loyalty: z.string().nullable(),
  keywords: z.array(z.string()),
  layout: z.string(),
  legalities: z.record(z.string(), z.string()),
  faces: z
    .array(
      z.object({
        name: z.string(),
        manaCost: z.string().nullable(),
        typeLine: z.string(),
        oracleText: z.string(),
        power: z.string().nullable(),
        toughness: z.string().nullable(),
        loyalty: z.string().nullable(),
      }),
    )
    .optional(),
  setCode: z.string(),
  rarity: z.string(),
  reserved: z.boolean(),
  digital: z.boolean(),
});
