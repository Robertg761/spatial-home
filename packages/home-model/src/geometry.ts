import { OUTSIDE, type HomeLayout, type Opening, type Point2, type Room } from './schema.ts';

/** Lengths below this many metres count as zero, absorbing floating-point error. */
export const EPSILON = 1e-6;

/**
 * The thickest wall looked across, in metres. A scanned room's walls are its inner surfaces, so the
 * room next door starts up to a wall's thickness away.
 */
export const MAX_WALL_THICKNESS = 0.45;

/** Area of a polygon; positive when its corners run anticlockwise on the plan. */
export function signedArea(outline: readonly Point2[]): number {
  let twiceArea = 0;
  for (let i = 0; i < outline.length; i++) {
    const [x1, y1] = outline[i]!;
    const [x2, y2] = outline[(i + 1) % outline.length]!;
    twiceArea += x1 * y2 - x2 * y1;
  }
  return twiceArea / 2;
}

export function polygonArea(outline: readonly Point2[]): number {
  return Math.abs(signedArea(outline));
}

/** The centre of mass of a polygon, which is inside it whenever the room is convex. */
export function polygonCentroid(outline: readonly Point2[]): Point2 {
  const area = signedArea(outline);
  if (Math.abs(area) < EPSILON) {
    const sum = outline.reduce<Point2>(([sx, sy], [x, y]) => [sx + x, sy + y], [0, 0]);
    return [sum[0] / outline.length, sum[1] / outline.length];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < outline.length; i++) {
    const [x1, y1] = outline[i]!;
    const [x2, y2] = outline[(i + 1) % outline.length]!;
    const cross = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  return [cx / (6 * area), cy / (6 * area)];
}

/** Whether a point is inside a polygon. Points exactly on an edge count as inside. */
export function pointInPolygon(point: Point2, outline: readonly Point2[]): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [xi, yi] = outline[i]!;
    const [xj, yj] = outline[j]!;
    if (distanceToSegment(point, [xi, yi], [xj, yj]) < EPSILON) return true;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Whether a polygon's edges meet only at shared corners: no crossings, overlaps or zero-length walls. */
export function isSimplePolygon(outline: readonly Point2[]): boolean {
  const n = outline.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    if (distance(outline[i]!, outline[(i + 1) % n]!) < EPSILON) return false;
  }
  for (let i = 0; i < n; i++) {
    const a1 = outline[i]!;
    const a2 = outline[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      const b1 = outline[j]!;
      const b2 = outline[(j + 1) % n]!;
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (adjacent) {
        // Neighbouring walls share a corner; they may only touch there, not fold back over each other.
        const shared = j === i + 1 ? a2 : a1;
        const otherA = j === i + 1 ? a1 : a2;
        const otherB = j === i + 1 ? b2 : b1;
        if (
          distanceToSegment(otherA, shared, otherB) < EPSILON ||
          distanceToSegment(otherB, shared, otherA) < EPSILON
        ) {
          return false;
        }
      } else if (segmentsTouch(a1, a2, b1, b2)) {
        return false;
      }
    }
  }
  return true;
}

export interface Wall {
  index: number;
  start: Point2;
  end: Point2;
  length: number;
}

/** A room's walls in order: wall i runs from corner i to the next corner. */
export function roomWalls(room: Pick<Room, 'outline'>): Wall[] {
  const { outline } = room;
  return outline.map((start, index) => {
    const end = outline[(index + 1) % outline.length]!;
    return { index, start, end, length: distance(start, end) };
  });
}

/**
 * Unit vector pointing out of the room from a wall. Outlines may run either way round, so the
 * winding decides which side is outside.
 */
export function wallOutwardNormal(room: Pick<Room, 'outline'>, wallIndex: number): Point2 {
  const wall = roomWalls(room)[wallIndex];
  if (!wall) throw new RangeError(`Room has no wall ${wallIndex}`);
  const dx = (wall.end[0] - wall.start[0]) / wall.length;
  const dy = (wall.end[1] - wall.start[1]) / wall.length;
  // Adding 0 turns -0 into 0.
  return signedArea(room.outline) > 0 ? [dy + 0, -dx + 0] : [-dy + 0, dx + 0];
}

/** The plan position of an opening's centre. */
export function openingCenter(
  room: Pick<Room, 'outline'>,
  opening: Pick<Opening, 'wall' | 'offset'>
): Point2 {
  const wall = roomWalls(room)[opening.wall.index];
  if (!wall) throw new RangeError(`Room has no wall ${opening.wall.index}`);
  const t = wall.length === 0 ? 0 : opening.offset / wall.length;
  return [
    wall.start[0] + (wall.end[0] - wall.start[0]) * t,
    wall.start[1] + (wall.end[1] - wall.start[1]) * t,
  ];
}

/** The plan heading of a direction on the plan: 0 towards the top of the plan, 90 to its right. */
export function planHeading([dx, dy]: Point2): number {
  return normalizeDegrees((Math.atan2(dx, dy) * 180) / Math.PI);
}

/** Converts a plan heading to a compass bearing using the site's north. */
export function compassBearing(
  layout: Pick<HomeLayout, 'site'>,
  planHeadingDegrees: number
): number {
  return normalizeDegrees(planHeadingDegrees + layout.site.northBearing);
}

const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type CompassPoint = (typeof COMPASS_POINTS)[number];

/** The nearest of the eight compass points to a bearing. */
export function compassPoint(bearing: number): CompassPoint {
  return COMPASS_POINTS[Math.round(normalizeDegrees(bearing) / 45) % 8]!;
}

