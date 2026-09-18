import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultSimWorkers, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('applies defaults when the environment is empty', () => {
    const config = loadConfig({});
    expect(config.port).toBe(8080);
    expect(config.host).toBe('0.0.0.0');
    expect(config.dataDir).toBe(resolve('data'));
    expect(config.databasePath).toBe(join(resolve('data'), 'mtg.db'));
    expect(config.scryfallImageCache).toBe('lazy');
    expect(config.simWorkers).toBe(defaultSimWorkers());
    expect(config.webDist).toBeUndefined();
  });

  it('reads numbers and paths from the environment', () => {
    const config = loadConfig({ PORT: '3000', DATA_DIR: '/srv/mtg', SIM_WORKERS: '4' });
    expect(config.port).toBe(3000);
    expect(config.dataDir).toBe('/srv/mtg');
    expect(config.scryfallDir).toBe('/srv/mtg/scryfall');
    expect(config.imageCacheDir).toBe('/srv/mtg/images');
    expect(config.simWorkers).toBe(4);
  });

  it('never reports fewer than one simulation worker', () => {
    expect(defaultSimWorkers()).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ['a port outside the valid range', { PORT: '70000' }],
    ['a non-numeric port', { PORT: 'http' }],
    ['an unknown image cache mode', { SCRYFALL_IMAGE_CACHE: 'eager' }],
    ['zero simulation workers', { SIM_WORKERS: '0' }],
  ])('rejects %s', (_label, env) => {
    expect(() => loadConfig(env)).toThrow();
  });
});

describe('empty environment variables', () => {
  it('treats an empty value as unset, as Docker Compose passes them', () => {
    const config = loadConfig({ SIM_WORKERS: '', PORT: '', SCRYFALL_IMAGE_CACHE: '' });
    expect(config.simWorkers).toBe(defaultSimWorkers());
    expect(config.port).toBe(8080);
    expect(config.scryfallImageCache).toBe('lazy');
  });
});
