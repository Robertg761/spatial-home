import { openingFacing, polygonArea, type HomeLayout, type Point2 } from '@spatial-home/home-model';
import { describe, expect, test } from 'vitest';
import { importScan, type ImportResult } from '../src/import.ts';
import { session, toWorld, wallsAround } from './fixtures.ts';

const NORTH = 20;
const bedroom: Point2[] = [
  [0, 0],
  [4, 0],
  [4, 3],
  [0, 3],
];

function imported(result: ImportResult): Extract<ImportResult, { ok: true }> {
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result;
}

function expectOutline(actual: Point2[], expected: Point2[], tolerance = 0.03) {
  // Same corners, in some order and from some starting corner.
  expect(actual).toHaveLength(expected.length);
  for (const corner of expected) {
    const nearest = Math.min(
      ...actual.map((point) => Math.hypot(point[0] - corner[0], point[1] - corner[1]))
    );
    expect(nearest).toBeLessThan(tolerance);
  }
}

function roomPlanBedroom() {
  return session(
    [
      {
        name: 'Bedroom',
        walls: wallsAround(bedroom, 2.45, NORTH),
        openings: [
          // A door in the south wall, and a window in the west wall from 0.9 m to 2.1 m up.
          { kind: 'door', center: toWorld([1, 0], 1.03, NORTH), width: 0.82, height: 2.06 },
          { kind: 'window', center: toWorld([0, 1.5], 1.5, NORTH), width: 1.2, height: 1.2 },
        ],
        objects: [
          // A bed along the east wall, turned a quarter anticlockwise from the plan's axes.
          {
            category: 'bed',
            center: toWorld([2.8, 1.5], 0.3, NORTH),
            size: [1.6, 0.6, 2.0],
            yaw: ((90 + NORTH) * Math.PI) / 180,
          },
          {
            category: 'storage',
            center: toWorld([0.4, 2.7], 0.9, NORTH),
            size: [0.8, 1.8, 0.5],
            yaw: (NORTH * Math.PI) / 180,
          },
        ],
      },
    ],
    NORTH
  );
}

describe('a RoomPlan-style scan', () => {
  test('becomes a valid layout', () => {
    const { layout, validation } = imported(importScan(roomPlanBedroom()));
    expect(validation.ok && validation.warnings).toEqual([]);
    expect(layout.rooms).toHaveLength(1);
  });

  test('closes the walls into the room, squared up to the plan', () => {
    const { layout } = imported(importScan(roomPlanBedroom()));
    const [room] = layout.rooms;
    expectOutline(room!.outline, bedroom);
    expect(polygonArea(room!.outline)).toBeCloseTo(12, 0);
    expect(room!.ceilingHeight).toBe(2.45);
  });

  test('keeps true compass directions after turning the plan', () => {
    const { layout } = imported(importScan(roomPlanBedroom()));
    expect(layout.site.northBearing).toBe(0);
    const facing = (kind: string) =>
      openingFacing(
        layout,
        layout.openings.find((o) => o.kind === kind)!
      ).compass;
    expect(facing('window')).toBe('W');
    expect(facing('door')).toBe('S');
  });

  test('puts openings on their walls with their sizes', () => {
    const { layout } = imported(importScan(roomPlanBedroom()));
    const window = layout.openings.find((opening) => opening.kind === 'window');
    expect(window).toMatchObject({ width: 1.2, height: 1.2, sillHeight: 0.9, connects: 'outside' });
    const door = layout.openings.find((opening) => opening.kind === 'door');
    expect(door).toMatchObject({ width: 0.82, height: 2.06 });
  });

  test('turns furniture with the plan', () => {
    const { layout } = imported(importScan(roomPlanBedroom()));
    const bed = layout.fixtures.find((fixture) => fixture.kind === 'bed')!;
    expect(bed).toMatchObject({ name: 'Bed', size: { width: 1.6, depth: 2, height: 0.6 } });
    // A quarter turn anticlockwise is 270° clockwise.
    expect(bed.rotation).toBe(270);
    expect(layout.fixtures.find((fixture) => fixture.kind === 'storage')!.rotation).toBe(0);
    expect(bed.position[0]).toBeCloseTo(2.8, 1);
    expect(bed.position[1]).toBeCloseTo(1.5, 1);
  });

  test('says when a door may not really lead outside', () => {
    const { notes } = imported(importScan(roomPlanBedroom()));
    expect(notes.map((note) => note.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('1 door leads outside')])
    );
  });

  test('can keep the scan orientation', () => {
    const { layout } = imported(importScan(roomPlanBedroom(), { alignToWalls: false }));
    expect(layout.site.northBearing).toBe(NORTH);
    expect(
      openingFacing(
        layout,
        layout.openings.find((o) => o.kind === 'window')!
      ).compass
    ).toBe('W');
  });
});

