// The room logic of a guided capture, kept apart from the camera so it can be tested.

import { isSimplePolygon } from '@spatial-home/home-model';
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

/**
 * Whether the corners fail to make a proper room once it's closed: walls that cross or touch, a
 * corner visited twice, or a wall that doubles back. This is the check the home layout's own
 * validation makes, so a room the scan screen accepts is never replaced with its outer hull.
 */
export function crossesItself(corners: Vector3[]): boolean {
  return !isSimplePolygon(corners.map(([x, , z]) => [x, z] as const));
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
