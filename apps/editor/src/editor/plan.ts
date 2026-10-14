// Edits to a layout made from the floor plan. Every function returns a new layout and leaves the
// one it was given untouched, so undo can keep the old ones. Edits that change what is behind an
// opening also change where it leads, through reconnectOpenings.

import {
  OUTSIDE,
  createEmptyLayout,
  distance,
  pointInPolygon,
  roomWalls,
  wallOutwardNormal,
  type Floor,
  type HomeLayout,
  type Opening,
  type Point2,
  type Room,
} from '@spatial-home/home-model';

export const GRID_STEP = 0.1;
export const DEFAULT_CEILING_HEIGHT = 2.5;

export type OpeningKind = Opening['kind'];

/** Sizes a new opening starts with, in metres. */
export const OPENING_DEFAULTS: Record<
  OpeningKind,
  { width: number; height: number; sillHeight?: number }
> = {
  door: { width: 0.8, height: 2.1 },
  window: { width: 1.2, height: 1.2, sillHeight: 0.9 },
  passage: { width: 1.0, height: 2.1 },
};

export function snapToGrid([x, y]: Point2, step = GRID_STEP): Point2 {
  return [roundTo(Math.round(x / step) * step), roundTo(Math.round(y / step) * step)];
}

/** The nearest corner of a room on the floor within `threshold` metres, or else the grid point. */
export function snapPoint(
  layout: HomeLayout,
  floorId: string,
  point: Point2,
  threshold: number
): Point2 {
  let best: Point2 | null = null;
  let bestDistance = threshold;
  for (const room of roomsOnFloor(layout, floorId)) {
    for (const corner of room.outline) {
      const d = distance(point, corner);
      if (d <= bestDistance) {
        best = corner;
        bestDistance = d;
      }
    }
  }
  return best ?? snapToGrid(point);
}

export function roomsOnFloor(layout: HomeLayout, floorId: string): Room[] {
  return layout.rooms.filter((room) => room.floorId === floorId);
}

/** The room on the floor containing a point, preferring the smallest when rooms overlap. */
export function roomAt(
  layout: HomeLayout,
  floorId: string,
  point: Point2,
  exceptId?: string
): Room | null {
  const containing = roomsOnFloor(layout, floorId).filter(
    (room) => room.id !== exceptId && pointInPolygon(point, room.outline)
  );
  return containing.sort((a, b) => boundsArea(a.outline) - boundsArea(b.outline))[0] ?? null;
}

export interface WallHit {
  roomId: string;
  wallIndex: number;
  /** Distance along the wall from its start to the point nearest the cursor. */
  offset: number;
  length: number;
  distance: number;
}

/** The wall on the floor nearest a point, if one is within `maxDistance` metres. */
export function nearestWall(
  layout: HomeLayout,
  floorId: string,
  point: Point2,
  maxDistance: number
): WallHit | null {
  let best: WallHit | null = null;
  for (const room of roomsOnFloor(layout, floorId)) {
    for (const wall of roomWalls(room)) {
      if (wall.length === 0) continue;
      const [ax, ay] = wall.start;
      const [bx, by] = wall.end;
      const t = clamp(
        ((point[0] - ax) * (bx - ax) + (point[1] - ay) * (by - ay)) / wall.length ** 2,
        0,
        1
      );
      const nearest: Point2 = [ax + t * (bx - ax), ay + t * (by - ay)];
      const d = distance(point, nearest);
      if (d <= maxDistance && (!best || d < best.distance - 1e-9)) {
        best = {
          roomId: room.id,
          wallIndex: wall.index,
          offset: t * wall.length,
          length: wall.length,
          distance: d,
        };
      }
    }
  }
  return best;
}

/** What is on the other side of a wall at a point along it: another room on the floor, or outside. */
export function roomAcross(
  layout: HomeLayout,
  roomId: string,
  wallIndex: number,
  offset: number
): string {
  const room = findRoom(layout, roomId);
  const wall = roomWalls(room)[wallIndex];
  if (!wall) return OUTSIDE;
  const t = wall.length === 0 ? 0 : offset / wall.length;
  const [nx, ny] = wallOutwardNormal(room, wallIndex);
  // Just past the wall, so a room sharing the wall contains the probe and this room doesn't.
  const probe: Point2 = [
    wall.start[0] + (wall.end[0] - wall.start[0]) * t + nx * 0.05,
    wall.start[1] + (wall.end[1] - wall.start[1]) * t + ny * 0.05,
  ];
  return roomAt(layout, room.floorId, probe, room.id)?.id ?? OUTSIDE;
}

/**
 * Adds a room to a floor. In a layout with no floors, which is valid, the room goes on a new ground
 * floor like the one a new layout starts with.
 */
