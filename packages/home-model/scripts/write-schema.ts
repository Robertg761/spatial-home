// Writes schema/home-layout.v1.schema.json from the Zod schema, for tools that read the format
// without TypeScript. A test fails when the file is out of date.
//
//   npm run schema -w @spatial-home/home-model

import { writeFileSync } from 'node:fs';
import { homeLayoutJsonSchema, SCHEMA_PATH } from './json-schema.ts';

writeFileSync(SCHEMA_PATH, homeLayoutJsonSchema());
console.log(`Wrote ${SCHEMA_PATH}`);
