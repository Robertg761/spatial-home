import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { HomeLayoutSchema, LAYOUT_VERSION } from '../src/schema.ts';

export const SCHEMA_PATH = fileURLToPath(
  new URL(`../schema/home-layout.v${LAYOUT_VERSION}.schema.json`, import.meta.url)
);

export function homeLayoutJsonSchema(): string {
  const schema = z.toJSONSchema(HomeLayoutSchema, { target: 'draft-2020-12' });
  return `${JSON.stringify({ title: `Spatial Home layout, version ${LAYOUT_VERSION}`, ...schema }, null, 2)}\n`;
}
