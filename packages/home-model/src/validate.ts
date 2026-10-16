import type { z } from 'zod';
import {
  EPSILON,
  MAX_WALL_THICKNESS,
  isSimplePolygon,
  pointInPolygon,
  polygonArea,
  roomWalls,
  wallOutwardNormal,
  type Wall,
} from './geometry.ts';
import {
  HomeLayoutSchema,
  LAYOUT_FORMAT,
  LAYOUT_VERSION,
  OUTSIDE,
  type HomeLayout,
  type Opening,
  type Point2,
  type Room,
} from './schema.ts';

export interface LayoutIssue {
  /** Errors make the layout unusable; warnings point at something that is probably a mistake. */
  severity: 'error' | 'warning';
  code: string;
  /** Where in the file, such as ["rooms", 2, "outline"]. */
  path: (string | number)[];
  message: string;
}

export type ValidationResult =
  | { ok: true; layout: HomeLayout; warnings: LayoutIssue[] }
  | {
      ok: false;
      errors: LayoutIssue[];
      warnings: LayoutIssue[];
      /**
       * Present when the file has the right structure but its contents have errors, such as a
       * window that doesn't fit its wall, so an editor can open it for the errors to be fixed.
       */
      layout?: HomeLayout;
    };

/** Parses the text of a home-layout.json file. */
export function parseLayoutJson(text: string): ValidationResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      errors: [
        {
          severity: 'error',
          code: 'invalid-json',
          path: [],
          message: `Not valid JSON: ${message}`,
        },
      ],
      warnings: [],
    };
  }
  return validateLayout(data);
}

/**
 * Checks a parsed home-layout.json: its structure, that every reference points at something that
 * exists, and that the geometry makes sense. On success, `layout` holds the checked data with its
 * keys in the format's order.
 */
export function validateLayout(data: unknown): ValidationResult {
  const versionIssue = checkFormatAndVersion(data);
  if (versionIssue) return { ok: false, errors: [versionIssue], warnings: [] };

  const parsed = HomeLayoutSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map(fromZodIssue), warnings: [] };
  }

  const issues = checkLayout(parsed.data);
  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');
  return errors.length > 0
    ? { ok: false, errors, warnings, layout: parsed.data }
    : { ok: true, layout: parsed.data, warnings };
}

function checkFormatAndVersion(data: unknown): LayoutIssue | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return error('not-a-layout', [], 'A home layout is a JSON object.');
  }
  const { format, version } = data as Record<string, unknown>;
  if (format !== LAYOUT_FORMAT) {
    return error(
      'not-a-layout',
      ['format'],
      `Not a Spatial Home layout: "format" must be "${LAYOUT_FORMAT}".`
    );
  }
  if (typeof version === 'number' && Number.isInteger(version) && version > LAYOUT_VERSION) {
    return error(
      'unsupported-version',
      ['version'],
      `This layout uses format version ${version}, written by a newer Spatial Home. This version reads up to version ${LAYOUT_VERSION}.`
    );
  }
  return null;
}

