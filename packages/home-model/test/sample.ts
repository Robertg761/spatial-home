import { readFileSync } from 'node:fs';
import type { HomeLayout } from '../src/schema.ts';

export const SAMPLE_PATH = new URL('../examples/sample-flat.json', import.meta.url);

/** A fresh copy of the sample flat, for tests to modify. */
export function sampleLayout(): HomeLayout {
  return JSON.parse(readFileSync(SAMPLE_PATH, 'utf8')) as HomeLayout;
}
