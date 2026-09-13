import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'neutral',
  target: 'node22',
  sourcemap: true,
  clean: true,
  dts: false,
});