export function addRoom(
  layout: HomeLayout,
  floorId: string,
  outline: Point2[],
  name = nextRoomName(layout)
): { layout: HomeLayout; id: string } {
  const ground = layout.floors.length === 0 ? groundFloor(layout) : null;
  const withFloor = ground ? { ...layout, floors: [ground] } : layout;
  const id = uniqueId(withFloor, slug(name) || 'room');
  const room: Room = {
    id,
    name,
    floorId: ground?.id ?? floorId,
    outline,
    ceilingHeight: DEFAULT_CEILING_HEIGHT,
  };
  return {
    layout: reconnectOpenings(layout, { ...withFloor, rooms: [...withFloor.rooms, room] }),
    id,
  };
}

function groundFloor(layout: HomeLayout): Floor {
  const floor = createEmptyLayout().floors[0]!;
  return { ...floor, id: uniqueId(layout, floor.id) };
}

export type AddOpeningResult = { layout: HomeLayout; id: string } | { error: string };

/** Adds an opening centred on a wall hit, shifted along the wall so that it fits. */
export function addOpening(layout: HomeLayout, kind: OpeningKind, hit: WallHit): AddOpeningResult {
  const defaults = OPENING_DEFAULTS[kind];
  if (hit.length < defaults.width) {
    return {
      error: `That wall is ${round(hit.length)} m long, too short for a ${defaults.width} m ${kind}.`,
    };
  }
  const offset = fitOffset(roundTo(hit.offset, 0.01), defaults.width, hit.length);
  const id = uniqueId(layout, kind);
  const base = {
    id,
    wall: { roomId: hit.roomId, index: hit.wallIndex },
    offset,
    width: defaults.width,
    height: defaults.height,
    connects: roomAcross(layout, hit.roomId, hit.wallIndex, offset),
  };
  const opening: Opening =
    kind === 'window' ? { kind, ...base, sillHeight: defaults.sillHeight ?? 0 } : { kind, ...base };
  return { layout: { ...layout, openings: [...layout.openings, opening] }, id };
}

/**
 * Moves a room, with the fixtures and devices in it. Openings move with their walls, and lead to
 * whatever is now behind them.
 */
export function moveRoom(layout: HomeLayout, roomId: string, dx: number, dy: number): HomeLayout {
  const shift = ([x, y]: Point2): Point2 => [roundTo(x + dx), roundTo(y + dy)];
  return reconnectOpenings(layout, {
    ...layout,
    rooms: layout.rooms.map((room) =>
      room.id === roomId ? { ...room, outline: room.outline.map(shift) } : room
    ),
    fixtures: layout.fixtures.map((fixture) =>
      fixture.roomId === roomId ? { ...fixture, position: shift(fixture.position) } : fixture
    ),
    devices: layout.devices.map((device) => {
      if (device.roomId !== roomId) return device;
      const [x, y, z] = device.position;
      const [nx, ny] = shift([x, y]);
      return { ...device, position: [nx, ny, z] };
    }),
  });
}

/**
 * Moves one corner of a room. Openings on the two walls that meet there keep their distance from
 * each wall's other end, which stays put, and slide along if they would run off the wall.
 */
export function moveCorner(
  layout: HomeLayout,
  roomId: string,
  index: number,
  point: Point2
): HomeLayout {
  const room = findRoom(layout, roomId);
  const outline = room.outline.map((corner, i) => (i === index ? point : corner));
  const oldWalls = roomWalls(room);
  const newWalls = roomWalls({ ...room, outline });
  // Wall `index` starts at the corner, and the wall before it ends there.
  const ending = (index + outline.length - 1) % outline.length;
  return reconnectOpenings(layout, {
    ...layout,
    rooms: layout.rooms.map((r) => (r.id === roomId ? { ...r, outline } : r)),
    openings: layout.openings.map((opening) => {
      const wall = opening.wall.index;
      if (opening.wall.roomId !== roomId || (wall !== index && wall !== ending)) return opening;
      const length = newWalls[wall]!.length;
      const offset =
        wall === index
          ? roundTo(length - (oldWalls[wall]!.length - opening.offset))
          : opening.offset;
      return { ...opening, offset: fitOffset(offset, opening.width, length) };
    }),
  });
}

/**
 * Points each opening at whatever is behind it after an edit, as addOpening does for a new one. An
 * opening that led somewhere other than what was behind it before was set by hand, and one whose
 * destination the edit itself changed is being set by hand, so those are left alone.
 */
function reconnectOpenings(before: HomeLayout, after: HomeLayout): HomeLayout {
  const was = new Map(before.openings.map((opening) => [opening.id, opening]));
  return {
    ...after,
    openings: after.openings.map((opening) => {
      const old = was.get(opening.id);
      if (!old || old.connects !== opening.connects || old.connects !== behind(before, old)) {
        return opening;
      }
      const connects = behind(after, opening);
      return connects === undefined || connects === opening.connects
        ? opening
        : { ...opening, connects };
    }),
  };
}

