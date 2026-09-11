import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CardDatabase, HAND_SCRIPTS_DIR, loadHandScriptFiles, type ScryfallCard } from '@mtg/cards';

/**
 * Rebuilds packages/cards/test/fixtures/scryfall-subset.json from the real bulk file for every hand script,
 * and rewrites placeholder `fixture:` oracle ids in the scripts with the real ones. Requires
 * `pnpm fetch:scryfall` to have run.
 */
const DATA_DIR = process.env.DATA_DIR ?? 'data';
const BULK = join(DATA_DIR, 'scryfall', 'oracle-cards.json');
if (!existsSync(BULK)) {
  console.error(`${BULK} not found. Run \`pnpm fetch:scryfall\` first.`);
  process.exit(1);
}
const db = loadBulk();

function loadBulk(): CardDatabase {
  try {
    return CardDatabase.fromBulkFile(BULK);
  } catch (e) {
    console.error(`could not read ${BULK}: ${(e as Error).message}`);
    console.error('Re-download it with `pnpm fetch:scryfall --force`.');
    process.exit(1);
  }
}
const FIELDS: (keyof ScryfallCard)[] = [
  'oracle_id',
  'id',
  'name',
  'mana_cost',
  'cmc',
  'colors',
  'color_identity',
  'type_line',
  'oracle_text',
  'power',
  'toughness',
  'loyalty',
  'keywords',
  'layout',
  'legalities',
  'set',
  'rarity',
];

const subset: Partial<ScryfallCard>[] = [];
let rewritten = 0;
for (const f of loadHandScriptFiles(HAND_SCRIPTS_DIR)) {
  if (!f.name) continue;
  const card = db.named(f.name);
  if (!card) {
    console.warn(`no Scryfall card named "${f.name}" (${f.path})`);
    continue;
  }
  const entry: Partial<ScryfallCard> = {};
  for (const k of FIELDS)
    if (card[k] !== undefined) (entry as Record<string, unknown>)[k] = card[k];
  entry.legalities = { vintage: card.legalities.vintage ?? 'not_legal' };
  subset.push(entry);
  if (f.oracleId !== card.oracle_id) {
    const text = readFileSync(f.path, 'utf8').replace(
      /^oracleId:.*$/m,
      `oracleId: ${card.oracle_id}`,
    );
    writeFileSync(f.path, text);
    rewritten++;
  }
}
writeFileSync(
  join(HAND_SCRIPTS_DIR, '..', 'test', 'fixtures', 'scryfall-subset.json'),
  `${JSON.stringify(subset, null, 2)}\n`,
);
console.log(`fixture: ${subset.length} cards; rewrote ${rewritten} oracle ids`);