function checkLayout(layout: HomeLayout): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const floors = new Map(layout.floors.map((floor) => [floor.id, floor]));
  const rooms = new Map(layout.rooms.map((room) => [room.id, room]));

  // Ids share one namespace, so a reference can never be ambiguous.
  const seen = new Map<string, (string | number)[]>();
  const collections = ['floors', 'rooms', 'openings', 'fixtures', 'devices'] as const;
  for (const collection of collections) {
    layout[collection].forEach((item, index) => {
      const path = [collection, index, 'id'];
      if (item.id === OUTSIDE) {
        issues.push(
          error('reserved-id', path, `"${OUTSIDE}" is reserved for the outside of the home.`)
        );
      }
      const first = seen.get(item.id);
      if (first) {
        issues.push(
          error('duplicate-id', path, `The id "${item.id}" is already used at ${first.join('.')}.`)
        );
      } else {
        seen.set(item.id, path);
      }
    });
  }

  const levels = new Map<number, string>();
  layout.floors.forEach((floor, index) => {
    const other = levels.get(floor.level);
    if (other) {
      issues.push(
        warning(
          'duplicate-level',
          ['floors', index, 'level'],
          `Floors "${other}" and "${floor.id}" are both level ${floor.level}.`
        )
      );
    } else {
      levels.set(floor.level, floor.id);
    }
  });

  layout.rooms.forEach((room, index) => {
    const path = ['rooms', index];
    if (!floors.has(room.floorId)) {
      issues.push(
        error('unknown-floor', [...path, 'floorId'], `No floor has the id "${room.floorId}".`)
      );
    }
    if (!isSimplePolygon(room.outline)) {
      issues.push(
        error(
          'self-intersecting-outline',
          [...path, 'outline'],
          `The outline of "${room.id}" crosses itself, repeats a corner or doubles back on a wall.`
        )
      );
    } else if (polygonArea(room.outline) < EPSILON) {
      issues.push(
        error('empty-outline', [...path, 'outline'], `The outline of "${room.id}" has no area.`)
      );
    }
  });

  layout.openings.forEach((opening, index) => {
    const path = ['openings', index];
    const room = rooms.get(opening.wall.roomId);
    if (!room) {
      issues.push(
        error(
          'unknown-room',
          [...path, 'wall', 'roomId'],
          `No room has the id "${opening.wall.roomId}".`
        )
      );
    } else {
      // A broken outline is reported once, on the room, rather than again for each of its openings.
      const wall = isUsableOutline(room) ? roomWalls(room)[opening.wall.index] : null;
      if (wall === undefined) {
        issues.push(
          error(
            'unknown-wall',
            [...path, 'wall', 'index'],
            `"${room.id}" has ${room.outline.length} walls, numbered 0 to ${room.outline.length - 1}.`
          )
        );
      } else if (
        wall &&
        (opening.offset - opening.width / 2 < -EPSILON ||
          opening.offset + opening.width / 2 > wall.length + EPSILON)
      ) {
        issues.push(
          error(
            'opening-outside-wall',
            [...path, 'offset'],
            `"${opening.id}" is ${opening.width} m wide centred ${opening.offset} m along a ${round(wall.length)} m wall, so it runs past the wall's end.`
          )
        );
      }
      const top = (opening.kind === 'window' ? opening.sillHeight : 0) + opening.height;
      if (top > room.ceilingHeight + EPSILON) {
        issues.push(
          warning(
            'opening-above-ceiling',
            [...path, 'height'],
            `The top of "${opening.id}" is ${round(top)} m up, above the ${room.ceilingHeight} m ceiling of "${room.id}".`
          )
        );
      }
    }

    if (opening.connects === opening.wall.roomId) {
      issues.push(
        error(
          'opening-to-same-room',
          [...path, 'connects'],
          `"${opening.id}" leads back into its own room.`
        )
      );
    } else if (opening.connects !== OUTSIDE) {
      const other = rooms.get(opening.connects);
      if (!other) {
        issues.push(
          error(
            'unknown-room',
            [...path, 'connects'],
            `No room has the id "${opening.connects}"; use "${OUTSIDE}" for the outside.`
          )
        );
      } else if (
        room &&
        floors.has(room.floorId) &&
        floors.has(other.floorId) &&
        other.floorId !== room.floorId
      ) {
        issues.push(
          warning(
            'opening-between-floors',
            [...path, 'connects'],
            `"${opening.id}" joins rooms on different floors; stairs aren't modelled as openings yet.`
          )
        );
      }
    }
  });

  issues.push(...checkOpeningOverlaps(layout, rooms));

  layout.fixtures.forEach((fixture, index) => {
    const path = ['fixtures', index];
    const room = rooms.get(fixture.roomId);
    if (!room) {
      issues.push(
        error('unknown-room', [...path, 'roomId'], `No room has the id "${fixture.roomId}".`)
      );
    } else if (isUsableOutline(room) && !pointInPolygon(fixture.position, room.outline)) {
      issues.push(
        warning('outside-room', [...path, 'position'], `"${fixture.id}" is outside "${room.id}".`)
      );
    }
  });

  const entityOwners = new Map<string, string>();
  layout.devices.forEach((device, index) => {
    const path = ['devices', index];
    const room = rooms.get(device.roomId);
    if (!room) {
      issues.push(
        error('unknown-room', [...path, 'roomId'], `No room has the id "${device.roomId}".`)
      );
    } else {
      const [x, y, z] = device.position;
      if (isUsableOutline(room) && !pointInPolygon([x, y], room.outline)) {
        issues.push(
          warning('outside-room', [...path, 'position'], `"${device.id}" is outside "${room.id}".`)
        );
      }
      if (z < -EPSILON || z > room.ceilingHeight + EPSILON) {
        issues.push(
          warning(
            'height-outside-room',
            [...path, 'position', 2],
            `"${device.id}" is ${z} m up, outside the floor-to-ceiling height of "${room.id}".`
          )
        );
      }
    }

    device.coverage?.forEach((coverage, coverageIndex) => {
      if (device.heading === undefined && (coverage.fieldOfView ?? 360) < 360) {
        issues.push(
          error(
            'coverage-needs-heading',
            [...path, 'coverage', coverageIndex, 'fieldOfView'],
            `"${device.id}" covers a ${coverage.fieldOfView}° cone, so it needs a heading.`
          )
        );
      }
    });

    device.ha?.entityIds.forEach((entityId, entityIndex) => {
      const owner = entityOwners.get(entityId);
      if (owner && owner !== device.id) {
        issues.push(
          warning(
            'entity-placed-twice',
            [...path, 'ha', 'entityIds', entityIndex],
            `${entityId} is also linked to "${owner}"; an entity can only be in one place.`
          )
        );
      } else {
        entityOwners.set(entityId, device.id);
      }
    });
  });

  return issues;
}

