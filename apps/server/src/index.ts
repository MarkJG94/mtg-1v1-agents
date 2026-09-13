import { mkdirSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
for (const dir of [config.dataDir, config.scryfallDir, config.imageCacheDir]) {
  mkdirSync(dir, { recursive: true });
}

const app = await buildApp(config);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    void app.close().then(() => process.exit(0));
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error(error, 'failed to start');
  process.exit(1);
}
