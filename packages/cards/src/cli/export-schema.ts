import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cardScriptJsonSchema } from '../schema.js';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'card-script.schema.json');
writeFileSync(out, `${JSON.stringify(cardScriptJsonSchema(), null, 2)}\n`);
console.log(`wrote ${out}`);