describe('several rooms in one session', () => {
  // A hallway and a bedroom with a 15 cm wall between them, and the door between them seen from
  // both rooms.
  const hallway: Point2[] = [
    [4.15, 0],
    [6, 0],
    [6, 3],
    [4.15, 3],
  ];

  function twoRooms(floor = 0) {
    return session(
      [
        {
          category: 'bedroom',
          walls: wallsAround(bedroom, 2.45, NORTH),
          openings: [
            { kind: 'door', center: toWorld([4, 2], 1.03, NORTH), width: 0.8, height: 2.05 },
          ],
        },
        {
          name: 'Hallway',
          walls: wallsAround(hallway, 2.45, NORTH, floor),
          openings: [
            { kind: 'door', center: toWorld([4.15, 2.02], 1.03, NORTH), width: 0.8, height: 2.05 },
            { kind: 'opening', center: toWorld([6, 1.5], 1, NORTH), width: 1, height: 2 },
          ],
        },
      ],
      NORTH
    );
  }

  test('links a door to the room behind it, once', () => {
    const { layout, validation } = imported(importScan(twoRooms()));
    expect(validation.ok).toBe(true);
    expect(layout.rooms.map((room) => room.name)).toEqual(['Bedroom', 'Hallway']);
    const doors = layout.openings.filter((opening) => opening.kind === 'door');
    expect(doors).toHaveLength(1);
    expect(doors[0]).toMatchObject({ wall: { roomId: 'bedroom' }, connects: 'hallway' });
    expect(layout.openings.find((opening) => opening.kind === 'passage')).toMatchObject({
      connects: 'outside',
    });
  });

  test('takes a doorway and a door seen from either side for the same opening', () => {
    // The hallway side didn't see the door leaf, so it reports a doorway.
    const scan = twoRooms();
    scan.rooms[1]!.openings = [
      { kind: 'opening', center: toWorld([4.15, 2.02], 1.03, NORTH), width: 0.78, height: 2.05 },
    ];
    const { layout } = imported(importScan(scan));
    expect(layout.openings.map((opening) => [opening.kind, opening.connects])).toEqual([
      ['door', 'hallway'],
    ]);
  });

  test.each([
    ['a window', 'window', 'window'],
    ['a narrower doorway', 'opening', 'passage'],
  ] as const)('keeps %s just beside a door seen from the other room', (_, kind, expected) => {
    // A 30 cm wide opening seen from the hallway, ending where the bedroom's door begins.
    const scan = twoRooms();
    scan.rooms[1]!.openings = [
      { kind, center: toWorld([4.15, 1.45], 1.03, NORTH), width: 0.3, height: 1 },
    ];
    const { layout } = imported(importScan(scan));
    expect(layout.openings.map((opening) => [opening.kind, opening.connects])).toEqual([
      ['door', 'hallway'],
      [expected, 'bedroom'],
    ]);
  });

  test('puts rooms on different storeys onto separate floors', () => {
    const { layout } = imported(importScan(twoRooms(2.8)));
    expect(layout.floors).toEqual([
      { id: 'floor-0', name: 'Ground floor', level: 0, elevation: 0 },
      { id: 'floor-1', name: 'Floor 1', level: 1, elevation: 2.8 },
    ]);
    expect(layout.rooms.map((room) => room.floorId)).toEqual(['floor-0', 'floor-1']);
    // The bedroom door no longer has a room behind it on its own floor.
    expect(layout.openings.find((opening) => opening.kind === 'door')!.connects).toBe('outside');
  });
});

