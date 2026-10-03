import { defineConfig } from 'tsup';

export default defineConfig({
  // The workers are entries of their own: the server starts them from `dist/` by name.
  entry: {
    index: 'src/index.ts',
    'sim-worker': 'src/workers/sim-worker.ts',
    'script-worker': 'src/workers/script-worker.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  dts: false,
  // Workspace packages are published as TypeScript source, so they are bundled in
  // rather than left as bare imports the Docker image could not resolve.
  noExternal: [/^@mtg\//],
  // Some of what the card packages bring in (yaml) is CommonJS, bundled here into ESM,
  // where \`require\` does not exist unless it is made.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
