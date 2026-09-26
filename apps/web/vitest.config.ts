import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'web',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Components render into happy-dom; the pure modules do not mind it.
    environment: 'happy-dom',
    setupFiles: ['src/test/setup.ts'],
  },
});