describe('rooms on several storeys', () => {
  const tapped = (outline: Point2[], floor: number) =>
    outline.map((point) => toWorld(point, floor, 0));
  const beside = (dx: number) => bedroom.map(([x, y]): Point2 => [x + dx, y]);

  test('puts furniture in a room on its own floor', () => {
    // A bedroom directly above the living room, scanned second.
    const result = imported(
      importScan(
        session([
          { name: 'Living room', outline: tapped(bedroom, 0) },
          {
            name: 'Bedroom',
            outline: tapped(bedroom, 2.8),
            objects: [
              { category: 'bed', center: toWorld([2, 1.5], 3.1, 0), size: [1.6, 0.6, 2], yaw: 0 },
            ],
          },
        ])
      )
    );
    expect(result.layout.fixtures.map((fixture) => fixture.roomId)).toEqual(['bedroom']);
  });

  test('starts a new storey once floors rise too far above its lowest', () => {
    // A split level: each floor is a half storey above the last, but the top is a full one up.
    const result = imported(
      importScan(
        session([
          { name: 'Hall', outline: tapped(beside(0), 0) },
          { name: 'Landing', outline: tapped(beside(5), 1.4) },
          { name: 'Bedroom', outline: tapped(beside(10), 2.8) },
        ])
      )
    );
    expect(result.layout.floors.map((floor) => floor.elevation)).toEqual([0, 2.8]);
    expect(result.layout.rooms.map((room) => room.floorId)).toEqual([
      'floor-0',
      'floor-0',
      'floor-1',
    ]);
  });
});

describe('openings with a wall named', () => {
  // A window near the north-west corner whose scanned centre is nearer the north wall.
  const walls = wallsAround(bedroom, 2.4, 0).map((wall, i) => ({ id: `wall-${i}`, ...wall }));
  const window = (wallId: string) => ({
    kind: 'window' as const,
    center: toWorld([0.15, 2.9], 1.5, 0),
    width: 0.2,
    height: 1,
    wallId,
  });

  test('go on that wall', () => {
    // wallsAround runs south, east, north, west, so wall-3 is the west wall.
    const { layout } = imported(
      importScan(session([{ name: 'Study', walls, openings: [window('wall-3')] }], 0))
    );
    expect(openingFacing(layout, layout.openings[0]!).compass).toBe('W');
  });

  test('go on the nearest wall when the name is unknown', () => {
    const { layout, notes } = imported(
      importScan(session([{ name: 'Study', walls, openings: [window('wall-9')] }], 0))
    );
    expect(openingFacing(layout, layout.openings[0]!).compass).toBe('N');
    expect(notes.map((note) => note.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('wall-9')])
    );
  });
});

describe('a guided capture', () => {
  // An L-shaped kitchen captured by tapping corners, including an extra tap halfway along a wall.
  const kitchen: Point2[] = [
    [0, 0],
    [2, 0],
    [5, 0],
    [5, 2],
    [2.5, 2],
    [2.5, 4],
    [0, 4],
  ];

  test('uses the tapped corners, dropping ones on a straight wall', () => {
    const result = imported(
      importScan(
        session([{ name: 'Kitchen', outline: kitchen.map((point) => toWorld(point, 0, 0)) }])
      )
    );
    const room = result.layout.rooms[0]!;
    expectOutline(
      room.outline,
      kitchen.filter((_, i) => i !== 1),
      0.001
    );
    expect(room.ceilingHeight).toBe(2.5);
    expect(result.notes.map((note) => note.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('no wall heights'),
        expect.stringContaining("doesn't say which way is north"),
      ])
    );
    expect(result.validation.ok).toBe(true);
  });
});

test('uses a measured ceiling height', () => {
  const result = imported(
    importScan(
      session([
        {
          name: 'Kitchen',
          ceilingHeight: 2.38,
          outline: bedroom.map((point) => toWorld(point, 0, 0)),
        },
      ])
    )
  );
  expect(result.layout.rooms[0]!.ceilingHeight).toBe(2.38);
  expect(result.notes.map((note) => note.message).join(' ')).not.toContain('no wall heights');
});

