import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { SCAN_VERSION, ScanSessionSchema } from '../src/scan.ts';

export const SCHEMA_PATH = fileURLToPath(
  new URL(`../schema/room-scan.v${SCAN_VERSION}.schema.json`, import.meta.url)
);

export function roomScanJsonSchema(): string {
  // "input": lists the importer fills in when they're left out are optional in the file.
  const schema = z.toJSONSchema(ScanSessionSchema, { target: 'draft-2020-12', io: 'input' });
  return `${JSON.stringify({ title: `Spatial Home room scan, version ${SCAN_VERSION}`, ...schema }, null, 2)}\n`;
}
