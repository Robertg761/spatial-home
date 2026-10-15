// The room logic of a guided capture, kept apart from the camera so it can be tested.

import type { ScanSessionInput, Vector3 } from '@spatial-home/scan-import';

/** How close, in metres, the crosshair must be to the first corner to close the room there. */
export const CLOSE_DISTANCE = 0.25;
/** Corners closer together than this are the same corner tapped twice. */
export const MIN_WALL = 0.1;
/** Floor area, in square metres, below which a room is a mistake rather than a cupboard. */
export const MIN_ROOM_AREA = 0.5;

export interface CapturedRoom {
  name: string;
  corners: Vector3[];
  ceilingHeight: number;
}

/** A corner anchored in the AR session, with where it was when last read. */
export interface PlacedCorner {
  id: number;
  point: Vector3;
}

/** The corners with their positions as just read, keeping the last known one for any missing. */
export function refreshCorners(
  corners: PlacedCorner[],
  positions: (Vector3 | null)[]
): PlacedCorner[] {
  return corners.map((corner, i) => ({ id: corner.id, point: positions[i] ?? corner.point }));
}

/** Distance along the floor between two points, ignoring height. */
export function floorDistance(a: Vector3, b: Vector3): number {
  return Math.hypot(b[0] - a[0], b[2] - a[2]);
}

/** Wall lengths between consecutive corners, and back to the first one when `closed`. */
export function wallLengths(corners: Vector3[], closed: boolean): number[] {
  const lengths = corners.slice(1).map((corner, i) => floorDistance(corners[i]!, corner));
  if (closed && corners.length >= 3) lengths.push(floorDistance(corners.at(-1)!, corners[0]!));
  return lengths;
}

/** Floor area enclosed by the corners, in square metres. */
export function floorArea(corners: Vector3[]): number {
  let twice = 0;
  corners.forEach((corner, i) => {
    const next = corners[(i + 1) % corners.length]!;
    twice += corner[0] * next[2] - next[0] * corner[2];
  });
  return Math.abs(twice) / 2;
}

export type AddCorner =
  | { kind: 'added'; corners: Vector3[] }
  | { kind: 'closes'; corners: Vector3[] }
  | { kind: 'too-close' };

/**
 * Adds the corner the crosshair is on. Aiming back at the first corner, once there are three, closes
 * the room instead of adding a fourth on top of the first.
 */
export function addCorner(corners: Vector3[], point: Vector3): AddCorner {
  const first = corners[0];
  if (first && corners.length >= 3 && floorDistance(point, first) <= CLOSE_DISTANCE) {
    return { kind: 'closes', corners };
  }
  const last = corners.at(-1);
  if (last && floorDistance(point, last) < MIN_WALL) return { kind: 'too-close' };
  return { kind: 'added', corners: [...corners, point] };
}

/** Whether walls between the corners would cross each other once the room is closed. */
export function crossesItself(corners: Vector3[]): boolean {
  const n = corners.length;
  if (n < 4) return false;
  const p = corners.map(([x, , z]) => [x, z] as const);
  const cross = (o: readonly number[], a: readonly number[], b: readonly number[]) =>
    (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const [a1, a2, b1, b2] = [p[i]!, p[(i + 1) % n]!, p[j]!, p[(j + 1) % n]!];
      const d1 = cross(b1, b2, a1);
      const d2 = cross(b1, b2, a2);
      const d3 = cross(a1, a2, b1);
      const d4 = cross(a1, a2, b2);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return false;
}

/** The room scan file for the rooms captured in one AR session. */
export function buildScan(rooms: CapturedRoom[]): ScanSessionInput {
  return {
    format: 'spatial-home/room-scan',
    version: 1,
    source: { platform: 'android-arcore', method: 'guided', app: 'spatial-home' },
    rooms: rooms.map((room) => ({
      name: room.name,
      outline: room.corners,
      ceilingHeight: room.ceilingHeight,
    })),
  };
}
