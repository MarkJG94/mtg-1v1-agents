import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type Fetcher, ImageCache } from './images.js';

/**
 * The image cache's own rules (roadmap 6.2), with Scryfall played by the test: one request
 * per image ever, one at a time and spaced, never a file name or URL from outside, and
 * nothing half-written.
 */

const directory = mkdtempSync(join(tmpdir(), 'mtg-images-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const card = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const printing = (n: number) => `11111111-0000-4000-8000-${String(n).padStart(12, '0')}`;

const scryfall = (answer: (url: string) => { ok: boolean; status: number } | Error) => {
  const asked: { url: string; at: number }[] = [];
  const fetcher: Fetcher = async (url) => {
    asked.push({ url, at: performance.now() });
    const result = answer(url);
    if (result instanceof Error) throw result;
    return { ...result, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  return { asked, fetcher };
};

describe('the image cache', () => {
  it('fetches nothing when images are off', async () => {
    const { asked, fetcher } = scryfall(() => ({ ok: true, status: 200 }));
    const cache = new ImageCache({ directory, mode: 'off', fetcher });
    expect(await cache.get(card(1), printing(1), 'normal')).toEqual({ kind: 'off' });
    expect(asked).toEqual([]);
  });

  it('shares one fetch between requests for the same image', async () => {
    const { asked, fetcher } = scryfall(() => ({ ok: true, status: 200 }));
    const cache = new ImageCache({ directory: join(directory, 'shared'), mode: 'lazy', fetcher });
    const [a, b] = await Promise.all([
      cache.get(card(2), printing(2), 'normal'),
      cache.get(card(2), printing(2), 'normal'),
    ]);
    expect([a?.kind, b?.kind]).toEqual(['image', 'image']);
    expect(asked).toHaveLength(1);
  });

  it('asks Scryfall one request at a time, spaced apart', async () => {
    const { asked, fetcher } = scryfall(() => ({ ok: true, status: 200 }));
    const cache = new ImageCache({
      directory: join(directory, 'spaced'),
      mode: 'lazy',
      fetcher,
      spacingMs: 40,
    });
    await Promise.all([1, 2, 3].map((n) => cache.get(card(n), printing(n), 'small')));
    const gaps = asked.slice(1).map((entry, i) => entry.at - (asked[i]?.at ?? 0));
    expect(gaps).toHaveLength(2);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(35);
  });

  it('says why when Scryfall has no image, keeps nothing, and asks again next time', async () => {
    let failing = true;
    const { asked, fetcher } = scryfall(() =>
      failing ? { ok: false, status: 404 } : { ok: true, status: 200 },
    );
    const where = join(directory, 'failing');
    const cache = new ImageCache({ directory: where, mode: 'lazy', fetcher, spacingMs: 1 });
    expect(await cache.get(card(4), printing(4), 'normal')).toEqual({
      kind: 'unavailable',
      status: 404,
    });
    expect(existsSync(join(where, 'normal', `${card(4)}.jpg`))).toBe(false);
    failing = false;
    expect((await cache.get(card(4), printing(4), 'normal')).kind).toBe('image');
    expect(asked).toHaveLength(2);
    // Written whole: nothing left half-done beside it.
    expect(readdirSync(join(where, 'normal'))).toEqual([`${card(4)}.jpg`]);
  });

  it('answers a network failure as unavailable rather than throwing', async () => {
    const { fetcher } = scryfall(() => new Error('offline'));
    const cache = new ImageCache({ directory: join(directory, 'offline'), mode: 'lazy', fetcher });
    expect(await cache.get(card(5), printing(5), 'normal')).toEqual({
      kind: 'unavailable',
      status: 502,
    });
  });

  it('never makes a file name or a URL from anything but a UUID', async () => {
    const { asked, fetcher } = scryfall(() => ({ ok: true, status: 200 }));
    const cache = new ImageCache({ directory: join(directory, 'safe'), mode: 'lazy', fetcher });
    expect((await cache.get('../../etc/passwd', printing(6), 'normal')).kind).toBe('unavailable');
    expect((await cache.get(card(6), 'x?format=json', 'normal')).kind).toBe('unavailable');
    expect(asked).toEqual([]);
  });
});
