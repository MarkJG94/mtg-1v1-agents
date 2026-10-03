import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The card image proxy (docs/07 `/img/:oracleId`; roadmap 6.2): a card's image from
 * Scryfall, fetched the first time it is asked for and kept on disk under
 * `DATA_DIR/images/<size>/<oracle id>.jpg`, so a page of cards costs Scryfall one request
 * per card ever. `SCRYFALL_IMAGE_CACHE=off` turns it off: the UI then shows text-only
 * frames (docs/08).
 *
 * Scryfall asks for no more than about ten requests a second and a descriptive user agent
 * (their API documentation's "Rate limits and good citizenship"); fetches are made one
 * at a time, 100 ms apart, and two requests for the same image share one fetch.
 */

export const imageSizes = ['small', 'normal'] as const;
export type ImageSize = (typeof imageSizes)[number];

/** A fetch, as the cache needs it: injected, so the tests make no network requests. */
export type Fetcher = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>> },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface ImageCacheOptions {
  readonly directory: string;
  readonly mode: 'lazy' | 'off';
  readonly fetcher?: Fetcher;
  /** The gap between two requests to Scryfall. */
  readonly spacingMs?: number;
  readonly userAgent?: string;
}

export type ImageResult =
  | { readonly kind: 'image'; readonly bytes: Buffer; readonly cached: boolean }
  | { readonly kind: 'off' }
  | { readonly kind: 'unavailable'; readonly status: number };

/** Oracle and printing ids are UUIDs; nothing else becomes a file name or a URL. */
const safeId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isSafeId = (id: string): boolean => safeId.test(id);

export class ImageCache {
  private readonly fetcher: Fetcher;
  private readonly spacingMs: number;
  private readonly inFlight = new Map<string, Promise<ImageResult>>();
  /** The last request to Scryfall, as a promise the next one waits behind. */
  private queue: Promise<void> = Promise.resolve();
  private fetches = 0;

  constructor(private readonly options: ImageCacheOptions) {
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.spacingMs = options.spacingMs ?? 100;
  }

  /** How many requests Scryfall has been sent, for tests. */
  get requests(): number {
    return this.fetches;
  }

  /**
   * A card's image at `size`, from disk or else from Scryfall by its printing. Both ids
   * must be UUIDs — the caller takes them from the catalogue, never from the request alone.
   */
  get(oracleId: string, printingId: string, size: ImageSize): Promise<ImageResult> {
    if (this.options.mode === 'off') return Promise.resolve({ kind: 'off' });
    if (!isSafeId(oracleId) || !isSafeId(printingId)) {
      return Promise.resolve({ kind: 'unavailable', status: 400 });
    }
    const file = join(this.options.directory, size, `${oracleId}.jpg`);
    if (existsSync(file)) {
      return Promise.resolve({ kind: 'image', bytes: readFileSync(file), cached: true });
    }
    const key = `${size}/${oracleId}`;
    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;
    const fetched = this.fetch(printingId, size, file).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, fetched);
    return fetched;
  }

  private fetch(printingId: string, size: ImageSize, file: string): Promise<ImageResult> {
    const turn = this.queue.then(() => this.request(printingId, size, file));
    // The next request waits for this one and the spacing after it, success or not.
    this.queue = turn.then(
      () => sleep(this.spacingMs),
      () => sleep(this.spacingMs),
    );
    return turn;
  }

  private async request(printingId: string, size: ImageSize, file: string): Promise<ImageResult> {
    this.fetches += 1;
    const url = `https://api.scryfall.com/cards/${printingId}?format=image&version=${size}`;
    let response: Awaited<ReturnType<Fetcher>>;
    try {
      response = await this.fetcher(url, {
        headers: {
          'User-Agent': this.options.userAgent ?? 'mtg-1v1-agents/0.0.0',
          Accept: 'image/*',
        },
      });
    } catch {
      return { kind: 'unavailable', status: 502 };
    }
    if (!response.ok) return { kind: 'unavailable', status: response.status };
    const bytes = Buffer.from(await response.arrayBuffer());
    // Written whole or not at all: a reader never sees half an image.
    mkdirSync(join(file, '..'), { recursive: true });
    const partial = `${file}.${process.pid}.partial`;
    writeFileSync(partial, bytes);
    renameSync(partial, file);
    return { kind: 'image', bytes, cached: false };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