/** An opening on its wall: the stretch of the wall it takes up, and how high it reaches. */
interface PlacedOpening {
  index: number;
  opening: Opening;
  room: Room;
  wall: Wall;
  /** Unit vector along the wall, from its start towards its end. */
  along: Point2;
  /** Unit vector out of the room. */
  outward: Point2;
  /** Distances along the wall from its start. */
  from: number;
  to: number;
  /** Heights above the floor. */
  bottom: number;
  top: number;
}

/**
 * Walls whose outward directions are closer to opposite than this (about 25°) face each other, as
 * the two sides of one wall between rooms do, even when scanned a little out of line.
 */
const FACING_EACH_OTHER = -0.9;

/**
 * Openings that take up the same part of a wall: on the same wall of a room, or on the two sides
 * of the wall between two rooms that each lead into the other, which is one opening recorded from
 * both rooms. Each is reported once, on the later of the two, so the earlier one stays as it is.
 * Openings can sit one above the other, such as a window over a door, so they only overlap if
 * their heights do too.
 */
function checkOpeningOverlaps(layout: HomeLayout, rooms: Map<string, Room>): LayoutIssue[] {
  const placed: PlacedOpening[] = [];
  layout.openings.forEach((opening, index) => {
    const room = rooms.get(opening.wall.roomId);
    // An opening in a missing room or wall is already reported, and has nowhere to overlap.
    const wall = room && isUsableOutline(room) ? roomWalls(room)[opening.wall.index] : undefined;
    if (!room || !wall) return;
    const bottom = opening.kind === 'window' ? opening.sillHeight : 0;
    placed.push({
      index,
      opening,
      room,
      wall,
      along: [
        (wall.end[0] - wall.start[0]) / wall.length,
        (wall.end[1] - wall.start[1]) / wall.length,
      ],
      outward: wallOutwardNormal(room, wall.index),
      from: opening.offset - opening.width / 2,
      to: opening.offset + opening.width / 2,
      bottom,
      top: bottom + opening.height,
    });
  });

  const issues: LayoutIssue[] = [];
  placed.forEach((later, i) => {
    for (const earlier of placed.slice(0, i)) {
      const message = overlapMessage(earlier, later);
      if (message) {
        issues.push(warning('opening-overlap', ['openings', later.index, 'offset'], message));
        break;
      }
    }
  });
  return issues;
}

