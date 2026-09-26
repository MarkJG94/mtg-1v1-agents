import { existsSync, mkdirSync } from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/open.js';
import { Supervisor } from './workers/supervisor.js';

const config = loadConfig();
for (const dir of [config.dataDir, config.scryfallDir, config.imageCacheDir]) {
  mkdirSync(dir, { recursive: true });
}

// Opening the database brings it up to date with every migration, so a server that
// cannot read or migrate it fails here rather than at the first run it is asked for.
const database = openDatabase(config.databasePath);
const supervisor = new Supervisor({
  database,
  workers: config.simWorkers,
  cardsPath: config.cardsPath,
  handScriptsDir: config.cardScriptsDir,
});
const app = await buildApp(config, { supervisor });
supervisor.on((event) => {
  if (event.type === 'runFailed') app.log.error({ runId: event.runId }, event.message);
  if (event.type === 'runHalted') app.log.info(event, 'run halted');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    // A run on a worker stays `running` at its last checkpoint, and the next start
    // resumes it: only the match in progress is played again.
    void app
      .close()
      .then(() => supervisor.close())
      .then(() => {
        database.close();
        process.exit(0);
      });
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
  // Every run left running by a crash or a restart plays on (docs/06 "Resume protocol").
  if (existsSync(config.cardsPath)) {
    const resumed = await supervisor.resumeRunning();
    if (resumed.length > 0) app.log.info({ runs: resumed }, 'resuming runs');
  } else {
    app.log.warn(`${config.cardsPath} is missing (pnpm fetch:scryfall): no run can play`);
  }
} catch (error) {
  app.log.error(error, 'failed to start');
  process.exit(1);
}
