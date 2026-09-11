import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CardDatabase,
  coverageReport,
  formatCoverage,
  handScriptsByOracleId,
  isBaseLegal,
  type ScryfallCard,
} from '@mtg/cards';

/**
 * Roadmap 3.5: runs the resolver (hand scripts, then the auto-scripter) over the whole Scryfall base pool
 * and writes `data/coverage/report.json` plus a markdown summary with the top failing patterns.
 *
 * Flags: `--smoke` also plays the executability games (≈ 1 s/card, use with `--limit`), `--limit N` reads
 * only the first N cards, `--fixtures` uses the committed test fixtures when no bulk file is available.
 */
const DATA_DIR = process.env.DATA_DIR ?? 'data';
const BULK = join(DATA_DIR, 'scryfall', 'oracle-cards.json');
const OUT_DIR = join(DATA_DIR, 'coverage');

const flag = (name: string): boolean => process.argv.includes(name);
const value = (name: string): string | null => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

function load(): ScryfallCard[] {
  if (flag('--fixtures') || !existsSync(BULK)) {
    if (!flag('--fixtures')) {
      console.warn(`${BULK} not found; falling back to the committed test fixtures (--fixtures).`);
      console.warn('Run `pnpm fetch:scryfall` for a real coverage number.');
    }
    const dir = join('packages', 'cards', 'test', 'fixtures');
    return [
      ...(JSON.parse(readFileSync(join(dir, 'scryfall-subset.json'), 'utf8')) as ScryfallCard[]),
      ...(JSON.parse(readFileSync(join(dir, 'auto-corpus.json'), 'utf8')) as ScryfallCard[]),
    ];
  }
  return CardDatabase.fromBulkFile(BULK).filter(isBaseLegal);
}

const limit = Number(value('--limit') ?? '0');
let cards = load();
if (limit > 0) cards = cards.slice(0, limit);

const handScripts = handScriptsByOracleId();
console.log(`scoring ${cards.length} cards against ${handScripts.size} hand scripts`);

const report = coverageReport(cards, {
  handScripts,
  smoke: flag('--smoke'),
  onProgress: (done, total) => console.log(`  ${done}/${total}`),
});

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
const markdown = formatCoverage(report);
writeFileSync(join(OUT_DIR, 'report.md'), markdown);
console.log(`\n${markdown}`);
console.log(`written to ${join(OUT_DIR, 'report.json')} and report.md`);