describe('imperfect scans', () => {
  test('fits openings at a wall end once they are rounded to centimetres', () => {
    // Half of 0.807 m rounds down while 0.807 m rounds up, and the slanted wall is 3.178 m long.
    const slanted: Point2[] = [
      [0, 0],
      [3, 1.05],
      [3, 4],
      [0, 4],
    ];
    const opening = (center: Point2, width: number) => ({
      kind: 'opening' as const,
      center: toWorld(center, 1, 0),
      width,
      height: 2,
    });
    const result = imported(
      importScan(
        session([
          {
            name: 'Study',
            outline: slanted.map((point) => toWorld(point, 0, 0)),
            openings: [
              opening([3, 1.1], 0.807),
              opening([3, 3.95], 0.807),
              opening([1.5, 0.525], 3.5),
            ],
          },
        ]),
        { alignToWalls: false }
      )
    );
    expect(result.layout.openings).toHaveLength(3);
    expect(result.validation.ok && result.validation.warnings).toEqual([]);
  });

  test('leaves out a stray wall piece that is not part of the outline', () => {
    const walls = wallsAround(bedroom, 2.4, 0);
    // A short freestanding wall in the middle of the room.
    walls.push({ start: toWorld([2, 1], 0, 0), end: toWorld([2, 2], 0, 0), height: 1 });
    const result = imported(importScan(session([{ name: 'Study', walls }])));
    expectOutline(result.layout.rooms[0]!.outline, bedroom);
    expect(result.notes.map((note) => note.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('left out 1 wall piece')])
    );
  });

  test('finds the loop when a stray wall piece starts nearer a corner than the next wall', () => {
    const l: Point2[] = [
      [0, 0],
      [5, 0],
      [5, 2],
      [2.5, 2],
      [2.5, 4],
      [0, 4],
    ];
    const walls = wallsAround(l, 2.4, 0);
    // A short piece standing out from the far corner, starting right at it.
    walls.push({ start: toWorld([5, 0], 0, 0), end: toWorld([4.4, 0.6], 0, 0), height: 1 });
    const result = imported(importScan(session([{ name: 'Kitchen', walls }])));
    expectOutline(result.layout.rooms[0]!.outline, l, 0.05);
    expect(result.notes.map((note) => note.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('left out 1 wall piece')])
    );
  });

  test('leaves out a loop of stray pieces that comes back to a corner', () => {
    const walls = wallsAround(bedroom, 2.4, 0);
    // A triangle of pieces hanging off the north-east corner, which a longer loop could take in
    // on its way round, visiting that corner twice.
    const triangle: Point2[] = [
      [4, 3],
      [4.8, 3.2],
      [4.4, 3.9],
    ];
    triangle.forEach((start, i) => {
      const end = triangle[(i + 1) % triangle.length]!;
      walls.push({ start: toWorld(start, 0, 0), end: toWorld(end, 0, 0), height: 1 });
    });
    const result = imported(importScan(session([{ name: 'Study', walls }])));
    expectOutline(result.layout.rooms[0]!.outline, bedroom);
    expect(result.validation.ok).toBe(true);
    expect(result.notes.map((note) => note.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('left out 3 wall pieces')])
    );
  });

  test('falls back to the shape around walls that do not join up', () => {
    const walls = wallsAround(bedroom, 2.4, 0).slice(0, 3);
    const result = imported(importScan(session([{ name: 'Study', walls }])));
    expect(polygonArea(result.layout.rooms[0]!.outline)).toBeGreaterThan(10);
    expect(result.notes.map((note) => note.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("don't join into a closed loop")])
    );
  });

  test('leaves out openings that are not on a wall, and stairs', () => {
    const result = imported(
      importScan(
        session([
          {
            name: 'Study',
            walls: wallsAround(bedroom, 2.4, 0),
            openings: [{ kind: 'window', center: toWorld([2, 1.5], 1.5, 0), width: 1, height: 1 }],
            objects: [
              { category: 'stairs', center: toWorld([1, 1], 1, 0), size: [1, 2, 3], yaw: 0 },
            ],
          },
        ])
      )
    );
    expect(result.layout.openings).toEqual([]);
    expect(result.layout.fixtures).toEqual([]);
    expect(result.notes).toHaveLength(3);
  });

  test('numbers repeated furniture names', () => {
    const chair = (x: number) => ({
      category: 'chair',
      center: toWorld([x, 1], 0.45, 0),
      size: [0.5, 0.9, 0.5] as [number, number, number],
      yaw: 0,
    });
    const result = imported(
      importScan(
        session([
          { name: 'Study', walls: wallsAround(bedroom, 2.4, 0), objects: [chair(1), chair(2)] },
        ])
      )
    );
    expect(result.layout.fixtures.map((fixture) => [fixture.id, fixture.name])).toEqual([
      ['chair', 'Chair'],
      ['chair-2', 'Chair 2'],
    ]);
  });
});

describe('importScan', () => {
  test('rejects input that is not a scan', () => {
    const result = importScan({
      format: 'spatial-home/room-scan',
      version: 1,
      rooms: [{ walls: [{ start: [0, 0], end: [1, 0, 0], height: 2 }] }],
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors[0]).toContain('rooms.0.walls.0.start');
  });

  test('rejects a room with nothing to build an outline from', () => {
    const result = importScan(session([{ name: 'Empty', walls: [] }]));
    expect(result).toEqual({
      ok: false,
      errors: ['Room 1 has neither an outline nor at least three walls.'],
    });
  });

  test('names the home when asked', () => {
    const { layout } = imported(importScan(roomPlanBedroom(), { name: 'Flat' }));
    expect((layout as HomeLayout).name).toBe('Flat');
  });
});
