import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  dts: false,
  // Workspace packages are published as TypeScript source, so they are bundled in
  // rather than left as bare imports the Docker image could not resolve.
  noExternal: [/^@mtg\//],
});
