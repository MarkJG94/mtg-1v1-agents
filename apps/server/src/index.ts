import { mkdirSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/open.js';

const config = loadConfig();
for (const dir of [config.dataDir, config.scryfallDir, config.imageCacheDir]) {
  mkdirSync(dir, { recursive: true });
}

// Opening the database brings it up to date with every migration, so a server that
// cannot read or migrate it fails here rather than at the first run it is asked for.
const database = openDatabase(config.databasePath);
const app = await buildApp(config);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => {
      database.close();
      process.exit(0);
    });
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error, 'failed to start');
  process.exit(1);
}
