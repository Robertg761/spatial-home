import {
  openingCenter,
  roomWalls,
  validateLayout,
  type HomeLayout,
  type Point2,
} from '@spatial-home/home-model';
import { expect, test } from 'vitest';
import { importScan } from '../src/import.ts';
import { ScanSessionSchema, type ScanSessionInput, type Vector3 } from '../src/scan.ts';
import { session, toWorld, wallsAround } from './fixtures.ts';

// Imports a few hundred made-up scans, untidy in the ways real ones are, and checks the promise
// that matters most: a scan the importer accepts becomes a layout with no errors. It also checks
// that no room keeps a wall too short to hold anything, which an opening could otherwise land on,
// and that the same scan listed in another order gives the same home.

/** A small seeded random number generator (mulberry32), so every run sees the same scans. */
function generator(seed: number) {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const between = (min: number, max: number) => min + (max - min) * next();
  const pick = <T>(options: readonly T[]): T => options[Math.floor(next() * options.length)]!;
  const chance = (p: number) => next() < p;
  return { next, between, pick, chance };
}

type Random = ReturnType<typeof generator>;

const LONG = 'Long name '.repeat(30);
const names = ['Bedroom', '   ', LONG, '🛋️'.repeat(120), 'Kitchen / diner'];
const categories = [
  'bed',
  'sofa',
  'table',
  'storage',
  'stairs',
  'television',
  LONG,
  ' ',
  'ÉtagèreHaute',
];

/** A length that is usually ordinary but sometimes tiny or huge. */
function length(random: Random, ordinary: [number, number]) {
  return random.pick([
    () => random.between(...ordinary),
    () => random.between(...ordinary),
    () => random.between(...ordinary),
    () => random.between(0.0001, 0.006),
    () => random.between(5, 40),
  ])();
}

function shape(random: Random): Point2[] {
  const [x, y] = [random.between(-20, 20), random.between(-20, 20)];
  const [w, h] = [random.between(0.3, 9), random.between(0.3, 9)];
  return random.pick<() => Point2[]>([
    () => [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ],
    () => [
      [x, y],
      [x + w, y],
      [x + w, y + h / 2],
      [x + w / 2, y + h / 2],
      [x + w / 2, y + h],
      [x, y + h],
    ],
    () => {
      // A star-shaped polygon: corners at increasing angles around a centre.
      const count = 3 + Math.floor(random.next() * 7);
      return Array.from({ length: count }, (_, i): Point2 => {
        const angle = ((i + random.between(0, 0.8)) / count) * 2 * Math.PI;
        const radius = random.between(0.2, 5);
        return [x + radius * Math.cos(angle), y + radius * Math.sin(angle)];
      });
    },
    (): Point2[] => [
      // A sliver, with two corners a few centimetres apart.
      [x, y],
      [x + random.between(-0.04, 0.04), y + random.between(-0.04, 0.04)],
      [x + w, y + h],
    ],
    (): Point2[] => [
      // A triangle, which tidying can't take a corner off.
      [x, y],
      [x + w, y + random.between(-h, h)],
      [x + random.between(-w, w), y + h],
    ],
    () =>
      // Corners tapped in any order, which may cross.
      Array.from({ length: 3 + Math.floor(random.next() * 5) }, (): Point2 => [
        x + random.between(0, w),
        y + random.between(0, h),
      ]),
  ])();
}

/** Adds runs of corners a few centimetres apart, as a shaky tap or a sliver of wall gives. */
function withNearCorners(random: Random, corners: Point2[]): Point2[] {
  const result = [...corners];
  for (let runs = random.chance(0.5) ? 1 + Math.floor(random.next() * 3) : 0; runs > 0; runs--) {
    const i = Math.floor(random.next() * result.length);
    const run: Point2[] = [];
    let [x, y] = result[i]!;
    for (let n = 1 + Math.floor(random.next() * 3); n > 0; n--) {
      [x, y] = [x + random.between(-0.03, 0.03), y + random.between(-0.03, 0.03)];
      run.push([x, y]);
    }
    result.splice(i + 1, 0, ...run);
  }
  return result;
}

