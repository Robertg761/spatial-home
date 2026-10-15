import type { Point2 } from '@spatial-home/home-model';
import type { ScanSessionInput, Vector3 } from '../src/scan.ts';

/**
 * Places a point described on a north-up plan (x east, y north) into an AR session whose world -z
 * axis points at compass bearing `worldNorth`, as a phone would have recorded it.
 */
export function toWorld([x, y]: Point2, height: number, worldNorth: number): Vector3 {
  const angle = (worldNorth * Math.PI) / 180;
  // A direction's bearing in the session is its true bearing minus worldNorth, which on the plan
  // is a turn anticlockwise by worldNorth.
  const wx = x * Math.cos(angle) - y * Math.sin(angle);
  const wy = x * Math.sin(angle) + y * Math.cos(angle);
  return [wx, height, -wy];
}

/** Walls around a north-up outline, as RoomPlan reports them: ends that miss the corners a little. */
export function wallsAround(
  outline: Point2[],
  height: number,
  worldNorth: number,
  floor = 0,
  jitter = 0.04
) {
  return outline.map((start, i) => {
    const end = outline[(i + 1) % outline.length]!;
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const length = Math.hypot(dx, dy);
    // Alternately stop short of and overshoot the corners, and wobble sideways.
    const shrink = i % 2 === 0 ? jitter : -jitter;
    const side = (i % 3) * 0.01;
    const s: Point2 = [
      start[0] + (dx / length) * shrink - (dy / length) * side,
      start[1] + (dy / length) * shrink + (dx / length) * side,
    ];
    const e: Point2 = [
      end[0] - (dx / length) * shrink - (dy / length) * side,
      end[1] - (dy / length) * shrink + (dx / length) * side,
    ];
    return { start: toWorld(s, floor, worldNorth), end: toWorld(e, floor, worldNorth), height };
  });
}

export function session(rooms: ScanSessionInput['rooms'], worldNorth?: number): ScanSessionInput {
  return {
    format: 'spatial-home/room-scan',
    version: 1,
    source: { platform: 'test' },
    ...(worldNorth === undefined ? {} : { worldNorth }),
    rooms,
  };
}
