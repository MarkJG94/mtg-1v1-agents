// The smoke's data directory: Scryfall as a server reads it, made from the cards the repository
// already holds — the bootstrap set and the golden corpus, a few hundred cards — so a run can be
// made and played without the bulk data or any network (docs/09 §7, "a tiny bootstrap card pool").
//
// Plain Node with no dependencies, because the CI job that runs the Docker image has nothing else.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, '../../packages/cards/fixtures');
const target = resolve(process.argv[2] ?? join(here, '.data'));

const cards = ['scryfall.json', 'corpus.json'].flatMap((name) =>
  Object.values(JSON.parse(readFileSync(join(fixtures, name), 'utf8'))),
);
rmSync(target, { recursive: true, force: true });
mkdirSync(join(target, 'scryfall'), { recursive: true });
writeFileSync(
  join(target, 'scryfall', 'cards.jsonl'),
  `${cards.map((card) => JSON.stringify(card)).join('\n')}\n`,
);
console.log(`${cards.length} cards in ${target}`);
