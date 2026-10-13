import {
  LAYOUT_FORMAT,
  LAYOUT_VERSION,
  isSimplePolygon,
  pointInPolygon,
  polygonArea,
  roomBehindWall,
  roomWalls,
  validateLayout,
  type Fixture,
  type Floor,
  type HomeLayout,
  type Opening,
  type Point2,
  type Room,
  type ValidationResult,
} from '@spatial-home/home-model';
import { ScanSessionSchema, type RoomScan, type ScanSession, type Vector3 } from './scan.ts';

export interface ImportOptions {
  /** Turn the plan so the walls run along its axes, as a hand-drawn plan would. Default true. */
  alignToWalls?: boolean;
  /** How far apart, in metres, two wall ends can be and still count as meeting. Default 0.3. */
  joinTolerance?: number;
  /** A name for the home. */
  name?: string;
}

export interface ImportNote {
  severity: 'warning' | 'info';
  message: string;
  /** The scanned room it is about, by its position in the scan. */
  room?: number;
}

export type ImportResult =
  | {
      ok: true;
      layout: HomeLayout;
      /** What the importer had to guess, tidy or leave out. */
      notes: ImportNote[];
      /** The layout's own checks, for the editor to show. */
      validation: ValidationResult;
    }
  | { ok: false; errors: string[] };

const DEFAULT_CEILING_HEIGHT = 2.5;
/** Rooms whose floors differ by more than this many metres are on different storeys. */
const STOREY_GAP = 1.5;
const OPENING_REACH = 0.4;

