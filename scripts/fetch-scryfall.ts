/**
 * Download Scryfall's `oracle_cards` bulk file and build the lean projection the
 * engine and the card pool query against (roadmap 0.4).
 *
 * Scryfall serves bulk data as gzipped JSONL (one card per line), so the whole
 * pipeline streams: download -> gunzip -> project line by line -> write. Nothing
 * holds the full ~500 MB of card JSON in memory, and the projection keeps only the
 * fields the auto-scripter, the seed-deck generator and the replacement search use,
 * which makes it cheap to load on every server start. See ADR 0001.
 *
 * Usage:
 *   pnpm fetch:scryfall [--data-dir data] [--force] [--keep-raw]
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import type { CardProjection } from '@mtg/cards';

const BULK_DATA_INDEX = 'https://api.scryfall.com/bulk-data';

/**
 * Layouts that are never a card you can put in a deck: game pieces, art products and
 * the Jumpstart theme dividers. Scryfall gives these oracle ids like anything else, so
 * without this filter the pool would hold three "Lightning Bolt"s, only one of them a
 * spell. None of them is legal in any constructed format, so nothing playable is lost.
 */
const NON_CARD_LAYOUTS = new Set([
  'art_series',
  'augment',
  'double_faced_token',
  'emblem',
  'front_card',
  'host',
  'planar',
  'scheme',
  'token',
  'vanguard',
]);
const USER_AGENT = 'mtg-1v1-agents/0.1 (https://github.com/MarkJG94/mtg-1v1-agents)';

interface ScryfallFace {
  name: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
}

interface ScryfallCard {
  id: string;
  oracle_id?: string;
  name: string;
  mana_cost?: string;
  cmc?: number;
  colors?: string[];
  color_identity?: string[];
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  keywords?: string[];
  layout: string;
  legalities?: Record<string, string>;
  card_faces?: ScryfallFace[];
  set: string;
  rarity: string;
  reserved?: boolean;
  digital?: boolean;
}

interface BulkDataEntry {
  type: string;
  jsonl_download_uri: string;
  updated_at: string;
  compressed_size: number;
}

interface Meta {
  updatedAt: string;
  fetchedAt: string;
  cards: number;
  source: string;
}

const parseArgs = (argv: string[]) => {
  const dataDirIndex = argv.indexOf('--data-dir');
  return {
    dataDir: dataDirIndex === -1 ? 'data' : (argv[dataDirIndex + 1] ?? 'data'),
    force: argv.includes('--force'),
    keepRaw: argv.includes('--keep-raw'),
  };
};

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' } });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return (await response.json()) as T;
};

const formatBytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

export const project = (card: ScryfallCard): CardProjection | null => {
  if (!card.oracle_id) return null;
  if (NON_CARD_LAYOUTS.has(card.layout)) return null;

  const projection: CardProjection = {
    id: card.id,
    oracleId: card.oracle_id,
    name: card.name,
    manaCost: card.mana_cost ?? null,
    manaValue: card.cmc ?? 0,
    colors: card.colors ?? [],
    colorIdentity: card.color_identity ?? [],
    typeLine: card.type_line ?? '',
    oracleText: card.oracle_text ?? '',
    power: card.power ?? null,
    toughness: card.toughness ?? null,
    loyalty: card.loyalty ?? null,
    keywords: card.keywords ?? [],
    layout: card.layout,
    legalities: card.legalities ?? {},
    setCode: card.set,
    rarity: card.rarity,
    reserved: card.reserved ?? false,
    digital: card.digital ?? false,
  };

  if (card.card_faces && card.card_faces.length > 0) {
    projection.faces = card.card_faces.map((face) => ({
      name: face.name,
      manaCost: face.mana_cost ?? null,
      typeLine: face.type_line ?? '',
      oracleText: face.oracle_text ?? '',
      power: face.power ?? null,
      toughness: face.toughness ?? null,
      loyalty: face.loyalty ?? null,
    }));
  }

  return projection;
};

interface Counts {
  total: number;
  skipped: number;
  vintageLegal: number;
  digital: number;
  multiFaced: number;
  withText: number;
}

