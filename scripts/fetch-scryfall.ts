import { once } from 'node:events';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { CardDatabase, isBaseLegal, type ScryfallCard } from '@mtg/cards';

/**
 * Roadmap 0.4: downloads the Scryfall `oracle-cards` bulk file to data/scryfall/oracle-cards.json and prints
 * counts. Run with `pnpm fetch:scryfall`. Scryfall asks for a descriptive User-Agent and ≤ 10 requests/second.
 *
 * Scryfall serves the bulk file as compressed JSONL (one card per line); this writes it back out as a plain
 * JSON array so the rest of the project can read it with a single `JSON.parse`.
 *
 * Flags: `--force` re-downloads an existing file, `--dump` prints the bulk-data entry and exits.
 */
const DATA_DIR = process.env.DATA_DIR ?? 'data';
const OUT = join(DATA_DIR, 'scryfall', 'oracle-cards.json');
const HEADERS = {
  'User-Agent': 'mtg-1v1-agents/0.1 (https://github.com/MarkJG94/mtg-1v1-agents)',
  Accept: 'application/json',
};
/** Documented shortcut that redirects to the current file, used when the index has no usable URI. */
const DIRECT = 'https://api.scryfall.com/bulk-data/oracle-cards?format=file';

type BulkEntry = Record<string, unknown>;
type Compression = 'gzip' | 'zstd' | 'none';

const flag = (name: string): boolean => process.argv.includes(name);

/**
 * The download URL of a bulk-data entry. Scryfall has renamed this field before (it is `jsonl_download_uri`
 * now, was `download_uri`), so several spellings and one level of nesting are accepted.
 */
function downloadUri(entry: BulkEntry): string | null {
  const isUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\//.test(v);
  for (const key of [
    'jsonl_download_uri',
    'download_uri',
    'downloadUri',
    'download_url',
    'file_uri',
    'file_url',
  ]) {
    if (isUrl(entry[key])) return entry[key];
  }
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'uri' || !value || typeof value !== 'object') continue;
    for (const inner of Object.values(value as BulkEntry)) {
      if (isUrl(inner) && /\.(json|jsonl)(\.\w+)?$/.test(new URL(inner).pathname)) return inner;
    }
  }
  return null;
}

function describe(entry: BulkEntry): string {
  const bytes = typeof entry.size === 'number' ? entry.size : entry.compressed_size;
  const size = typeof bytes === 'number' ? `${Math.round(bytes / 1e6)} MB` : 'unknown size';
  return `${size}, updated ${String(entry.updated_at ?? 'unknown')}`;
}

/**
 * Whether an existing file starts like JSON. A download left behind by an older version of this script is
 * still compressed, and must be replaced rather than parsed.
 */
function looksLikeJson(path: string): boolean {
  const fd = openSync(path, 'r');
  const head = Buffer.alloc(64);
  let n = 0;
  try {
    n = readSync(fd, head, 0, 64, 0);
  } finally {
    closeSync(fd);
  }
  const text = head.subarray(0, n).toString('utf8').trimStart();
  return text.startsWith('[') || text.startsWith('{');
}