function room(random: Random, north: number, floor: number) {
  const corners = withNearCorners(random, shape(random));
  const at = (point: Point2, height: number): Vector3 => toWorld(point, floor + height, north);
  const guided = random.chance(0.3);
  const walls = guided
    ? random.chance(0.3)
      ? wallsAround(corners, length(random, [2, 3]), north, floor)
      : []
    : wallsAround(corners, length(random, [2, 3]), north, floor, random.between(0, 0.25));
  if (!guided) {
    // Walls the scanner reports in any order, some missing, some extra.
    while (walls.length > 0 && random.chance(0.25)) {
      walls.splice(Math.floor(random.next() * walls.length), 1);
    }
    if (random.chance(0.3)) walls.reverse();
    for (let i = 0; random.chance(0.4) && i < 4; i++) {
      const start = random.pick(corners);
      const end: Point2 = random.chance(0.3)
        ? start
        : [start[0] + random.between(-1, 1), start[1] + random.between(-1, 1)];
      walls.push({ start: at(start, 0), end: at(end, 0), height: length(random, [0.5, 3]) });
    }
    for (let i = 0; random.chance(0.2) && i < 4; i++) {
      // A wall record with no length, anywhere.
      const point = at([random.between(-30, 30), random.between(-30, 30)], 0);
      walls.push({ start: point, end: point, height: length(random, [0.5, 3]) });
    }
  }
  const withIds = walls.map((wall, i) => (random.chance(0.5) ? { id: `w${i}`, ...wall } : wall));
  const onAWall = (): Point2 => {
    const edges = corners.map((corner, i) => [corner, corners[(i + 1) % corners.length]!] as const);
    // Sometimes the shortest wall, which tidying the outline may have shrunk further.
    const [a, b] = random.chance(0.3)
      ? edges.reduce((best, edge) =>
          Math.hypot(edge[1][0] - edge[0][0], edge[1][1] - edge[0][1]) <
          Math.hypot(best[1][0] - best[0][0], best[1][1] - best[0][1])
            ? edge
            : best
        )
      : random.pick(edges);
    const t = random.between(-0.1, 1.1);
    if (random.chance(0.3)) {
      // Right on the wall, however short it is.
      const u = random.between(0, 1);
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    }
    return [
      a[0] + (b[0] - a[0]) * t + random.between(-0.2, 0.2),
      a[1] + (b[1] - a[1]) * t + random.between(-0.2, 0.2),
    ];
  };
  const openings = Array.from({ length: Math.floor(random.next() * 5) }, () => {
    const kind = random.pick(['door', 'window', 'opening'] as const);
    const height = length(random, [0.5, 2.2]);
    return {
      kind,
      center: at(onAWall(), random.between(-0.5, 3)),
      width: length(random, [0.3, 2]),
      height,
      ...(random.chance(0.3) ? { wallId: random.pick(['w0', 'w1', 'w2', 'nope']) } : {}),
    };
  });
  const objects = Array.from({ length: Math.floor(random.next() * 4) }, () => ({
    category: random.pick(categories),
    center: at(random.chance(0.8) ? random.pick(corners) : onAWall(), 0.5),
    size: [length(random, [0.3, 2]), length(random, [0.3, 2]), length(random, [0.3, 2])] as [
      number,
      number,
      number,
    ],
    yaw: random.between(-10, 10),
  }));
  return {
    ...(random.chance(0.6) ? { name: random.pick(names) } : {}),
    ...(random.chance(0.4) ? { category: random.pick(['bedroom', 'kitchen', ' ', LONG]) } : {}),
    ...(guided || random.chance(0.2) ? { outline: corners.map((point) => at(point, 0)) } : {}),
    ...(random.chance(0.3) ? { ceilingHeight: length(random, [2.2, 3]) } : {}),
    walls: withIds,
    openings,
    objects,
  };
}

/**
 * Two rooms of the same name with no gap between them, each seeing the opening between them at
 * exactly the same place, as tapped corners on a shared wall can give. One of them may see a few
 * there, one above the other.
 */
function twins(random: Random, north: number, floor: number) {
  const [x, y] = [random.between(-20, 20), random.between(-20, 20)];
  const [w, v, h] = [random.between(1, 6), random.between(1, 6), random.between(1.5, 6)];
  const kind = random.pick(['door', 'window', 'opening'] as const);
  const along = random.between(0.6, h - 0.6);
  const sighting = (seen: 'door' | 'window' | 'opening') => ({
    kind: seen,
    center: toWorld([x + w, y + along], floor + 1 + random.pick([0, 0, 0.1, -0.1, 0.15]), north),
    width: random.between(0.8, 0.9),
    height: random.pick([1, 1.1]),
  });
  const name = random.pick(names);
  const twin = (corners: Point2[], seen: 'door' | 'window' | 'opening') => ({
    name,
    outline: corners.map((point) => toWorld(point, floor, north)),
    openings: Array.from(
      { length: random.chance(0.5) ? 1 : 2 + Math.floor(random.next() * 2) },
      () => sighting(seen)
    ),
  });
  const other = kind === 'window' ? 'window' : random.pick(['door', 'opening'] as const);
  return [
    twin(
      [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ],
      kind
    ),
    twin(
      [
        [x + w, y],
        [x + w + v, y],
        [x + w + v, y + h],
        [x + w, y + h],
      ],
      other
    ),
  ];
}

