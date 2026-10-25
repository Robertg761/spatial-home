import {
  EPSILON,
  MAX_WALL_THICKNESS,
  openingCenter,
  roomWalls,
  wallOutwardNormal,
  type HomeLayout,
  type Opening,
  type Point2,
  type Point3,
  type Room,
} from '@spatial-home/home-model';

// What the 3D view draws, worked out from the layout as plain numbers so it can be tested without a
// browser. Everything is in plan coordinates: metres, x to the right of the plan, y towards its top
// and z up, with each floor raised to its elevation. The view turns these into three.js meshes.

/** A solid rectangle of wall, standing on the room's side of the wall line and thickened outwards. */
export interface WallPiece {
  roomId: string;
  wallIndex: number;
  /** The piece's two ends on the wall line. */
  start: Point2;
  end: Point2;
  /** Unit vector pointing out of the room, the way the piece is thickened. */
  normal: Point2;
  /** Heights of the piece's bottom and top, from the ground floor. */
  bottom: number;
  top: number;
}

/** The glass of a window, in its wall. */
export interface Pane {
  openingId: string;
  start: Point2;
  end: Point2;
  normal: Point2;
  bottom: number;
  top: number;
}

export interface ModelRoom {
  id: string;
  name: string;
  outline: Point2[];
  /** Height of the room's floor, from the ground floor. */
  elevation: number;
  ceilingHeight: number;
}

export interface ModelBox {
  id: string;
  roomId: string;
  /** Centre of the box's footprint, at the height of the floor it stands on. */
  base: Point3;
  width: number;
  depth: number;
  height: number;
  /** Degrees clockwise on the plan. */
  rotation: number;
}

export interface ModelDevice {
  id: string;
  roomId: string;
  position: Point3;
}

export interface HomeModel3D {
  rooms: ModelRoom[];
  walls: WallPiece[];
  panes: Pane[];
  fixtures: ModelBox[];
  devices: ModelDevice[];
}

/** A stretch of a wall an opening takes up: metres along the wall, and heights above its floor. */
interface Gap {
  from: number;
  to: number;
  bottom: number;
  top: number;
}

/**
 * Builds what the 3D view draws: the rooms on the given floor and every floor below it, so upper
 * floors don't hide the one being edited. A floor rooms are on but the layout is missing counts as
 * being at ground level.
 */
export function buildModel3D(layout: HomeLayout, floorId: string): HomeModel3D {
  const elevations = new Map(layout.floors.map((floor) => [floor.id, floor.elevation]));
  const elevationOf = (id: string) => elevations.get(id) ?? 0;
  const highest = elevationOf(floorId);
  const rooms = layout.rooms.filter((room) => elevationOf(room.floorId) <= highest + EPSILON);
  const roomIds = new Set(rooms.map((room) => room.id));
  const byId = new Map(layout.rooms.map((room) => [room.id, room]));

  const model: HomeModel3D = { rooms: [], walls: [], panes: [], fixtures: [], devices: [] };
  for (const room of rooms) {
    const elevation = elevationOf(room.floorId);
    model.rooms.push({
      id: room.id,
      name: room.name,
      outline: room.outline,
      elevation,
      ceilingHeight: room.ceilingHeight,
    });
    for (const wall of roomWalls(room)) {
      if (wall.length < EPSILON) continue;
      const normal = wallOutwardNormal(room, wall.index);
      const at = (u: number): Point2 => {
        const t = u / wall.length;
        return [
          wall.start[0] + (wall.end[0] - wall.start[0]) * t,
          wall.start[1] + (wall.end[1] - wall.start[1]) * t,
        ];
      };
      const gaps = wallGaps(layout, byId, room, wall.index);
      for (const piece of wallPieces(wall.length, room.ceilingHeight, gaps)) {
        model.walls.push({
          roomId: room.id,
          wallIndex: wall.index,
          start: at(piece.from),
          end: at(piece.to),
          normal,
          bottom: elevation + piece.bottom,
          top: elevation + piece.top,
        });
      }
    }
  }

  for (const opening of layout.openings) {
    if (opening.kind !== 'window' || !roomIds.has(opening.wall.roomId)) continue;
    const room = byId.get(opening.wall.roomId)!;
    const gap = ownGap(room, opening);
    if (!gap) continue;
    const wall = roomWalls(room)[opening.wall.index]!;
    const at = (u: number): Point2 => {
      const t = u / wall.length;
      return [
        wall.start[0] + (wall.end[0] - wall.start[0]) * t,
        wall.start[1] + (wall.end[1] - wall.start[1]) * t,
      ];
    };
    const elevation = elevationOf(room.floorId);
    model.panes.push({
      openingId: opening.id,
      start: at(gap.from),
      end: at(gap.to),
      normal: wallOutwardNormal(room, opening.wall.index),
      bottom: elevation + gap.bottom,
      top: elevation + gap.top,
    });
  }

  for (const fixture of layout.fixtures) {
    const room = byId.get(fixture.roomId);
    if (!room || !roomIds.has(room.id)) continue;
    model.fixtures.push({
      id: fixture.id,
      roomId: room.id,
      base: [...fixture.position, elevationOf(room.floorId)],
      ...fixture.size,
      rotation: fixture.rotation,
    });
  }

  for (const device of layout.devices) {
    const room = byId.get(device.roomId);
    if (!room || !roomIds.has(room.id)) continue;
    const [x, y, z] = device.position;
    model.devices.push({
      id: device.id,
      roomId: room.id,
      position: [x, y, z + elevationOf(room.floorId)],
    });
  }

  return model;
}