/** Detects the compression from the file's magic bytes rather than trusting the URL or headers. */
function sniff(path: string): Compression {
  const fd = openSync(path, 'r');
  const head = Buffer.alloc(4);
  try {
    readSync(fd, head, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
  if (head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) return 'zstd';
  return 'none';
}

function decompressor(kind: Compression): NodeJS.ReadWriteStream | null {
  if (kind === 'gzip') return zlib.createGunzip();
  if (kind === 'zstd') {
    const create = (zlib as unknown as { createZstdDecompress?: () => NodeJS.ReadWriteStream })
      .createZstdDecompress;
    if (typeof create !== 'function') {
      throw new Error(
        `the bulk file is zstd-compressed and this Node (${process.version}) has no zstd support; upgrade to Node >= 22.15`,
      );
    }
    return create();
  }
  return null;
}

/**
 * Rewrites JSONL (one card per line) as a JSON array, streaming line by line so a 100+ MB file never has to
 * be held in memory. A file that is already a JSON array is passed through untouched.
 */
async function toJsonArray(source: string, kind: Compression, dest: string): Promise<void> {
  const open = (): Readable => {
    const decode = decompressor(kind);
    const raw = createReadStream(source);
    return decode ? (raw.pipe(decode) as unknown as Readable) : raw;
  };

  // A minified single-line array is already the target format; JSONL and one-card-per-line arrays are not.
  if (await isSingleLineArray(source, kind)) {
    await pipeline(open(), createWriteStream(dest));
    return;
  }

  const input = open();
  const out = createWriteStream(dest);
  const write = async (chunk: string): Promise<void> => {
    if (!out.write(chunk)) await once(out, 'drain');
  };
  await write('[\n');
  let count = 0;
  for await (const line of createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })) {
    const trimmed = line.trim().replace(/,$/, '');
    if (!trimmed || trimmed === '[' || trimmed === ']') continue;
    await write(count === 0 ? trimmed : `,\n${trimmed}`);
    count++;
  }
  await write('\n]\n');
  out.end();
  await once(out, 'finish');
  if (count === 0) throw new Error('the downloaded bulk file contained no cards');
}

/**
 * Whether the (decompressed) file is a JSON array printed on one line, which must be copied through rather
 * than treated as JSONL. Both of Scryfall's formats put one card per line, so this is normally false.
 */
async function isSingleLineArray(source: string, kind: Compression): Promise<boolean> {
  const decode = decompressor(kind);
  const raw = createReadStream(source);
  const input = decode ? (raw.pipe(decode) as unknown as Readable) : raw;
  try {
    for await (const chunk of input) {
      const text = String(chunk).trimStart();
      if (!text) continue;
      const firstLine = text.split('\n', 1)[0]!;
      return firstLine.trimEnd().length > 1 && firstLine.startsWith('[');
    }
  } catch {
    // A decode error here is reported by the real pass below.
  }
  return false;
}

async function download(): Promise<void> {
  const index = (await (
    await fetch('https://api.scryfall.com/bulk-data', { headers: HEADERS })
  ).json()) as { data?: BulkEntry[] };
  const entries = index.data ?? [];
  const oracle = entries.find((d) => d.type === 'oracle_cards' || d.type === 'oracle-cards');
  if (!oracle) {
    throw new Error(
      `bulk-data index has no oracle_cards entry (types: ${entries.map((d) => String(d.type)).join(', ')})`,
    );
  }
  if (flag('--dump')) {
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
  // Download to a temporary file, then convert into place, so an interrupted transfer never leaves a
  // truncated oracle-cards.json that the next run would treat as complete.
  const tmp = `${OUT}.part`;
  const building = `${OUT}.building`;
  try {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
    const kind = sniff(tmp);
    console.log(`decoding ${kind === 'none' ? 'uncompressed' : kind} bulk data`);
    await toJsonArray(tmp, kind, building);
    renameSync(building, OUT);
  } finally {
    rmSync(tmp, { force: true });
    rmSync(building, { force: true });
  }
}

async function main(): Promise<void> {
  mkdirSync(join(DATA_DIR, 'scryfall'), { recursive: true });
  const stale = existsSync(OUT) && !looksLikeJson(OUT);
  if (stale) {
    console.warn(
      `${OUT} is not JSON (a compressed download from an older version of this script); replacing it`,
    );
  }
  if (!existsSync(OUT) || stale || flag('--force') || flag('--dump')) {
    await download();
    if (flag('--dump')) return;
  } else {
    console.log(`${OUT} exists; pass --force to re-download`);
  }
  const cards = JSON.parse(readFileSync(OUT, 'utf8')) as ScryfallCard[];
  const db = new CardDatabase(cards);
  const base = db.filter(isBaseLegal);
  console.log(`cards: ${db.size} oracle ids, ${base.length} in the base pool`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
