import {
  EPSILON,
  KIND_MAX_LENGTH,
  LAYOUT_FORMAT,
  LAYOUT_VERSION,
  NAME_MAX_LENGTH,
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
    let outline = tidyOutline(room.outline.map(place));
    const name =
      layoutName(room.scan.name) ??
      layoutName(capitalize(room.scan.category?.trim() ?? '')) ??
      `Room ${room.index + 1}`;
    const id = claimId(usedIds, slug(name) || 'room');
    const heights = room.scan.walls.map((wall) => wall.height);
    const tallest = heights.length > 0 ? Math.max(...heights) : undefined;
    // A height under a centimetre would be written as 0, so it counts as not measured.
    const measured = room.scan.ceilingHeight !== undefined && hasSize(room.scan.ceilingHeight);
    const fromWalls = tallest !== undefined && hasSize(tallest);
    const ceilingHeight = measured
      ? room.scan.ceilingHeight!
      : fromWalls
        ? tallest!
        : DEFAULT_CEILING_HEIGHT;
    let heightNote: string | undefined;
    if (!measured && !fromWalls) {
      heightNote =
        room.scan.ceilingHeight === undefined && tallest === undefined
          ? `${name}: the scan has no wall heights, so the ceiling is set to ${DEFAULT_CEILING_HEIGHT} m.`
          : `${name}: the ceiling and wall heights in the scan are under a centimetre, so the ceiling is set to ${DEFAULT_CEILING_HEIGHT} m.`;
    } else if (!measured && room.scan.ceilingHeight !== undefined) {
      heightNote = `${name}: the measured ceiling height is under a centimetre, so the tallest wall is used.`;
    }
    if (heightNote) notes.push({ severity: 'info', message: heightNote, room: room.index });
    // A layout's room can't cross itself, so an outline that does becomes the shape around it.
    if (!isSimplePolygon(outline)) {
      outline = tidyOutline(convexHull(outline));
      notes.push({
        severity: 'warning',
        message: `${name}: the scanned outline crosses itself, so the room is the shape around it instead. Check it in the editor.`,
        room: room.index,
      });
    }
    if (!isSimplePolygon(outline) || polygonArea(outline) < EPSILON) {
      errors.push(
        `${name} (room ${room.index + 1}) has no area: its corners are in a line or on top of each other.`
      );
      continue;
    }
    if (polygonArea(outline) < 0.1) {
      notes.push({
        severity: 'warning',
        message: `${name}: the scanned outline has almost no area; redraw it in the editor.`,
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

  if (errors.length > 0) return { ok: false, errors };

  // 5. Openings, each on the wall the scanner says it is in, or else the nearest wall of its room.
  const openings: Opening[] = [];
  for (const room of planned) {
    const roomId = roomIdByIndex.get(room.index)!;
    const target = rooms.find((candidate) => candidate.id === roomId)!;
    room.scan.openings.forEach((scanned, openingIndex) => {
      if (!hasSize(scanned.width) || !hasSize(scanned.height)) {
        notes.push({
          severity: 'warning',
          message: `${target.name}: left out a ${scanned.kind} under a centimetre in size.`,
          room: room.index,
        });
        return;
      }
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
      // Width and offset are rounded as they will be written out, so the opening still fits the
      // wall as validation measures it (the outline is already rounded). An opening as wide as
      // the wall is narrowed to an even number of centimetres so that it can be centred.
      const width = Math.min(round(scanned.width), round(2 * round(hit.length / 2, 0.01, 'down')));
      const offset = clamp(
        round(hit.offset),
        round(width / 2, 0.01, 'up'),
        round(hit.length - width / 2, 0.01, 'down')
      );
      const bottom = scanned.center[1] - scanned.height / 2 - room.floorHeight;
      const base = {
        id: claimId(
          usedIds,
          `${roomId}-${scanned.kind === 'opening' ? 'passage' : scanned.kind}-${openingIndex + 1}`
        ),
        wall: { roomId, index: hit.index },
        offset,
        width,
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
  //    rooms is seen from both sides, so the second sighting is dropped: one close by, of about the
  //    same width, and a window if and only if this is one. A door and a doorway can be the same
  //    opening, as one side may not see the door itself. Each opening kept matches one sighting
  //    from the other side at most, the nearest.
  const draft = { rooms };
  const kept: Opening[] = [];
  const paired = new Set<Opening>();
  for (const opening of openings) {
    const connects = roomBehindWall(draft, opening.wall.roomId, opening.wall.index, opening.offset);
    const center = openingCenterOf(rooms, opening);
    const [match] = kept
      .filter(
        (other) =>
          !paired.has(other) &&
          other.connects === opening.wall.roomId &&
          other.wall.roomId === connects &&
          (other.kind === 'window') === (opening.kind === 'window') &&
          Math.min(other.width, opening.width) >= 0.7 * Math.max(other.width, opening.width)
      )
      .map((other) => ({ other, gap: distance(openingCenterOf(rooms, other), center) }))
      .filter(({ gap }) => gap < 0.6)
      .sort((a, b) => a.gap - b.gap);
    if (match) {
      // A door seen from one side and a doorway from the other is a door whose leaf one side
      // missed, whichever was seen first.
      const merged: Opening =
        opening.kind === 'door' && match.other.kind === 'passage'
          ? { ...match.other, kind: 'door' }
          : match.other;
      kept[kept.indexOf(match.other)] = merged;
      paired.add(merged);
      continue;
    }
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
      const kind = slug(object.category).slice(0, KIND_MAX_LENGTH) || 'object';
      if (kind === 'stairs') {
        notes.push({
          severity: 'info',
          message: 'Left out stairs; they are not part of the layout yet.',
          room: room.index,
        });
        continue;
      }
      const label =
        layoutName(
          capitalize(
            object.category
              .trim()
              .replace(/([a-z])([A-Z])/g, '$1 $2')
              .toLowerCase()
          )
        ) ?? 'Object';
      if (!object.size.every(hasSize)) {
        const roomName = rooms.find((other) => other.id === roomIdByIndex.get(room.index))!.name;
        notes.push({
          severity: 'warning',
          message: `${roomName}: left out a ${label.toLowerCase()} under a centimetre in size.`,
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
      const count = (fixtureNames.get(label) ?? 0) + 1;
      fixtureNames.set(label, count);
      fixtures.push({
        id: claimId(usedIds, kind),
        name:
          count === 1
            ? label
            : `${layoutName(label, NAME_MAX_LENGTH - ` ${count}`.length)} ${count}`,
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

  const homeName = layoutName(options.name);
  const layout: HomeLayout = {
    format: LAYOUT_FORMAT,
    version: LAYOUT_VERSION,
    ...(homeName ? { name: homeName } : {}),
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
 * Chains a room's walls into a closed outline: each wall joins one whose end is near its own,
 * and each corner is where the two walls' lines meet, since scanned walls rarely end exactly at a
 * corner.
 */
function outlineFromWalls(
  scan: RoomScan,
  tolerance: number,
  warn: (message: string) => void
): Point2[] | null {
  const all: Segment[] = scan.walls.map((wall) => ({
    a: toPlan(wall.start),
    b: toPlan(wall.end),
  }));
  // A wall with no length has no direction to find a corner from, so it is left out.
  const segments = all.filter(({ a, b }) => distance(a, b) >= 0.01);
  const loop = chain(segments, tolerance);
  const label = scan.name ?? scan.category ?? 'A room';
  if (!loop) {
    warn(
      `${label}: its walls don't join into a closed loop, so its outline is the shape around them. Check it in the editor.`
    );
    return convexHull(all.flatMap(({ a, b }) => [a, b]));
  }
  const left = all.length - loop.length;
  if (left > 0) {
    warn(
      `${label}: left out ${left} wall ${left === 1 ? 'piece' : 'pieces'} that weren't part of the room's outline.`
    );
  }
  return loop.map((segment, i) => {
    const next = loop[(i + 1) % loop.length]!;
    return corner(segment, next);
  });
}

/** How many steps the search for a wall loop may take from each starting wall. */
const CHAIN_STEPS = 2000;

function chain(segments: Segment[], tolerance: number): Segment[] | null {
  // Try each wall as the start, keeping the closed loop around the most floor, and of those the
  // one using the most walls; a column or cupboard inside the room can have more pieces than the
  // room. From each wall end, try the walls within reach nearest first, and back up when that
  // leads nowhere, such as into a stray piece that starts at a corner, or back to a corner
  // already passed.
  let best = null as Segment[] | null; // Not `: Segment[] | null = null`, which stays null to tsc.
  let bestArea = 0;
  const used = new Set<number>();
  let steps = 0;
  const extend = (loop: Segment[]) => {
    if (steps++ > CHAIN_STEPS) return;
    const end = loop.at(-1)!.b;
    // Back where it started: a loop, which goes no further.
    if (loop.length >= 3 && distance(end, loop[0]!.a) <= tolerance) {
      const area = polygonArea(loop.map(({ a }) => a));
      const tie = Math.abs(area - bestArea) < 1e-6;
      if (!best || (tie ? loop.length > best.length : area > bestArea)) {
        best = [...loop];
        bestArea = area;
      }
      return;
    }
    // Back at a corner it turned at well before, as round a loop of stray pieces: the outline
    // would pinch there. Short walls in a row can end near each other without going round.
    let along = 0;
    for (let i = loop.length - 1; i >= 1; i--) {
      along += distance(loop[i]!.a, loop[i]!.b);
      if (along > 2 * tolerance && distance(end, loop[i]!.a) <= tolerance) return;
    }
    const next = segments
      .map((segment, index) => {
        const gapA = distance(end, segment.a);
        const gapB = distance(end, segment.b);
        return { index, flip: gapB < gapA, gap: Math.min(gapA, gapB) };
      })
      .filter(({ index, gap }) => !used.has(index) && gap <= tolerance)
      .sort((a, b) => a.gap - b.gap);
    for (const { index, flip } of next) {
      const segment = segments[index]!;
      used.add(index);
      loop.push(flip ? { a: segment.b, b: segment.a } : segment);
      extend(loop);
      loop.pop();
      used.delete(index);
    }
  };
  for (let start = 0; start < segments.length; start++) {
    steps = 0;
    used.add(start);
    extend([segments[start]!]);
    used.delete(start);
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
  // Nearly straight on, or a wall with no length (a NaN sine): the meeting point will do.
  if (!(Math.abs(sine) >= Math.sin((10 * Math.PI) / 180))) return meeting;
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

/** A name as the layout takes it: trimmed and cut to length, or undefined when there's none. */
function layoutName(text: string | undefined, max = NAME_MAX_LENGTH): string | undefined {
  // Not cutting a character made of two UTF-16 units in half.
  const cut = text
    ?.trim()
    .slice(0, max)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trim();
  return cut || undefined;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rounds to the nearest centimetre, or another step; scans are no more precise than that. */
function round(
  value: number,
  step = 0.01,
  direction: 'nearest' | 'down' | 'up' = 'nearest'
): number {
  const steps = value / step;
  // Down and up allow for floating-point error, so 0.29 / 0.01 still counts as 29 steps.
  const whole =
    direction === 'down'
      ? Math.floor(steps + 1e-6)
      : direction === 'up'
        ? Math.ceil(steps - 1e-6)
        : Math.round(steps);
  return Number((whole * step).toFixed(4)) + 0;
}

/** Whether a length survives rounding to centimetres; the layout needs widths and heights above 0. */
function hasSize(length: number): boolean {
  return round(length) > 0;
}

function normalizeDegrees(degrees: number): number {
  const normalized = ((degrees % 360) + 360) % 360;
  const rounded = Math.round(normalized * 10) / 10;
  return rounded >= 360 ? 0 : rounded;
}
