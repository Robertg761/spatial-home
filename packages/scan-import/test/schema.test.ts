import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { roomScanJsonSchema, SCHEMA_PATH } from '../scripts/json-schema.ts';

test('the JSON Schema is up to date (run `npm run schema -w @spatial-home/scan-import`)', () => {
  expect(readFileSync(SCHEMA_PATH, 'utf8')).toBe(roomScanJsonSchema());
});
