import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/*/vitest.config.ts',
      'apps/server/vitest.config.ts',
      'apps/web/vitest.config.ts',
    ],
  },
});
