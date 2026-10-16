// Doors, windows and doorways marked on the walls of a guided capture, kept apart from the camera so
// the rules can be tested.

import type { Vector3 } from '@spatial-home/scan-import';
import type { WallPoint, WallRect } from '../../modules/arcore-scanner/index.ts';

/** What can be marked on a wall. "opening" is a doorway with no door, as in the room scan format. */
export type OpeningKind = 'door' | 'window' | 'opening';

/**
 * A door, window or doorway marked on a wall of a scanned room, as a rectangle on that wall: metres
 * along it from its first corner, and above the floor. It's kept relative to the wall, so it moves
 * with the wall's anchored corners as ARCore refines its map.
 */
export interface MarkedOpening extends WallRect {
  kind: OpeningKind;
}

/** The smallest of each kind, in metres, below which it's more likely a slip than an opening. */
export const MIN_OPENING_SIZE: Record<OpeningKind, { width: number; height: number }> = {
  door: { width: 0.4, height: 1.5 },
  opening: { width: 0.4, height: 1.5 },
  window: { width: 0.2, height: 0.2 },
};

export type MarkOpening =
  { ok: true; opening: MarkedOpening } | { ok: false; title: string; message: string };

export const OPENING_NAMES: Record<OpeningKind, string> = {
  door: 'door',
  window: 'window',
  opening: 'doorway',
};

/**
 * The opening between two opposite corners marked on a wall. A door or doorway reaches down to the
 * floor whatever corners were marked, so its two top corners do as well as opposite ones. A window
 * runs between the two heights.
 */
export function markOpening(
  kind: OpeningKind,
  first: WallPoint,
  second: WallPoint,
  marked: MarkedOpening[]
): MarkOpening {
  const name = OPENING_NAMES[kind];
  if (first.room !== second.room || first.wall !== second.wall) {
    return {
      ok: false,
      title: 'Different walls',
      message: `Both corners of the ${name} go on the same wall. Undo the first corner, or aim at the wall it's on.`,
    };
  }
  const from = Math.min(first.along, second.along);
  const to = Math.max(first.along, second.along);
  const top = Math.max(first.height, second.height);
  const bottom = kind === 'window' ? Math.min(first.height, second.height) : 0;
  const least = MIN_OPENING_SIZE[kind];
  if (to - from < least.width || top - bottom < least.height) {
    return {
      ok: false,
      title: `Too small for a ${name}`,
      message:
        kind === 'window'
          ? 'Mark a bottom corner of the window, then the opposite top corner.'
          : `Mark the two top corners of the ${name}.`,
    };
  }
  const overlapped = marked.find(
    (other) =>
      other.room === first.room &&
      other.wall === first.wall &&
      from < other.to - OVERLAP_SLACK &&
      other.from < to - OVERLAP_SLACK &&
      bottom < other.top - OVERLAP_SLACK &&
      other.bottom < top - OVERLAP_SLACK
  );
  if (overlapped) {
    return {
      ok: false,
      title: 'Already marked',
      message: `This overlaps the ${OPENING_NAMES[overlapped.kind]} already marked on this wall. Undo that one first to mark it again.`,
    };
  }
  return { ok: true, opening: { kind, room: first.room, wall: first.wall, from, to, bottom, top } };
}

/** How far, in metres, two openings can overlap and still be taken as side by side. */
const OVERLAP_SLACK = 0.02;

/** The opening as the room scan format has it, from where the room's corners are now. */
export function scanOpening(
  opening: MarkedOpening,
  corners: Vector3[]
): { kind: OpeningKind; center: Vector3; width: number; height: number } {
  const a = corners[opening.wall]!;
  const b = corners[(opening.wall + 1) % corners.length]!;
  const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const t = length > 0 ? Math.min(1, Math.max(0, (opening.from + opening.to) / 2 / length)) : 0;
  const lerp = (i: number) => a[i]! + (b[i]! - a[i]!) * t;
  return {
    kind: opening.kind,
    center: [lerp(0), lerp(1) + (opening.bottom + opening.top) / 2, lerp(2)],
    width: opening.to - opening.from,
    height: opening.top - opening.bottom,
  };
}