/** Stream the gzipped JSONL through the projection and into `cards.jsonl`. */
const buildProjection = async (rawPath: string, cardsPath: string): Promise<Counts> => {
  const counts: Counts = {
    total: 0,
    skipped: 0,
    vintageLegal: 0,
    digital: 0,
    multiFaced: 0,
    withText: 0,
  };

  const tempPath = `${cardsPath}.partial`;
  const out = createWriteStream(tempPath, { encoding: 'utf8' });
  const lines = createInterface({
    input: createReadStream(rawPath).pipe(createGunzip()),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of lines) {
    const trimmed = line.trim();
    // Scryfall's JSONL has one object per line and no wrapping array.
    if (trimmed.length === 0) continue;

    const card = JSON.parse(trimmed) as ScryfallCard;
    const projected = project(card);
    if (!projected) {
      counts.skipped += 1;
      continue;
    }

    counts.total += 1;
    if (projected.legalities.vintage === 'legal') counts.vintageLegal += 1;
    if (projected.digital) counts.digital += 1;
    if (projected.faces) counts.multiFaced += 1;
    if (projected.oracleText.length > 0) counts.withText += 1;

    if (!out.write(`${JSON.stringify(projected)}\n`)) {
      await new Promise<void>((resolvePromise) => out.once('drain', resolvePromise));
    }
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    out.on('error', rejectPromise);
    out.end(resolvePromise);
  });
  await rename(tempPath, cardsPath);

  return counts;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const scryfallDir = resolve(args.dataDir, 'scryfall');
  await mkdir(scryfallDir, { recursive: true });

  const rawPath = resolve(scryfallDir, 'oracle-cards.jsonl.gz');
  const cardsPath = resolve(scryfallDir, 'cards.jsonl');
  const metaPath = resolve(scryfallDir, 'meta.json');

  console.log('Fetching the Scryfall bulk-data index…');
  const index = await fetchJson<{ data: BulkDataEntry[] }>(BULK_DATA_INDEX);
  const entry = index.data.find((item) => item.type === 'oracle_cards');
  if (!entry) throw new Error('Scryfall did not offer an `oracle_cards` bulk file');
  if (!entry.jsonl_download_uri) {
    throw new Error('the `oracle_cards` entry has no `jsonl_download_uri`; the API has changed');
  }

  const previous = await readJsonIfPresent<Meta>(metaPath);
  if (!args.force && previous?.updatedAt === entry.updated_at && (await exists(cardsPath))) {
    console.log(
      `Already up to date (Scryfall updated ${entry.updated_at}). Use --force to refetch.`,
    );
    console.log(`  ${previous.cards.toLocaleString()} cards in ${cardsPath}.`);
    return;
  }

  console.log(
    `Downloading oracle-cards (${formatBytes(entry.compressed_size)} gzipped) ` +
      `updated ${entry.updated_at}…`,
  );
  const response = await fetch(entry.jsonl_download_uri, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`);
  }
  const rawTemp = `${rawPath}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(rawTemp));
  await rename(rawTemp, rawPath);

  console.log('Building the projection…');
  const counts = await buildProjection(rawPath, cardsPath);

  const meta: Meta = {
    updatedAt: entry.updated_at,
    fetchedAt: new Date().toISOString(),
    cards: counts.total,
    source: entry.jsonl_download_uri,
  };
  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  if (!args.keepRaw) await unlink(rawPath);

  console.log(`Projected ${counts.total.toLocaleString()} cards:`);
  console.log(`  not real cards (skipped):       ${counts.skipped.toLocaleString()}`);
  console.log(`  vintage-legal:                  ${counts.vintageLegal.toLocaleString()}`);
  console.log(`  digital-only:                   ${counts.digital.toLocaleString()}`);
  console.log(`  multi-faced:                    ${counts.multiFaced.toLocaleString()}`);
  console.log(`  with rules text:                ${counts.withText.toLocaleString()}`);

  const info = await stat(cardsPath);
  console.log(`Wrote ${cardsPath} (${formatBytes(info.size)}).`);
};

const exists = async (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const readJsonIfPresent = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

/**
 * Only when this script is what was run. It exports `project` for `cards:new`, and an
 * import that downloaded 37 MB of bulk data as a side effect would be a nasty surprise
 * — as it was, once.
 */
if (process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]))) {
  await main();
}
