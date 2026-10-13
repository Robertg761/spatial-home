import { LAYOUT_FORMAT, LAYOUT_VERSION, type HomeLayout } from './schema.ts';

/** A new layout with one ground floor and nothing on it, with the top of the plan facing north. */
export function createEmptyLayout(name?: string): HomeLayout {
  return {
    format: LAYOUT_FORMAT,
    version: LAYOUT_VERSION,
    ...(name ? { name } : {}),
    site: { northBearing: 0 },
    floors: [{ id: 'ground-floor', name: 'Ground floor', level: 0, elevation: 0 }],
    rooms: [],
    openings: [],
    fixtures: [],
    devices: [],
  };
}

/**
 * Writes a layout as home-layout.json text: two-space indents, with coordinates and other lists of
 * numbers kept on one line so that a diff shows which point moved.
 */
export function serializeLayout(layout: HomeLayout): string {
  return `${format(layout, '')}\n`;
}

function format(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((item) => typeof item === 'number')) {
      return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
    }
    const inner = `${indent}  `;
    return `[\n${value.map((item) => inner + format(item, inner)).join(',\n')}\n${indent}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return '{}';
    const inner = `${indent}  `;
    const lines = entries.map(
      ([key, item]) => `${inner}${JSON.stringify(key)}: ${format(item, inner)}`
    );
    return `{\n${lines.join(',\n')}\n${indent}}`;
  }
  return JSON.stringify(value);
}