function overlapMessage(earlier: PlacedOpening, later: PlacedOpening): string | null {
  const first = earlier.opening.id;
  const second = later.opening.id;
  if (!spansOverlap([earlier.bottom, earlier.top], [later.bottom, later.top])) return null;

  if (earlier.room === later.room) {
    return earlier.wall.index === later.wall.index &&
      spansOverlap([earlier.from, earlier.to], [later.from, later.to])
      ? `"${second}" overlaps "${first}" in the same wall of "${later.room.id}".`
      : null;
  }

  const across =
    earlier.opening.connects === later.room.id &&
    later.opening.connects === earlier.room.id &&
    earlier.room.floorId === later.room.floorId &&
    dot(earlier.outward, later.outward) < FACING_EACH_OTHER;
  if (!across) return null;
  // Measured from both walls, so the answer doesn't depend on which opening is listed first.
  return overlapsAcross(earlier, later) || overlapsAcross(later, earlier)
    ? `"${second}" overlaps "${first}" across the wall between "${earlier.room.id}" and "${later.room.id}"; they may be one opening recorded from both rooms.`
    : null;
}

/**
 * Whether `other` takes up some of the same stretch of wall as `one`, seen from `one`'s wall, and
 * is within a wall's thickness of it all along that shared stretch. Walls out of line drift apart,
 * so the gap is measured only where the openings overlap, not at the far ends of a wider one.
 */
function overlapsAcross(one: PlacedOpening, other: PlacedOpening): boolean {
  // Where the other opening's ends are, measured along this one's wall and out from it.
  const measure = (distanceAlong: number) => {
    const point: Point2 = [
      other.wall.start[0] + other.along[0] * distanceAlong - one.wall.start[0],
      other.wall.start[1] + other.along[1] * distanceAlong - one.wall.start[1],
    ];
    return { along: dot(point, one.along), out: dot(point, one.outward) };
  };
  const [a, b] = [measure(other.from), measure(other.to)];
  const start = Math.max(one.from, Math.min(a.along, b.along));
  const end = Math.min(one.to, Math.max(a.along, b.along));
  if (end - start <= EPSILON) return false;
  // The walls face each other, so the other opening's ends are apart along this wall.
  const outAt = (along: number) =>
    a.out + ((b.out - a.out) * (along - a.along)) / (b.along - a.along);
  return Math.max(Math.abs(outAt(start)), Math.abs(outAt(end))) <= MAX_WALL_THICKNESS + EPSILON;
}

/** Whether two ranges share more than a touching end. */
function spansOverlap([start1, end1]: [number, number], [start2, end2]: [number, number]): boolean {
  return Math.min(end1, end2) - Math.max(start1, start2) > EPSILON;
}

function dot([x1, y1]: Point2, [x2, y2]: Point2): number {
  return x1 * x2 + y1 * y2;
}

function isUsableOutline(room: Room): boolean {
  return polygonArea(room.outline) >= EPSILON && isSimplePolygon(room.outline);
}

function fromZodIssue(issue: z.core.$ZodIssue): LayoutIssue {
  return {
    severity: 'error',
    code: `invalid-${issue.code.replace(/_/g, '-')}`,
    path: issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part)),
    message: issue.message,
  };
}

function error(code: string, path: (string | number)[], message: string): LayoutIssue {
  return { severity: 'error', code, path, message };
}

function warning(code: string, path: (string | number)[], message: string): LayoutIssue {
  return { severity: 'warning', code, path, message };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