/**
 * The openings to leave out of one of a room's walls: those in the wall itself, and those in a
 * neighbouring room's wall that lead into this room through it. Neighbouring rooms each draw their
 * own wall, so a door drawn only in the wall it's stored on would be blocked by the other.
 */
function wallGaps(
  layout: HomeLayout,
  rooms: Map<string, Room>,
  room: Room,
  wallIndex: number
): Gap[] {
  const wall = roomWalls(room)[wallIndex]!;
  const direction: Point2 = [
    (wall.end[0] - wall.start[0]) / wall.length,
    (wall.end[1] - wall.start[1]) / wall.length,
  ];
  const gaps: Gap[] = [];
  for (const opening of layout.openings) {
    if (opening.wall.roomId === room.id) {
      if (opening.wall.index !== wallIndex) continue;
      const gap = ownGap(room, opening);
      if (gap) gaps.push(gap);
      continue;
    }
    if (opening.connects !== room.id) continue;
    const other = rooms.get(opening.wall.roomId);
    const otherWall = other ? roomWalls(other)[opening.wall.index] : undefined;
    if (!other || other.floorId !== room.floorId || !otherWall || otherWall.length < EPSILON) {
      continue;
    }
    // Only a wall running alongside the opening's, within a wall's thickness of it.
    const otherDirection: Point2 = [
      (otherWall.end[0] - otherWall.start[0]) / otherWall.length,
      (otherWall.end[1] - otherWall.start[1]) / otherWall.length,
    ];
    if (Math.abs(dot(direction, otherDirection)) < 0.99) continue;
    const center = openingCenter(other, opening);
    const relative: Point2 = [center[0] - wall.start[0], center[1] - wall.start[1]];
    const along = dot(relative, direction);
    const across = Math.abs(relative[0] * direction[1] - relative[1] * direction[0]);
    if (across > MAX_WALL_THICKNESS + EPSILON) continue;
    const gap = clampGap(
      along - opening.width / 2,
      along + opening.width / 2,
      wall.length,
      room.ceilingHeight,
      opening
    );
    if (gap) gaps.push(gap);
  }
  return gaps;
}

function ownGap(room: Room, opening: Opening): Gap | null {
  const wall = roomWalls(room)[opening.wall.index];
  if (!wall) return null;
  return clampGap(
    opening.offset - opening.width / 2,
    opening.offset + opening.width / 2,
    wall.length,
    room.ceilingHeight,
    opening
  );
}

/** An opening's gap, cut back to the wall it's in. Null when nothing of it is left. */
function clampGap(
  from: number,
  to: number,
  length: number,
  ceilingHeight: number,
  opening: Opening
): Gap | null {
  const bottom = opening.kind === 'window' ? opening.sillHeight : 0;
  const gap = {
    from: Math.max(0, from),
    to: Math.min(length, to),
    bottom: Math.min(bottom, ceilingHeight),
    top: Math.min(bottom + opening.height, ceilingHeight),
  };
  return gap.to - gap.from > EPSILON && gap.top - gap.bottom > EPSILON ? gap : null;
}

/**
 * Splits a wall into solid rectangles around its gaps: between gaps it's full height, and over a
 * gap it's the part above the opening and, for a window, the part below. Overlapping gaps are
 * fine. Neighbouring rectangles of the same height are joined, so a wall without openings is one.
 */
export function wallPieces(length: number, height: number, gaps: readonly Gap[]): Gap[] {
  const cuts = [0, length, ...gaps.flatMap((gap) => [gap.from, gap.to])]
    .filter((u) => u >= 0 && u <= length)
    .sort((a, b) => a - b)
    .filter((u, i, all) => i === 0 || u - all[i - 1]! > EPSILON);
  const pieces: Gap[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const from = cuts[i]!;
    const to = cuts[i + 1]!;
    const middle = (from + to) / 2;
    const spans = gaps
      .filter((gap) => gap.from < middle && gap.to > middle)
      .map((gap) => [gap.bottom, gap.top] as const)
      .sort((a, b) => a[0] - b[0]);
    // Walk up the wall, keeping what no opening takes.
    let level = 0;
    const solid: [number, number][] = [];
    for (const [bottom, top] of spans) {
      if (bottom - level > EPSILON) solid.push([level, bottom]);
      level = Math.max(level, top);
    }
    if (height - level > EPSILON) solid.push([level, height]);
    for (const [bottom, top] of solid) {
      const previous = pieces.find(
        (piece) =>
          Math.abs(piece.to - from) < EPSILON &&
          Math.abs(piece.bottom - bottom) < EPSILON &&
          Math.abs(piece.top - top) < EPSILON
      );
      if (previous) previous.to = to;
      else pieces.push({ from, to, bottom, top });
    }
  }
  return pieces;
}

function dot([ax, ay]: Point2, [bx, by]: Point2): number {
  return ax * bx + ay * by;
}
