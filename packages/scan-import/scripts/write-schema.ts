// Writes schema/room-scan.v1.schema.json, for the Swift and Kotlin scanners that write room scans.
// A test fails when the file is out of date.
//
//   npm run schema -w @spatial-home/scan-import

import { writeFileSync } from 'node:fs';
import { roomScanJsonSchema, SCHEMA_PATH } from './json-schema.ts';

writeFileSync(SCHEMA_PATH, roomScanJsonSchema());
console.log(`Wrote ${SCHEMA_PATH}`);
