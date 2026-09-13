import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'agents',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
