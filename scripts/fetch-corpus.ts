/**
 * `pnpm cards:corpus` — fetch the golden corpus (docs/09 "Auto-scripter golden tests").
 *
 * The corpus is a set of real cards the auto-scripter is measured against, committed as
 * projections for the same reason the validator's fixture is: the tests run in CI, where
 * there is no network and no 500 MB bulk file.
 *
 * **Two core sets**, because that is what "spanning the common templates" means in
 * practice — core sets exist to teach the game, so between them they hold the vanilla
 * creatures, the burn, the removal, the counterspells, the ETB triggers, the anthems and
 * the basic lands, without the mechanics a parser has no business reading yet. The query
 * is fixed and written down here so anybody can reproduce the set exactly.
 *
 * Re-running it rewrites the file. What that does to the goldens is the point: a corpus
 * change and a parser change look the same in the diff, which is why both are deliberate.
 */
import { writeFileSync } from 'node:fs';
import type { CardProjection } from '@mtg/cards';
import { project } from './fetch-scryfall.js';

const USER_AGENT = 'mtg-1v1-agents/0.1 (https://github.com/MarkJG94/mtg-1v1-agents)';
const OUTPUT = 'packages/cards/fixtures/corpus.json';

/** The selection, in Scryfall's own query language. Change it and the goldens change. */
const QUERY = 'e:m10 or e:m11';

/** Scryfall asks for no more than ten requests a second; this is well inside that. */
const POLITE_DELAY_MS = 250;

interface SearchPage {
  readonly data: readonly unknown[];
  readonly has_more: boolean;
  readonly next_page?: string;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const fetchPage = async (url: string): Promise<SearchPage> => {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: '*/*' } });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as SearchPage;
};

const main = async (): Promise<void> => {
  const start = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(QUERY)}&unique=cards&order=name`;
  const cards: CardProjection[] = [];

  let url: string | undefined = start;
  while (url !== undefined) {
    const page: SearchPage = await fetchPage(url);
    for (const card of page.data) {
      const projected = project(card as Parameters<typeof project>[0]);
      if (projected !== null) cards.push(projected);
    }
    process.stdout.write(`fetched ${cards.length}\r`);
    url = page.has_more ? page.next_page : undefined;
    if (url !== undefined) await wait(POLITE_DELAY_MS);
  }

  // Keyed by oracle id and sorted by name, so the file is stable whatever order the API
  // answered in and a diff is about the cards rather than about the ordering.
  const byOracleId: Record<string, CardProjection> = {};
  for (const card of [...cards].sort((left, right) => left.name.localeCompare(right.name))) {
    byOracleId[card.oracleId] = card;
  }

  writeFileSync(OUTPUT, `${JSON.stringify(byOracleId, null, 2)}\n`);
  console.log(`\nwrote ${Object.keys(byOracleId).length} cards to ${OUTPUT} (query: ${QUERY})`);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
