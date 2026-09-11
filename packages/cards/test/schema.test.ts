import { describe, expect, it } from 'vitest';
import { cardScriptJsonSchema, parseCardScript } from '../src/schema.js';

describe('card-script schema', () => {
  it('accepts a minimal script and rejects unknown ops with a path', () => {
    const ok = parseCardScript({
      oracleId: 'x',
      name: 'X',
      types: ['instant'],
      text: '',
      abilities: [],
    });
    expect(ok.ok).toBe(true);
    const bad = parseCardScript({
      oracleId: 'x',
      name: 'X',
      types: ['instant'],
      text: '',
      abilities: [{ kind: 'spell', effects: [{ op: 'explode' }] }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join('\n')).toMatch(/abilities\.0/);
  });

  it('rejects unknown keys (typos) in filters', () => {
    const bad = parseCardScript({
      oracleId: 'x',
      name: 'X',
      types: ['instant'],
      text: '',
      abilities: [
        { kind: 'spell', targets: [{ id: 't', filter: { typ: 'creature' } }], effects: [] },
      ],
    });
    expect(bad.ok).toBe(false);
  });

  it('exports a JSON Schema with the top-level fields', () => {
    const schema = cardScriptJsonSchema();
    const props = (schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(['oracleId', 'name', 'types', 'text', 'abilities']),
    );
  });
});
