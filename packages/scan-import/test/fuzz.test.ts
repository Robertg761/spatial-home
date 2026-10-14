import { validateLayout, type Point2 } from '@spatial-home/home-model';
import { expect, test } from 'vitest';
import { importScan } from '../src/import.ts';
import { ScanSessionSchema, type ScanSessionInput, type Vector3 } from '../src/scan.ts';
import { session, toWorld, wallsAround } from './fixtures.ts';

// Imports a few hundred made-up scans, untidy in the ways real ones are, and checks the promise
// that matters most: a scan the importer accepts becomes a layout with no errors.

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
    () =>
      // Corners tapped in any order, which may cross.
      Array.from({ length: 3 + Math.floor(random.next() * 5) }, (): Point2 => [
        x + random.between(0, w),
        y + random.between(0, h),
      ]),
  ])();
}

function room(random: Random, north: number, floor: number) {
  const corners = shape(random);
  const at = (point: Point2, height: number): Vector3 => toWorld(point, floor + height, north);
  const guided = random.chance(0.3);
  const walls = guided
    ? random.chance(0.3)
      ? wallsAround(corners, length(random, [2, 3]), north, floor)
      : []
    : wallsAround(corners, length(random, [2, 3]), north, floor, random.between(0, 0.25));
  if (!guided) {
    // Walls the scanner reports in any order, some missing, some extra.
    if (random.chance(0.2)) walls.splice(Math.floor(random.next() * walls.length), 1);
    if (random.chance(0.3)) walls.reverse();
    for (let i = 0; random.chance(0.4) && i < 4; i++) {
      const start = random.pick(corners);
      const end: Point2 = random.chance(0.3)
        ? start
        : [start[0] + random.between(-1, 1), start[1] + random.between(-1, 1)];
      walls.push({ start: at(start, 0), end: at(end, 0), height: length(random, [0.5, 3]) });
    }
  }
  const withIds = walls.map((wall, i) => (random.chance(0.5) ? { id: `w${i}`, ...wall } : wall));
  const onAWall = (): Point2 => {
    const i = Math.floor(random.next() * corners.length);
    const [a, b] = [corners[i]!, corners[(i + 1) % corners.length]!];
    const t = random.between(-0.1, 1.1);
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

function scan(random: Random): ScanSessionInput {
  const north = random.between(0, 359.9);
  const storeys = random.pick([[0], [0], [0, 2.8], [0, 0.02, 1.4, 2.8], [-2.6, 0, 3.1]]);
  const rooms = Array.from({ length: 1 + Math.floor(random.next() * 4) }, () =>
    room(random, north, random.pick(storeys) + random.between(-0.03, 0.03))
  );
  return session(rooms, random.chance(0.7) ? north : undefined);
}

// FUZZ_SCANS=20000 npm test tries more of them.
const SCANS = Number(process.env.FUZZ_SCANS ?? 400);

test('every scan it accepts becomes a layout without errors', { timeout: 5000 + SCANS * 5 }, () => {
  const failures: string[] = [];
  let accepted = 0;
  for (let seed = 1; seed <= SCANS; seed++) {
    const random = generator(seed);
    const input = scan(random);
    expect(ScanSessionSchema.safeParse(input).success).toBe(true);
    const result = importScan(input, {
      alignToWalls: random.chance(0.8),
      ...(random.chance(0.2) ? { name: random.pick(names) } : {}),
    });
    if (!result.ok) continue;
    accepted++;
    const validation = validateLayout(result.layout);
    if (!validation.ok) {
      failures.push(`seed ${seed}: ${validation.errors.map((issue) => issue.code).join(', ')}`);
    }
  }
  expect(failures).toEqual([]);
  expect(accepted).toBeGreaterThan(SCANS * 0.75);
});
