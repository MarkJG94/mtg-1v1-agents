import { defineConfig } from 'drizzle-kit';

/** `pnpm db:generate`: a migration under `drizzle/` for each change to `src/db/schema.ts`. */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
