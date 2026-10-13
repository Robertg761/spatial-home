import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { homeLayoutJsonSchema, SCHEMA_PATH } from '../scripts/json-schema.ts';
import { createEmptyLayout, serializeLayout } from '../src/layout.ts';
import { validateLayout } from '../src/validate.ts';
import { SAMPLE_PATH, sampleLayout } from './sample.ts';

describe('serializeLayout', () => {
  test('keeps lists of numbers on one line', () => {
    const text = serializeLayout(sampleLayout());
    expect(text).toContain('        [0, 0],\n        [5, 0],');
    expect(text).toContain('"position": [6, 7.9, 2.3],');
    expect(text.endsWith('}\n')).toBe(true);
  });

  test('writes the sample flat exactly as it is stored', () => {
    const result = validateLayout(sampleLayout());
    expect(result.ok && serializeLayout(result.layout)).toBe(readFileSync(SAMPLE_PATH, 'utf8'));
  });

  test('puts keys in the format order, whatever order they arrived in', () => {
    const { rooms, ...rest } = createEmptyLayout();
    const result = validateLayout({ rooms, ...rest });
    expect(result.ok && Object.keys(result.layout)).toEqual([
      'format',
      'version',
      'site',
      'floors',
      'rooms',
      'openings',
      'fixtures',
      'devices',
    ]);
  });

  test('leaves out optional fields that are not set', () => {
    expect(serializeLayout(createEmptyLayout())).not.toMatch(/^  "name"/m);
    expect(serializeLayout(createEmptyLayout('Home'))).toMatch(/^  "name": "Home",$/m);
  });
});

describe('JSON Schema', () => {
  test('is up to date with the Zod schema (run `npm run schema -w @spatial-home/home-model`)', () => {
    expect(readFileSync(SCHEMA_PATH, 'utf8')).toBe(homeLayoutJsonSchema());
  });
});
