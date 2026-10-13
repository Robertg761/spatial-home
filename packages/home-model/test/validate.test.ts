import { describe, expect, test } from 'vitest';
import { createEmptyLayout, serializeLayout } from '../src/layout.ts';
import { parseLayoutJson, validateLayout, type ValidationResult } from '../src/validate.ts';
import type { HomeLayout } from '../src/schema.ts';
import { sampleLayout } from './sample.ts';

function errorsOf(result: ValidationResult) {
  return result.ok ? [] : result.errors.map(({ code, path }) => ({ code, path }));
}

function warningsOf(result: ValidationResult) {
  return result.warnings.map(({ code, path }) => ({ code, path }));
}

function modified(change: (layout: HomeLayout) => void): ValidationResult {
  const layout = sampleLayout();
  change(layout);
  return validateLayout(layout);
}

describe('validateLayout', () => {
  test('accepts the sample flat with no warnings', () => {
    const result = validateLayout(sampleLayout());
    expect(errorsOf(result)).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('accepts an empty layout', () => {
    expect(validateLayout(createEmptyLayout('New home')).ok).toBe(true);
  });

  test('rejects something that is not a layout', () => {
    expect(errorsOf(validateLayout([]))).toEqual([{ code: 'not-a-layout', path: [] }]);
    expect(errorsOf(validateLayout({ format: 'geojson' }))).toEqual([
      { code: 'not-a-layout', path: ['format'] },
    ]);
  });

  test('explains a file from a newer version', () => {
    const result = modified((layout) => {
      (layout as { version: number }).version = 2;
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors[0]).toMatchObject({
      code: 'unsupported-version',
      message: expect.stringContaining('version 2'),
    });
  });

  test('reports structural problems with their paths', () => {
    const result = modified((layout) => {
      layout.rooms[0]!.ceilingHeight = -1;
      (layout.rooms[1] as Record<string, unknown>).ceilingHieght = 2.4;
      layout.openings[0]!.width = 0;
    });
    expect(errorsOf(result)).toEqual(
      expect.arrayContaining([
        { code: 'invalid-too-small', path: ['rooms', 0, 'ceilingHeight'] },
        { code: 'invalid-unrecognized-keys', path: ['rooms', 1] },
        { code: 'invalid-too-small', path: ['openings', 0, 'width'] },
      ])
    );
  });

  test('rejects an entity id that is not one', () => {
    const result = modified((layout) => {
      layout.devices[0]!.ha!.entityIds = ['Hallway Motion'];
    });
    expect(errorsOf(result)).toEqual([
      { code: 'invalid-invalid-format', path: ['devices', 0, 'ha', 'entityIds', 0] },
    ]);
  });

  test('rejects duplicate and reserved ids', () => {
    const result = modified((layout) => {
      layout.fixtures[0]!.id = 'kitchen';
      layout.devices[0]!.id = 'outside';
    });
    expect(errorsOf(result)).toEqual([
      { code: 'duplicate-id', path: ['fixtures', 0, 'id'] },
      { code: 'reserved-id', path: ['devices', 0, 'id'] },
    ]);
  });

  test('rejects references to things that do not exist', () => {
    const result = modified((layout) => {
      layout.rooms[0]!.floorId = 'attic';
      layout.openings[0]!.wall.roomId = 'garage';
      layout.openings[1]!.connects = 'garage';
      layout.fixtures[0]!.roomId = 'garage';
      layout.devices[0]!.roomId = 'garage';
    });
    expect(errorsOf(result)).toEqual([
      { code: 'unknown-floor', path: ['rooms', 0, 'floorId'] },
      { code: 'unknown-room', path: ['openings', 0, 'wall', 'roomId'] },
      { code: 'unknown-room', path: ['openings', 1, 'connects'] },
      { code: 'unknown-room', path: ['fixtures', 0, 'roomId'] },
      { code: 'unknown-room', path: ['devices', 0, 'roomId'] },
    ]);
  });

  test('rejects outlines with no area or that cross themselves', () => {
    const result = modified((layout) => {
      // A sliver a tenth of a millimetre across.
      layout.rooms[0]!.outline = [
        [0, 0],
        [0.0001, 0],
        [0, 0.0001],
      ];
      layout.rooms[1]!.outline = [
        [0, 4],
        [5, 8],
        [5, 4],
        [0, 8],
      ];
      layout.rooms[3]!.outline = [
        [7, 0],
        [11, 0],
        [9, 0],
      ];
    });
    // Only the outlines are reported, not the openings, fixtures and devices in those rooms.
    expect(errorsOf(result)).toEqual([
      { code: 'empty-outline', path: ['rooms', 0, 'outline'] },
      { code: 'self-intersecting-outline', path: ['rooms', 1, 'outline'] },
      { code: 'self-intersecting-outline', path: ['rooms', 3, 'outline'] },
    ]);
    expect(result.warnings).toEqual([]);
  });

  test('rejects openings that do not fit their wall', () => {
    const result = modified((layout) => {
      // The front door's wall is 2 m long.
      layout.openings[0]!.offset = 1.8;
      layout.openings[1]!.wall.index = 4;
    });
    expect(errorsOf(result)).toEqual([
      { code: 'opening-outside-wall', path: ['openings', 0, 'offset'] },
      { code: 'unknown-wall', path: ['openings', 1, 'wall', 'index'] },
    ]);
  });

  test('accepts an opening that exactly fills its wall', () => {
    const result = modified((layout) => {
      Object.assign(layout.openings[0]!, { offset: 1, width: 2 });
    });
    expect(errorsOf(result)).toEqual([]);
  });

  test('rejects an opening into its own room', () => {
    const result = modified((layout) => {
      layout.openings[1]!.connects = 'hallway';
    });
    expect(errorsOf(result)).toEqual([
      { code: 'opening-to-same-room', path: ['openings', 1, 'connects'] },
    ]);
  });

  test('requires a heading for coverage narrower than all around', () => {
    const result = modified((layout) => {
      delete layout.devices[0]!.heading;
    });
    expect(errorsOf(result)).toEqual([
      { code: 'coverage-needs-heading', path: ['devices', 0, 'coverage', 0, 'fieldOfView'] },
    ]);
  });

  test('warns about likely mistakes without rejecting the layout', () => {
    const result = modified((layout) => {
      layout.floors.push({ id: 'also-ground', name: 'Also ground', level: 0, elevation: 0 });
      layout.rooms.push({
        id: 'loft',
        name: 'Loft',
        floorId: 'also-ground',
        outline: [
          [0, 0],
          [2, 0],
          [2, 2],
        ],
        ceilingHeight: 2,
      });
      layout.openings.push({
        kind: 'door',
        id: 'loft-door',
        wall: { roomId: 'kitchen', index: 0 },
        offset: 1,
        width: 0.8,
        height: 2.8,
        connects: 'loft',
      });
      layout.fixtures[0]!.position = [20, 20];
      layout.devices[1]!.position = [2, 2, 3];
      layout.devices[2]!.ha!.entityIds = ['light.reading_lamp'];
    });
    expect(result.ok).toBe(true);
    expect(warningsOf(result)).toEqual([
      { code: 'duplicate-level', path: ['floors', 1, 'level'] },
      { code: 'opening-above-ceiling', path: ['openings', 9, 'height'] },
      { code: 'opening-between-floors', path: ['openings', 9, 'connects'] },
      { code: 'outside-room', path: ['fixtures', 0, 'position'] },
      { code: 'height-outside-room', path: ['devices', 1, 'position', 2] },
      { code: 'entity-placed-twice', path: ['devices', 2, 'ha', 'entityIds', 0] },
    ]);
  });

  test('returns warnings alongside errors', () => {
    const result = modified((layout) => {
      layout.rooms[0]!.floorId = 'attic';
      layout.fixtures[0]!.position = [20, 20];
    });
    expect(result.ok).toBe(false);
    expect(warningsOf(result)).toEqual([
      { code: 'outside-room', path: ['fixtures', 0, 'position'] },
    ]);
  });
});

describe('parseLayoutJson', () => {
  test('reports text that is not JSON', () => {
    expect(errorsOf(parseLayoutJson('{ "rooms": '))).toEqual([{ code: 'invalid-json', path: [] }]);
  });

  test('reads what serializeLayout writes', () => {
    const layout = sampleLayout();
    const result = parseLayoutJson(serializeLayout(layout));
    expect(result.ok && result.layout).toEqual(layout);
  });
});