/** Turns a phone scan into a home layout. */
export function importScan(input: unknown, options: ImportOptions = {}): ImportResult {
  const parsed = ScanSessionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'scan'}: ${issue.message}`
      ),
    };
  }
  return buildLayout(parsed.data, options);
}

interface PlanRoom {
  index: number;
  scan: RoomScan;
  floorHeight: number;
  outline: Point2[];
}

function buildLayout(session: ScanSession, options: ImportOptions): ImportResult {
  const notes: ImportNote[] = [];
  const tolerance = options.joinTolerance ?? 0.3;

  // 1. Each room's footprint on the plan, still in the session's orientation.
  const planned: PlanRoom[] = [];
  const errors: string[] = [];
  session.rooms.forEach((scan, index) => {
    const floorHeight = median(
      scan.outline?.map(([, y]) => y) ?? scan.walls.flatMap((wall) => [wall.start[1], wall.end[1]])
    );
    let outline: Point2[] | null;
    if (scan.outline) {
      outline = scan.outline.map(toPlan);
    } else if (scan.walls.length >= 3) {
      outline = outlineFromWalls(scan, tolerance, (message) =>
        notes.push({ severity: 'warning', message, room: index })
      );
    } else {
      outline = null;
    }
    if (!outline) {
      errors.push(`Room ${index + 1} has neither an outline nor at least three walls.`);
      return;
    }
    planned.push({ index, scan, floorHeight: floorHeight ?? 0, outline });
  });
  if (errors.length > 0) return { ok: false, errors };

  // 2. Square the plan up to its walls and move it next to the origin.
  const angle =
    options.alignToWalls === false ? 0 : dominantWallAngle(planned.map((room) => room.outline));
  const rotate = rotation(-angle);
  const rotated = planned.map((room) => room.outline.map(rotate));
  const allPoints = rotated.flat();
  const minX = Math.min(...allPoints.map(([x]) => x));
  const minY = Math.min(...allPoints.map(([, y]) => y));
  const place = (point: Point2): Point2 => {
    const [x, y] = rotate(point);
    return [round(x - minX), round(y - minY)];
  };

  // 3. Storeys, from the rooms' floor heights.
  const floors = groupStoreys(planned.map((room) => room.floorHeight));

  // 4. Rooms.
  const rooms: Room[] = [];
  const usedIds = new Set<string>(['outside', ...floors.list.map((floor) => floor.id)]);
  const roomIdByIndex = new Map<number, string>();
  for (const room of planned) {
    const outline = tidyOutline(room.outline.map(place));
    const name =
      room.scan.name ??
      (room.scan.category ? capitalize(room.scan.category) : `Room ${room.index + 1}`);
    const id = claimId(usedIds, slug(name) || 'room');
    const heights = room.scan.walls.map((wall) => wall.height);
    const ceilingHeight =
      room.scan.ceilingHeight ??
      (heights.length > 0 ? Math.max(...heights) : DEFAULT_CEILING_HEIGHT);
    if (room.scan.ceilingHeight === undefined && heights.length === 0) {
      notes.push({
        severity: 'info',
        message: `${name}: the scan has no wall heights, so the ceiling is set to ${DEFAULT_CEILING_HEIGHT} m.`,
        room: room.index,
      });
    }
    if (!isSimplePolygon(outline) || polygonArea(outline) < 0.1) {
      notes.push({
        severity: 'warning',
        message: `${name}: the scanned outline crosses itself or has no area; redraw it in the editor.`,
        room: room.index,
      });
    }
    roomIdByIndex.set(room.index, id);
    rooms.push({
      id,
      name,
      floorId: floors.idFor(room.floorHeight),
      outline,
      ceilingHeight: round(ceilingHeight),
    });
  }

  // 5. Openings, each on the wall the scanner says it is in, or else the nearest wall of its room.
  const openings: Opening[] = [];
  for (const room of planned) {
    const roomId = roomIdByIndex.get(room.index)!;
    const target = rooms.find((candidate) => candidate.id === roomId)!;
    room.scan.openings.forEach((scanned, openingIndex) => {
      const center = place(toPlan(scanned.center));
      // A named scanned wall is found in the outline by its middle, which is on no other wall.
      const named =
        scanned.wallId === undefined
          ? undefined
          : room.scan.walls.find((wall) => wall.id === scanned.wallId);
      const along =
        named &&
        nearestWallOf(target, midpoint(place(toPlan(named.start)), place(toPlan(named.end))));
      const onNamed = along && along.distance <= OPENING_REACH ? along : undefined;
      if (scanned.wallId !== undefined && !onNamed) {
        notes.push({
          severity: 'info',
          message: `${target.name}: a ${scanned.kind} is in wall "${scanned.wallId}", which isn't one of the room's walls, so it goes on the nearest wall.`,
          room: room.index,
        });
      }
      const hit = nearestWallOf(target, center, onNamed?.index);
      if (!hit || hit.distance > OPENING_REACH) {
        notes.push({
          severity: 'warning',
          message: `${target.name}: left out a ${scanned.kind} that isn't on any of the room's walls.`,
          room: room.index,
        });
        return;
      }
      const width = Math.min(scanned.width, hit.length);
      const offset = round(clamp(hit.offset, width / 2, hit.length - width / 2));
      const bottom = scanned.center[1] - scanned.height / 2 - room.floorHeight;
      const base = {
        id: claimId(
          usedIds,
          `${roomId}-${scanned.kind === 'opening' ? 'passage' : scanned.kind}-${openingIndex + 1}`
        ),
        wall: { roomId, index: hit.index },
        offset,
        width: round(width),
        height: round(scanned.height),
        connects: 'outside',
      };
      openings.push(
        scanned.kind === 'window'
          ? { kind: 'window', ...base, sillHeight: round(Math.max(0, bottom)) }
          : { kind: scanned.kind === 'door' ? 'door' : 'passage', ...base }
      );
    });
  }

  // 6. What each opening leads to, now that every room is in place. A door between two scanned
  //    rooms is seen from both sides, so the second sighting is dropped.
  const draft = { rooms };
  const kept: Opening[] = [];
  for (const opening of openings) {
    const connects = roomBehindWall(draft, opening.wall.roomId, opening.wall.index, opening.offset);
    const center = openingCenterOf(rooms, opening);
    const duplicate = kept.some(
      (other) =>
        other.connects === opening.wall.roomId &&
        other.wall.roomId === connects &&
        distance(openingCenterOf(rooms, other), center) < 0.6
    );
    if (duplicate) continue;
    kept.push({ ...opening, connects });
  }
  const interiorGuesses = kept.filter(
    (opening) => opening.kind !== 'window' && opening.connects === 'outside'
  ).length;
  if (interiorGuesses > 0 && planned.length > 0) {
    notes.push({
      severity: 'info',
      message: `${interiorGuesses} ${interiorGuesses === 1 ? 'door leads' : 'doors lead'} outside because no scanned room is behind ${interiorGuesses === 1 ? 'it' : 'them'}. Scan the next room in the same session, or change where it leads in the editor.`,
    });
  }

  // 7. Furniture, in whichever room on its floor its centre is in.
  const fixtures: Fixture[] = [];
  const fixtureNames = new Map<string, number>();
  for (const room of planned) {
    const floorId = floors.idFor(room.floorHeight);
    for (const object of room.scan.objects) {
      const kind = slug(object.category).slice(0, 50) || 'object';
      if (kind === 'stairs') {
        notes.push({
          severity: 'info',
          message: 'Left out stairs; they are not part of the layout yet.',
          room: room.index,
        });
        continue;
      }
      const position = place(toPlan(object.center));
      const home =
        rooms.find(
          (candidate) =>
            candidate.floorId === floorId && pointInPolygon(position, candidate.outline)
        ) ?? rooms.find((candidate) => candidate.id === roomIdByIndex.get(room.index));
      if (!home) continue;
      const [width, height, depth] = object.size;
      const label = capitalize(object.category.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase());
      const count = (fixtureNames.get(label) ?? 0) + 1;
      fixtureNames.set(label, count);
      fixtures.push({
        id: claimId(usedIds, kind),
        name: count === 1 ? label : `${label} ${count}`,
        kind,
        roomId: home.id,
        position,
        size: { width: round(width), depth: round(depth), height: round(height) },
        // Scan yaw turns anticlockwise in radians; fixtures turn clockwise in degrees.
        rotation: normalizeDegrees(-((object.yaw - angle) * 180) / Math.PI),
      });
    }
  }

  // 8. North, if the session knew it: the top of the plan has turned with the plan.
  let northBearing = 0;
  if (session.worldNorth !== undefined) {
    // The plan turned by -angle, so its top now points angle anticlockwise of where it did.
    northBearing = normalizeDegrees(session.worldNorth - (angle * 180) / Math.PI);
  } else {
    notes.push({
      severity: 'info',
      message:
        "The scan doesn't say which way is north; set it in the editor for sun and window directions.",
    });
  }

  const layout: HomeLayout = {
    format: LAYOUT_FORMAT,
    version: LAYOUT_VERSION,
    ...(options.name ? { name: options.name } : {}),
    site: { northBearing: round(northBearing, 0.1) % 360 },
    floors: floors.list,
    rooms,
    openings: kept,
    fixtures,
    devices: [],
  };
  return { ok: true, layout, notes, validation: validateLayout(layout) };
}

// --- Walls into outlines ---

interface Segment {
  a: Point2;
  b: Point2;
}

/**
 * Chains a room's walls into a closed outline: each wall joins the one whose end is nearest its
 * own, and each corner is where the two walls' lines meet, since scanned walls rarely end exactly
 * at a corner.
 */
function outlineFromWalls(
  scan: RoomScan,
  tolerance: number,
  warn: (message: string) => void
): Point2[] | null {
  const segments: Segment[] = scan.walls.map((wall) => ({
    a: toPlan(wall.start),
    b: toPlan(wall.end),
  }));
  const loop = chain(segments, tolerance);
  const label = scan.name ?? scan.category ?? 'A room';
  if (!loop) {
    warn(
      `${label}: its walls don't join into a closed loop, so its outline is the shape around them. Check it in the editor.`
    );
    return convexHull(segments.flatMap(({ a, b }) => [a, b]));
  }
  if (loop.length < segments.length) {
    warn(
      `${label}: left out ${segments.length - loop.length} wall ${segments.length - loop.length === 1 ? 'piece' : 'pieces'} that weren't part of the room's outline.`
    );
  }
  return loop.map((segment, i) => {
    const next = loop[(i + 1) % loop.length]!;
    return corner(segment, next);
  });
}