function scan(random: Random): ScanSessionInput {
  const north = random.between(0, 359.9);
  const storeys = random.pick([[0], [0], [0, 2.8], [0, 0.02, 1.4, 2.8], [-2.6, 0, 3.1]]);
  const rooms: ScanSessionInput['rooms'] = Array.from(
    { length: 1 + Math.floor(random.next() * 4) },
    () => room(random, north, random.pick(storeys) + random.between(-0.03, 0.03))
  );
  if (random.chance(0.2)) rooms.push(...twins(random, north, random.pick(storeys)));
  return session(rooms, random.chance(0.7) ? north : undefined);
}

/** The same scan with its rooms, and each room's walls, openings and furniture, in another order. */
function shuffled(input: ScanSessionInput, random: Random): ScanSessionInput {
  const shuffle = <T>(list: readonly T[] = []): T[] => {
    const result = [...list];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(random.next() * (i + 1));
      [result[i], result[j]] = [result[j]!, result[i]!];
    }
    return result;
  };
  const rooms = input.rooms.map((room) => ({
    ...room,
    walls: shuffle(room.walls),
    openings: shuffle(room.openings),
    objects: shuffle(room.objects),
  }));
  return { ...input, rooms: shuffle(rooms) };
}

/**
 * What a layout says about the home, leaving out what only reflects the order of the scan: ids,
 * the numbers in default names such as "Room 2" and "Chair 2", the order of lists, and which
 * corner each outline starts from.
 */
function summary(layout: HomeLayout) {
  const canonical = (outline: Point2[]) =>
    [outline, [...outline].reverse()]
      .flatMap((list) =>
        list.map((_, i) => JSON.stringify([...list.slice(i), ...list.slice(0, i)]))
      )
      .sort()[0];
  const elevation = new Map(layout.floors.map((floor) => [floor.id, floor.elevation]));
  const rooms = new Map(layout.rooms.map((room) => [room.id, room]));
  const key = new Map(
    layout.rooms.map((room) => [
      room.id,
      `${elevation.get(room.floorId)} ${canonical(room.outline)}`,
    ])
  );
  key.set('outside', 'outside');
  return {
    floors: layout.floors,
    north: layout.site.northBearing,
    rooms: layout.rooms
      .map(
        (room) =>
          `${room.name.replace(/^Room \d+$/, 'Room')} ${key.get(room.id)} ${room.ceilingHeight}`
      )
      .sort(),
    openings: layout.openings
      .map((opening) => {
        const [x, y] = openingCenter(rooms.get(opening.wall.roomId)!, opening);
        const sill = opening.kind === 'window' ? opening.sillHeight : 0;
        return `${key.get(opening.wall.roomId)} to ${key.get(opening.connects)}: ${opening.kind} at ${x.toFixed(3)} ${y.toFixed(3)}, ${opening.width} x ${opening.height} from ${sill}`;
      })
      .sort(),
    fixtures: layout.fixtures
      .map(
        (fixture) =>
          `${key.get(fixture.roomId)}: ${fixture.kind} at ${fixture.position}, ${Object.values(fixture.size)} turned ${fixture.rotation}`
      )
      .sort(),
  };
}

// FUZZ_SCANS=20000 npm test tries more of them, and FUZZ_FROM=5397 starts from another seed.
const SCANS = Number(process.env.FUZZ_SCANS ?? 300);
const FROM = Number(process.env.FUZZ_FROM ?? 1);

test('every scan it accepts becomes a layout without errors', { timeout: 5000 + SCANS * 5 }, () => {
  const failures: string[] = [];
  let accepted = 0;
  for (let seed = FROM; seed < FROM + SCANS; seed++) {
    const random = generator(seed);
    const input = scan(random);
    expect(ScanSessionSchema.safeParse(input).success).toBe(true);
    const options = {
      alignToWalls: random.chance(0.8),
      ...(random.chance(0.2) ? { name: random.pick(names) } : {}),
    };
    const result = importScan(input, options);
    const reordered = importScan(shuffled(input, generator(-seed)), options);
    if (reordered.ok !== result.ok) failures.push(`seed ${seed}: accepted in one order only`);
    if (result.ok && reordered.ok) {
      const [one, other] = [summary(result.layout), summary(reordered.layout)];
      const differ = (Object.keys(one) as (keyof typeof one)[]).filter(
        (part) => JSON.stringify(one[part]) !== JSON.stringify(other[part])
      );
      if (differ.length > 0) failures.push(`seed ${seed}: ${differ.join(', ')} depend on order`);
    }
    if (!result.ok) continue;
    accepted++;
    const validation = validateLayout(result.layout);
    if (!validation.ok) {
      failures.push(`seed ${seed}: ${validation.errors.map((issue) => issue.code).join(', ')}`);
    }
    const short = result.layout.rooms.flatMap(roomWalls).filter((wall) => wall.length <= 0.02);
    if (short.length > 0) failures.push(`seed ${seed}: ${short.length} walls of 2 cm or less`);
  }
  expect(failures).toEqual([]);
  expect(accepted).toBeGreaterThan(SCANS * 0.75);
});
