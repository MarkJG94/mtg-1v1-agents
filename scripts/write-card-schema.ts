/**
 * Write the card-script JSON Schema, so an editor completes and checks a YAML script as
 * it is typed (docs/03).
 *
 * The file is committed rather than generated on demand: it is read by editors, not by
 * the build, and a diff in it is a deliberate change to what a script may say.
 *
 * Usage:
 *   pnpm cards:schema [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { cardScriptJsonSchema } from '@mtg/cards';

const OUTPUT = 'packages/cards/schema/card-script.schema.json';

const main = (): void => {
  const { values } = parseArgs({ options: { check: { type: 'boolean' } } });
  const schema = `${JSON.stringify(cardScriptJsonSchema(), null, 2)}\n`;

  if (values.check === true) {
    const existing = readFileSync(OUTPUT, 'utf8');
    if (existing !== schema) {
      console.error(`${OUTPUT} is out of date; run pnpm cards:schema`);
      process.exitCode = 1;
      return;
    }
    console.log(`${OUTPUT} is up to date`);
    return;
  }

  writeFileSync(OUTPUT, schema);
  console.log(`wrote ${OUTPUT}`);
};

main();
