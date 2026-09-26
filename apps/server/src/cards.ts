import { readFileSync } from 'node:fs';
import type { CardProjection } from '@mtg/cards';

/** Scryfall's projections from `pnpm fetch:scryfall`'s JSONL, one card a line (ADR 0001). */
export const readCardPool = (path: string): CardProjection[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CardProjection);