export interface Facing {
  /** Compass bearing, in degrees clockwise from north. */
  bearing: number;
  compass: CompassPoint;
}

/**
 * Which way an opening faces, looking out of the room whose wall it sits in. For a window to the
 * outside, that's the direction the sun has to be in to shine through it.
 */
export function openingFacing(layout: HomeLayout, opening: Opening): Facing {
  const room = layout.rooms.find((candidate) => candidate.id === opening.wall.roomId);
  if (!room)
    throw new RangeError(`Opening ${opening.id} is in an unknown room ${opening.wall.roomId}`);
  const bearing = compassBearing(layout, planHeading(wallOutwardNormal(room, opening.wall.index)));
  return { bearing, compass: compassPoint(bearing) };
}

/**
 * What is on the other side of a room's wall at a point along it: another room on the same floor,
 * or "outside". It looks a little way past the wall, then further, up to `maxThickness` metres,
 * because a scanned room's walls are its inner surfaces, so the room next door starts a wall's
 * thickness away.
 */
export function roomBehindWall(
  layout: Pick<HomeLayout, 'rooms'>,
  roomId: string,
  wallIndex: number,
  offset: number,
  maxThickness = MAX_WALL_THICKNESS
): string {
  const room = layout.rooms.find((candidate) => candidate.id === roomId);
  const wall = room ? roomWalls(room)[wallIndex] : undefined;
  if (!room || !wall || wall.length === 0) return OUTSIDE;
  const t = offset / wall.length;
  const [nx, ny] = wallOutwardNormal(room, wallIndex);
  const [px, py] = [
    wall.start[0] + (wall.end[0] - wall.start[0]) * t,
    wall.start[1] + (wall.end[1] - wall.start[1]) * t,
  ];
  const neighbours = layout.rooms.filter(
    (other) => other.id !== room.id && other.floorId === room.floorId
  );
  // Every 10 cm from 5 cm out, and at `maxThickness` itself, so a wall that thick is seen across.
  const depths: number[] = [];
  for (let depth = 0.05; depth < maxThickness - EPSILON; depth += 0.1) depths.push(depth);
  depths.push(maxThickness);
  for (const depth of depths) {
    const probe: Point2 = [px + nx * depth, py + ny * depth];
    const found = neighbours.find((other) => pointInPolygon(probe, other.outline));
    if (found) return found.id;
  }
  return OUTSIDE;
}

export interface Connection {
  /** The room on the other side, or "outside". */
  to: string;
  openingId: string;
  kind: Opening['kind'];
}

/** For each room, the rooms (and outside) its doors, windows and passages lead to, in both directions. */
export function roomConnections(layout: HomeLayout): Map<string, Connection[]> {
  const connections = new Map<string, Connection[]>(layout.rooms.map((room) => [room.id, []]));
  const add = (from: string, connection: Connection) => {
    if (!connections.has(from)) connections.set(from, []);
    connections.get(from)!.push(connection);
  };
  for (const opening of layout.openings) {
    const { roomId } = opening.wall;
    add(roomId, { to: opening.connects, openingId: opening.id, kind: opening.kind });
    add(opening.connects, { to: roomId, openingId: opening.id, kind: opening.kind });
  }
  return connections;
}

export function distance([x1, y1]: Point2, [x2, y2]: Point2): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

function normalizeDegrees(degrees: number): number {
  const normalized = ((degrees % 360) + 360) % 360;
  // Rounding keeps 359.9999999 from reading as a different direction than 0.
  return Math.abs(normalized - 360) < 1e-9 ? 0 : normalized;
}

function distanceToSegment(point: Point2, a: Point2, b: Point2): number {
  const [px, py] = point;
  const [ax, ay] = a;
  const [bx, by] = b;
  const lengthSquared = (bx - ax) ** 2 + (by - ay) ** 2;
  if (lengthSquared === 0) return distance(point, a);
  const t = Math.max(
    0,
    Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / lengthSquared)
  );
  return distance(point, [ax + t * (bx - ax), ay + t * (by - ay)]);
}

function cross(o: Point2, a: Point2, b: Point2): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Whether two segments cross or touch, including touching end to end or overlapping. */
function segmentsTouch(a1: Point2, a2: Point2, b1: Point2, b2: Point2): boolean {
  // Signed distances, in metres, of each segment's ends from the other segment's line. A cross
  // product is in square metres, so comparing it with a tolerance in metres would let walls that
  // cross at a shallow angle slip through.
  const lengthA = distance(a1, a2);
  const lengthB = distance(b1, b2);
  if (lengthA === 0 || lengthB === 0) return false;
  const d1 = cross(b1, b2, a1) / lengthB;
  const d2 = cross(b1, b2, a2) / lengthB;
  const d3 = cross(a1, a2, b1) / lengthA;
  const d4 = cross(a1, a2, b2) / lengthA;
  if (
    ((d1 > EPSILON && d2 < -EPSILON) || (d1 < -EPSILON && d2 > EPSILON)) &&
    ((d3 > EPSILON && d4 < -EPSILON) || (d3 < -EPSILON && d4 > EPSILON))
  ) {
    return true;
  }
  return (
    distanceToSegment(a1, b1, b2) < EPSILON ||
    distanceToSegment(a2, b1, b2) < EPSILON ||
    distanceToSegment(b1, a1, a2) < EPSILON ||
    distanceToSegment(b2, a1, a2) < EPSILON
  );
}
