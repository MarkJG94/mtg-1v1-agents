/**
 * Roll a seed deck from the whole of Scryfall (docs/05 "Seed deck generation", roadmap
 * 5.3) and print it as a plain-text decklist, the same seventy-five a run with these
 * settings would start both agents on.
 *
 * Every card drawn goes through the real resolver — hand scripts first, then the
 * auto-scripter, smoke test and all — so what it prints is only what the engine can play,
 * and the summary says how many draws it had to put back.
 *
 * Usage:
 *   pnpm seed:deck [--seed 1] [--colours WU] [--lands 24] [--jitter 2] [--format vintage]
 *
 * Needs `data/scryfall/cards.jsonl` (`pnpm fetch:scryfall`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  autoScripter,
  type CardProjection,
  loadHandScripts,
  ScriptResolver,
} from '../packages/cards/src/index.js';
import { type Colour, parseRunSettings } from '../packages/shared/src/index.js';
import { generateSeedDeck, SeedDeckError } from '../packages/sim/src/index.js';

const INPUT = 'data/scryfall/cards.jsonl';

const { values } = parseArgs({
  options: {
    seed: { type: 'string', default: '1' },
    colours: { type: 'string', default: '' },
    lands: { type: 'string' },
    jitter: { type: 'string' },
    format: { type: 'string' },
  },
});

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

if (!existsSync(INPUT)) fail(`${INPUT} is missing: run \`pnpm fetch:scryfall\` first`);

const settings = (() => {
  try {
    return parseRunSettings({
      seed: values.seed,
      seedDeckColours: [...(values.colours ?? '').toUpperCase()] as Colour[],
      ...(values.lands === undefined ? {} : { seedDeckLands: Number(values.lands) }),
      ...(values.jitter === undefined ? {} : { seedDeckLandsJitter: Number(values.jitter) }),
      ...(values.format === undefined ? {} : { legalityFilter: values.format as 'vintage' }),
    });
  } catch (error) {
    return fail(`bad settings: ${(error as Error).message}`);
  }
})();

const pool: CardProjection[] = readFileSync(INPUT, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as CardProjection);
const names = new Map(pool.map((card) => [card.oracleId, card.name]));

const started = performance.now();
const seed = (() => {
  try {
    return generateSeedDeck({
      pool,
      resolver: new ScriptResolver({ hand: loadHandScripts(), auto: autoScripter }),
      seed: `${settings.seed}:seed-deck`,
      settings,
    });
  } catch (error) {
    if (error instanceof SeedDeckError) return fail(error.message);
    throw error;
  }
})();
const took = performance.now() - started;

const lines = (slots: readonly { oracleId: string; count: number }[]) =>
  slots
    .map((slot) => ({ name: names.get(slot.oracleId) ?? slot.oracleId, count: slot.count }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((slot) => `${slot.count} ${slot.name}`);

console.log(lines(seed.deck.main).join('\n'));
console.log('\nSideboard');
console.log(lines(seed.deck.side).join('\n'));
console.error(
  `\n${seed.colours.join('')}, ${seed.lands} lands (${seed.nonbasicLands} nonbasic); ` +
    `${seed.rerolled.length} draws re-rolled as unplayable; ${Math.round(took)} ms`,
);
