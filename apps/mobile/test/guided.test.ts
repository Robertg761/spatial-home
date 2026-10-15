import { importScan } from '@spatial-home/scan-import';
import { describe, expect, test } from 'vitest';
import {
  CLOSE_DISTANCE,
  addCorner,
  buildScan,
  crossesItself,
  MIN_ROOM_AREA,
  floorArea,
  refreshCorners,
  wallLengths,
  type CapturedRoom,
} from '../src/scan/guided.ts';
import type { Vector3 } from '../modules/arcore-scanner/index.ts';

// A 4 × 3 m room, as corners tapped on a floor 1.3 m below the phone's starting point.
const corners: Vector3[] = [
  [0, -1.3, 0],
  [4, -1.3, 0],
  [4, -1.3, -3],
  [0, -1.3, -3],
];

describe('measurements', () => {
  test('wall lengths, closing the room when asked', () => {
    expect(wallLengths(corners, false)).toEqual([4, 3, 4]);
    expect(wallLengths(corners, true)).toEqual([4, 3, 4, 3]);
  });

  test('floor area ignores height', () => {
    expect(floorArea(corners)).toBe(12);
  });
});

describe('addCorner', () => {
  test('adds corners', () => {
    expect(addCorner([], corners[0]!)).toEqual({ kind: 'added', corners: [corners[0]] });
  });

  test('closes the room when aiming back at the first corner', () => {
    const near: Vector3 = [CLOSE_DISTANCE / 2, -1.3, 0.05];
    expect(addCorner(corners, near)).toEqual({ kind: 'closes', corners });
    // With only two corners there's no room to close yet.
    expect(addCorner(corners.slice(0, 2), near).kind).toBe('added');
  });

  test('ignores the same corner tapped twice', () => {
    expect(addCorner(corners.slice(0, 2), [4.05, -1.3, 0])).toEqual({ kind: 'too-close' });
  });
});

test('crossesItself spots a bow tie', () => {
  expect(crossesItself(corners)).toBe(false);
  expect(crossesItself([corners[0]!, corners[2]!, corners[1]!, corners[3]!])).toBe(true);
});

test('a guided capture imports as a valid layout', () => {
  const rooms: CapturedRoom[] = [{ name: 'Bedroom', corners, ceilingHeight: 2.4 }];
  const result = importScan(buildScan(rooms));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.validation.ok).toBe(true);
  expect(result.layout.rooms[0]).toMatchObject({ name: 'Bedroom', ceilingHeight: 2.4 });
  expect(result.layout.rooms[0]!.outline).toHaveLength(4);
});

test('a room whose corners are in a line is caught before import, which would refuse it', () => {
  const inLine: Vector3[] = [
    [0, -1.3, 0],
    [2, -1.3, 0],
    [4, -1.3, 0],
  ];
  expect(floorArea(inLine)).toBeLessThan(MIN_ROOM_AREA);
  const result = importScan(buildScan([{ name: 'Hall', corners: inLine, ceilingHeight: 2.4 }]));
  expect(result.ok).toBe(false);
});

test('corners take the positions ARCore reports now, and keep their last one if it has none', () => {
  const placed = [
    { id: 1, point: [0, -1.3, 0] as Vector3 },
    { id: 2, point: [4, -1.3, 0] as Vector3 },
  ];
  expect(refreshCorners(placed, [[0.01, -1.3, 0], null])).toEqual([
    { id: 1, point: [0.01, -1.3, 0] },
    { id: 2, point: [4, -1.3, 0] },
  ]);
});