/** What is behind an opening, or undefined when the room it is in is missing. */
function behind(layout: HomeLayout, opening: Opening): string | undefined {
  const { roomId, index } = opening.wall;
  return layout.rooms.some((room) => room.id === roomId)
    ? roomAcross(layout, roomId, index, opening.offset)
    : undefined;
}

export function updateRoom(
  layout: HomeLayout,
  roomId: string,
  patch: Partial<Omit<Room, 'id'>>
): HomeLayout {
  return reconnectOpenings(layout, {
    ...layout,
    rooms: layout.rooms.map((room) => (room.id === roomId ? { ...room, ...patch } : room)),
  });
}

export interface OpeningPatch {
  kind?: OpeningKind;
  /** An empty name removes it. */
  name?: string;
  offset?: number;
  width?: number;
  height?: number;
  sillHeight?: number;
  connects?: string;
}

/**
 * Changes an opening. Changing its kind keeps its size and position; a window gains the default
 * sill height, and loses its sill height when it stops being a window.
 */
export function updateOpening(
  layout: HomeLayout,
  openingId: string,
  patch: OpeningPatch
): HomeLayout {
  return reconnectOpenings(layout, {
    ...layout,
    openings: layout.openings.map((opening) => {
      if (opening.id !== openingId) return opening;
      const next: Record<string, unknown> = { ...opening, ...patch };
      if (next.kind === 'window') {
        next.sillHeight ??= OPENING_DEFAULTS.window.sillHeight;
      } else {
        delete next.sillHeight;
      }
      if (!next.name) delete next.name;
      // A new position or width slides the opening along so it stays on its wall.
      const room = layout.rooms.find((candidate) => candidate.id === opening.wall.roomId);
      const wall = room && roomWalls(room)[opening.wall.index];
      if (wall && (patch.offset !== undefined || patch.width !== undefined)) {
        next.offset = fitOffset(next.offset as number, next.width as number, wall.length);
      }
      return next as Opening;
    }),
  });
}

/**
 * Where an opening centred at `offset` along a wall must go to stay on it. One wider than the wall
 * can't, so it goes in the middle, and the layout's checks report it.
 */
function fitOffset(offset: number, width: number, length: number): number {
  const [min, max] = [width / 2, length - width / 2];
  return max < min ? length / 2 : clamp(offset, min, max);
}

/**
 * Deletes a room or an opening. A room takes its openings with it, including doors in other rooms'
 * walls that led into it, along with the fixtures and devices placed in it.
 */
export function deleteItem(
  layout: HomeLayout,
  item: { kind: 'room' | 'opening'; id: string }
): HomeLayout {
  if (item.kind === 'opening') {
    return { ...layout, openings: layout.openings.filter((opening) => opening.id !== item.id) };
  }
  return {
    ...layout,
    rooms: layout.rooms.filter((room) => room.id !== item.id),
    openings: layout.openings.filter(
      (opening) => opening.wall.roomId !== item.id && opening.connects !== item.id
    ),
    fixtures: layout.fixtures.filter((fixture) => fixture.roomId !== item.id),
    devices: layout.devices.filter((device) => device.roomId !== item.id),
  };
}

/** An id based on `base` that no item in the layout uses yet. */
export function uniqueId(layout: HomeLayout, base: string): string {
  const used = new Set<string>([
    OUTSIDE,
    ...layout.floors.map((item) => item.id),
    ...layout.rooms.map((item) => item.id),
    ...layout.openings.map((item) => item.id),
    ...layout.fixtures.map((item) => item.id),
    ...layout.devices.map((item) => item.id),
  ]);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  }
}

export function findRoom(layout: HomeLayout, roomId: string): Room {
  const room = layout.rooms.find((candidate) => candidate.id === roomId);
  if (!room) throw new Error(`No room ${roomId}`);
  return room;
}

function nextRoomName(layout: HomeLayout): string {
  const names = new Set(layout.rooms.map((room) => room.name));
  for (let n = layout.rooms.length + 1; ; n++) {
    if (!names.has(`Room ${n}`)) return `Room ${n}`;
  }
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function boundsArea(outline: readonly Point2[]): number {
  const xs = outline.map(([x]) => x);
  const ys = outline.map(([, y]) => y);
  return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rounds away floating-point noise, so 0.1 + 0.2 is stored as 0.3. */
function roundTo(value: number, step = 1e-6): number {
  const rounded = Math.round(value / step) * step;
  return Number(rounded.toFixed(6)) + 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