function chain(segments: Segment[], tolerance: number): Segment[] | null {
  // Try each wall as the start, keeping the longest closed loop found.
  let best: Segment[] | null = null;
  for (let start = 0; start < segments.length; start++) {
    const used = new Set([start]);
    const loop: Segment[] = [segments[start]!];
    for (;;) {
      const end = loop.at(-1)!.b;
      let next: { index: number; flip: boolean; gap: number } | null = null;
      segments.forEach((segment, index) => {
        if (used.has(index)) return;
        const gapA = distance(end, segment.a);
        const gapB = distance(end, segment.b);
        const gap = Math.min(gapA, gapB);
        if (gap <= tolerance && (!next || gap < next.gap)) next = { index, flip: gapB < gapA, gap };
      });
      const found = next as { index: number; flip: boolean; gap: number } | null;
      if (!found) break;
      used.add(found.index);
      const segment = segments[found.index]!;
      loop.push(found.flip ? { a: segment.b, b: segment.a } : segment);
    }
    const closed = loop.length >= 3 && distance(loop.at(-1)!.b, loop[0]!.a) <= tolerance;
    if (closed && (!best || loop.length > best.length)) best = loop;
    if (best?.length === segments.length) break;
  }
  return best;
}

/** Where two consecutive walls meet. */
function corner(first: Segment, second: Segment): Point2 {
  const meeting: Point2 = [(first.b[0] + second.a[0]) / 2, (first.b[1] + second.a[1]) / 2];
  const d1: Point2 = [first.b[0] - first.a[0], first.b[1] - first.a[1]];
  const d2: Point2 = [second.b[0] - second.a[0], second.b[1] - second.a[1]];
  const denominator = d1[0] * d2[1] - d1[1] * d2[0];
  const sine = denominator / (Math.hypot(...d1) * Math.hypot(...d2));
  // Nearly straight on: the walls don't turn here, so their meeting point will do.
  if (Math.abs(sine) < Math.sin((10 * Math.PI) / 180)) return meeting;
  const t = ((second.a[0] - first.a[0]) * d2[1] - (second.a[1] - first.a[1]) * d2[0]) / denominator;
  const intersection: Point2 = [first.a[0] + d1[0] * t, first.a[1] + d1[1] * t];
  return distance(intersection, meeting) > 1 ? meeting : intersection;
}

