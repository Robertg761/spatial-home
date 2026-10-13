import { describe, expect, test } from 'vitest';
import {
  compassPoint,
  isSimplePolygon,
  openingCenter,
  openingFacing,
  planHeading,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  roomConnections,
  roomWalls,
  signedArea,
  wallOutwardNormal,
} from '../src/geometry.ts';
import type { Point2 } from '../src/schema.ts';
import { sampleLayout } from './sample.ts';

const square: Point2[] = [
  [0, 0],
  [4, 0],
  [4, 4],
  [0, 4],
];
const clockwiseSquare: Point2[] = [...square].reverse();
const lShape: Point2[] = [
  [0, 0],
  [4, 0],
  [4, 2],
  [2, 2],
  [2, 4],
  [0, 4],
];

describe('polygons', () => {
  test('area is positive anticlockwise and negative clockwise', () => {
    expect(signedArea(square)).toBe(16);
    expect(signedArea(clockwiseSquare)).toBe(-16);
    expect(polygonArea(clockwiseSquare)).toBe(16);
    expect(polygonArea(lShape)).toBe(12);
  });

  test('centroid', () => {
    expect(polygonCentroid(square)).toEqual([2, 2]);
    const [x, y] = polygonCentroid(lShape);
    expect(x).toBeCloseTo(5 / 3);
    expect(y).toBeCloseTo(5 / 3);
  });

  test('point in polygon, counting the edge as inside', () => {
    expect(pointInPolygon([1, 1], lShape)).toBe(true);
    expect(pointInPolygon([3, 3], lShape)).toBe(false);
    expect(pointInPolygon([4, 1], lShape)).toBe(true);
    expect(pointInPolygon([0, 0], lShape)).toBe(true);
    expect(pointInPolygon([-0.1, 1], lShape)).toBe(false);
  });

  test.each<[string, Point2[], boolean]>([
    ['a square', square, true],
    ['an L shape', lShape, true],
    ['a square wound clockwise', clockwiseSquare, true],
    [
      'a corner on a straight wall',
      [
        [0, 0],
        [2, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
      true,
    ],
    [
      'a bow tie',
      [
        [0, 0],
        [4, 4],
        [4, 0],
        [0, 4],
      ],
      false,
    ],
    [
      'a repeated corner',
      [
        [0, 0],
        [4, 0],
        [4, 0],
        [4, 4],
        [0, 4],
      ],
      false,
    ],
    [
      'a wall that doubles back',
      [
        [0, 0],
        [4, 0],
        [2, 0],
        [2, 4],
      ],
      false,
    ],
    [
      'a corner touching another wall',
      [
        [0, 0],
        [4, 0],
        [4, 4],
        [2, 0],
        [0, 4],
      ],
      false,
    ],
    // Two 10 cm walls crossing at their centres, at an angle shallow enough that the raw cross
    // product falls below the tolerance even though their ends are 4 µm apart.
    [
      'a shallow bow tie',
      [
        [0, 0],
        [0.1, 0.000004],
        [0.1, 0],
        [0, 0.000004],
      ],
      false,
    ],
  ])('%s is simple: %s', (_name, outline, simple) => {
    expect(isSimplePolygon(outline)).toBe(simple);
  });
});

describe('walls', () => {
  test('run from each corner to the next, closing the outline', () => {
    const walls = roomWalls({ outline: lShape });
    expect(walls).toHaveLength(6);
    expect(walls[5]).toEqual({ index: 5, start: [0, 4], end: [0, 0], length: 4 });
  });

  test('outward normals point out of the room whichever way it winds', () => {
    expect(wallOutwardNormal({ outline: square }, 0)).toEqual([0, -1]);
    // Reversed, the first wall is the top one.
    expect(wallOutwardNormal({ outline: clockwiseSquare }, 0)).toEqual([0, 1]);
    expect(wallOutwardNormal({ outline: lShape }, 2)).toEqual([0, 1]);
  });

  test('opening centre is offset along the wall from its start', () => {
    expect(
      openingCenter({ outline: square }, { wall: { roomId: 'r', index: 1 }, offset: 1 })
    ).toEqual([4, 1]);
  });
});

describe('directions', () => {
  test('plan heading is clockwise from the top of the plan', () => {
    expect(planHeading([0, 1])).toBe(0);
    expect(planHeading([1, 0])).toBe(90);
    expect(planHeading([0, -1])).toBe(180);
    expect(planHeading([-1, 0])).toBe(270);
  });

  test.each([
    [0, 'N'],
    [22, 'N'],
    [23, 'NE'],
    [90, 'E'],
    [200, 'S'],
    [337.6, 'N'],
    [-90, 'W'],
  ])('%s° is %s', (bearing, point) => {
    expect(compassPoint(bearing)).toBe(point);
  });

  test("windows face out of their room's wall", () => {
    const layout = sampleLayout();
    const facing = (id: string) =>
      openingFacing(
        layout,
        layout.openings.find((o) => o.id === id)!
      );
    expect(facing('living-room-window')).toEqual({ bearing: 270, compass: 'W' });
    expect(facing('bedroom-window')).toEqual({ bearing: 90, compass: 'E' });
    expect(facing('kitchen-window')).toEqual({ bearing: 0, compass: 'N' });
    expect(facing('front-door')).toEqual({ bearing: 180, compass: 'S' });
  });

  test("compass directions follow the site's north", () => {
    const layout = sampleLayout();
    // The top of the plan faces east, so the plan's left wall faces north.
    layout.site.northBearing = 90;
    const window = layout.openings.find((o) => o.id === 'living-room-window')!;
    expect(openingFacing(layout, window)).toEqual({ bearing: 0, compass: 'N' });
  });
});

describe('roomConnections', () => {
  test('lists every way out of each room, in both directions', () => {
    const connections = roomConnections(sampleLayout());
    const destinations = (room: string) =>
      connections
        .get(room)!
        .map((c) => c.to)
        .sort();
    expect(destinations('hallway')).toEqual([
      'bathroom',
      'bedroom',
      'kitchen',
      'living-room',
      'outside',
    ]);
    expect(destinations('living-room')).toEqual(['hallway', 'kitchen', 'outside']);
    expect(destinations('kitchen')).toEqual(['hallway', 'living-room', 'outside']);
    expect(
      connections
        .get('outside')!
        .map((c) => c.openingId)
        .sort()
    ).toEqual(['bedroom-window', 'front-door', 'kitchen-window', 'living-room-window']);
  });
});
