import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CardDatabase, isBaseLegal, type ScryfallCard } from '@mtg/cards';

/**
 * Roadmap 0.4: downloads the Scryfall `oracle-cards` bulk file to data/scryfall/oracle-cards.json and prints
 * counts. Run with `pnpm fetch:scryfall`. Scryfall asks for a descriptive User-Agent and ≤ 10 requests/second.
 */
const DATA_DIR = process.env.DATA_DIR ?? 'data';
const OUT = `${DATA_DIR}/scryfall/oracle-cards.json`;
const HEADERS = {
  'User-Agent': 'mtg-1v1-agents/0.1 (https://github.com/MarkJG94/mtg-1v1-agents)',
  Accept: 'application/json',
};

async function main(): Promise<void> {
  mkdirSync(`${DATA_DIR}/scryfall`, { recursive: true });
  if (!existsSync(OUT) || process.argv.includes('--force')) {
    const index = (await (
      await fetch('https://api.scryfall.com/bulk-data', { headers: HEADERS })
    ).json()) as {
      data: { type: string; download_uri: string; updated_at: string; size: number }[];
    };
    const oracle = index.data.find((d) => d.type === 'oracle_cards');
    if (!oracle) throw new Error('bulk-data index has no oracle_cards entry');
    console.log(
      `downloading ${oracle.download_uri} (${Math.round(oracle.size / 1e6)} MB, updated ${oracle.updated_at})`,
    );
    const res = await fetch(oracle.download_uri, { headers: HEADERS });
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(OUT));
  } else {
    console.log(`${OUT} exists; pass --force to re-download`);
  }
  const cards = JSON.parse(readFileSync(OUT, 'utf8')) as ScryfallCard[];
  const db = new CardDatabase(cards);
  const base = db.filter(isBaseLegal);
  console.log(`cards: ${db.size} oracle ids, ${base.length} in the base pool`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