/** Removes repeated corners and corners on a straight wall, which scans produce plenty of. */
function tidyOutline(outline: Point2[]): Point2[] {
  let points = outline.filter(
    (point, i) => distance(point, outline[(i + 1) % outline.length]!) > 0.02
  );
  let changed = true;
  while (changed && points.length > 3) {
    changed = false;
    for (let i = 0; i < points.length; i++) {
      const previous = points[(i - 1 + points.length) % points.length]!;
      const current = points[i]!;
      const next = points[(i + 1) % points.length]!;
      if (distanceToLine(current, previous, next) < 0.02) {
        points = points.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return points;
}

/**
 * The direction the walls mostly run in, as an angle between -45° and 45°. Walls at right angles
 * count as the same direction, so a whole plan can be turned to line up with its axes.
 */
function dominantWallAngle(outlines: Point2[][]): number {
  let sin = 0;
  let cos = 0;
  for (const outline of outlines) {
    outline.forEach((start, i) => {
      const end = outline[(i + 1) % outline.length]!;
      const length = distance(start, end);
      const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
      sin += length * Math.sin(4 * angle);
      cos += length * Math.cos(4 * angle);
    });
  }
  return sin === 0 && cos === 0 ? 0 : Math.atan2(sin, cos) / 4;
}

// --- Storeys ---

function groupStoreys(heights: number[]): { list: Floor[]; idFor: (height: number) => string } {
  const sorted = [...new Set(heights.map((height) => round(height)))].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const height of sorted) {
    // Measured from the storey's lowest floor, so a run of small steps can't climb a whole storey.
    const last = groups.at(-1);
    if (last && height - last[0]! <= STOREY_GAP) last.push(height);
    else groups.push([height]);
  }
  const base = groups[0]?.[0] ?? 0;
  const list: Floor[] = groups.map((group, level) => ({
    id: groups.length === 1 ? 'ground-floor' : `floor-${level}`,
    name: groups.length === 1 || level === 0 ? 'Ground floor' : `Floor ${level}`,
    level,
    elevation: round(group[0]! - base),
  }));
  const idFor = (height: number) => {
    const index = groups.findIndex((group) =>
      group.some((h) => Math.abs(h - round(height)) < 1e-9)
    );
    return list[Math.max(0, index)]!.id;
  };
  return { list, idFor };
}

// --- Small helpers ---

/** AR world to plan: the plan is the view from above, with the world's -z at the top. */
function toPlan([x, , z]: Vector3): Point2 {
  return [x, -z];
}

function rotation(angle: number): (point: Point2) => Point2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return ([x, y]) => [x * c - y * s, x * s + y * c];
}

/** The room's wall nearest the point, or only the wall at `only` when given. */
function nearestWallOf(
  room: Room,
  point: Point2,
  only?: number
): { index: number; offset: number; length: number; distance: number } | null {
  let best: { index: number; offset: number; length: number; distance: number } | null = null;
  for (const wall of roomWalls(room)) {
    if (wall.length === 0 || (only !== undefined && wall.index !== only)) continue;
    const t = clamp(
      ((point[0] - wall.start[0]) * (wall.end[0] - wall.start[0]) +
        (point[1] - wall.start[1]) * (wall.end[1] - wall.start[1])) /
        wall.length ** 2,
      0,
      1
    );
    const nearest: Point2 = [
      wall.start[0] + (wall.end[0] - wall.start[0]) * t,
      wall.start[1] + (wall.end[1] - wall.start[1]) * t,
    ];
    const d = distance(point, nearest);
    if (!best || d < best.distance)
      best = { index: wall.index, offset: t * wall.length, length: wall.length, distance: d };
  }
  return best;
}

function openingCenterOf(rooms: Room[], opening: Opening): Point2 {
  const room = rooms.find((candidate) => candidate.id === opening.wall.roomId)!;
  const wall = roomWalls(room)[opening.wall.index]!;
  const t = opening.offset / wall.length;
  return [
    wall.start[0] + (wall.end[0] - wall.start[0]) * t,
    wall.start[1] + (wall.end[1] - wall.start[1]) * t,
  ];
}

function convexHull(points: Point2[]): Point2[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Point2, a: Point2, b: Point2) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Point2[]) => {
    const hull: Point2[] = [];
    for (const point of list) {
      while (hull.length >= 2 && cross(hull.at(-2)!, hull.at(-1)!, point) <= 0) hull.pop();
      hull.push(point);
    }
    return hull.slice(0, -1);
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

function distance([x1, y1]: Point2, [x2, y2]: Point2): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

function midpoint([x1, y1]: Point2, [x2, y2]: Point2): Point2 {
  return [(x1 + x2) / 2, (y1 + y2) / 2];
}

function distanceToLine(point: Point2, a: Point2, b: Point2): number {
  const length = distance(a, b);
  if (length === 0) return distance(point, a);
  return Math.abs((b[0] - a[0]) * (a[1] - point[1]) - (a[0] - point[0]) * (b[1] - a[1])) / length;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function claimId(used: Set<string>, base: string): string {
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  return id;
}

function slug(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rounds to the nearest centimetre, or another step; scans are no more precise than that. */
function round(value: number, step = 0.01): number {
  return Number((Math.round(value / step) * step).toFixed(4)) + 0;
}

function normalizeDegrees(degrees: number): number {
  const normalized = ((degrees % 360) + 360) % 360;
  const rounded = Math.round(normalized * 10) / 10;
  return rounded >= 360 ? 0 : rounded;
}
