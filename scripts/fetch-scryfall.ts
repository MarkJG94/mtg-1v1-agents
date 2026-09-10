import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CardDatabase, isBaseLegal, type ScryfallCard } from '@mtg/cards';

/**
 * Roadmap 0.4: downloads the Scryfall `oracle-cards` bulk file to data/scryfall/oracle-cards.json and prints
 * counts. Run with `pnpm fetch:scryfall`. Scryfall asks for a descriptive User-Agent and ≤ 10 requests/second.
 *
 * Flags: `--force` re-downloads an existing file, `--dump` prints the bulk-data entry and exits.
 */
const DATA_DIR = process.env.DATA_DIR ?? 'data';
const OUT = `${DATA_DIR}/scryfall/oracle-cards.json`;
const HEADERS = {
  'User-Agent': 'mtg-1v1-agents/0.1 (https://github.com/MarkJG94/mtg-1v1-agents)',
  Accept: 'application/json',
};
/** Documented shortcut that redirects straight to the current file, used when the index has no usable URI. */
const DIRECT = 'https://api.scryfall.com/bulk-data/oracle-cards?format=file';

type BulkEntry = Record<string, unknown>;

/**
 * The download URL of a bulk-data entry. Scryfall has moved this field before, so several spellings and one
 * level of nesting are accepted rather than trusting a single key.
 */
function downloadUri(entry: BulkEntry): string | null {
  const isUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//.test(v);
  for (const key of ['download_uri', 'downloadUri', 'download_url', 'file_uri', 'file_url']) {
    if (isUrl(entry[key])) return entry[key];
  }
  for (const value of Object.values(entry)) {
    if (!value || typeof value !== 'object') continue;
    for (const inner of Object.values(value as BulkEntry)) {
      if (isUrl(inner) && /\.json(\.\w+)?$/.test(new URL(inner).pathname)) return inner;
    }
  }
  return null;
}

function describe(entry: BulkEntry): string {
  const size =
    typeof entry.size === 'number' ? `${Math.round(entry.size / 1e6)} MB` : 'unknown size';
  return `${size}, updated ${String(entry.updated_at ?? 'unknown')}`;
}

async function download(): Promise<void> {
  const index = (await (
    await fetch('https://api.scryfall.com/bulk-data', { headers: HEADERS })
  ).json()) as {
    data?: BulkEntry[];
  };
  const entries = index.data ?? [];
  const oracle = entries.find((d) => d.type === 'oracle_cards' || d.type === 'oracle-cards');
  if (!oracle) {
    throw new Error(
      `bulk-data index has no oracle_cards entry (types: ${entries.map((d) => String(d.type)).join(', ')})`,
    );
  }
  if (process.argv.includes('--dump')) {
    console.log(JSON.stringify(oracle, null, 2));
    return;
  }

  let uri = downloadUri(oracle);
  if (!uri) {
    console.warn(
      `bulk-data entry has no download URI (keys: ${Object.keys(oracle).join(', ')}); falling back to ${DIRECT}`,
    );
    uri = DIRECT;
  }
  console.log(`downloading ${uri} (${describe(oracle)})`);

  const res = await fetch(uri, { headers: HEADERS });
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  // Write to a temporary file first so an interrupted download never leaves a half-written oracle-cards.json.
  const tmp = `${OUT}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
    renameSync(tmp, OUT);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

async function main(): Promise<void> {
  mkdirSync(`${DATA_DIR}/scryfall`, { recursive: true });
  if (!existsSync(OUT) || process.argv.includes('--force') || process.argv.includes('--dump')) {
    await download();
    if (process.argv.includes('--dump')) return;
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
