import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'cards',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
