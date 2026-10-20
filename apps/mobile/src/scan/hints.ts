// What the scanning screen tells the person holding the phone, kept apart from the screen so it can
// be tested.

import type { AimEvent, TrackingEvent, WallPoint } from '../../modules/arcore-scanner/index.ts';
import type { Vector3 } from '@spatial-home/scan-import';
import { CLOSE_DISTANCE } from './guided.ts';
import { OPENING_NAMES, type OpeningKind } from './openings.ts';

/** One line telling the person what to do next. */
export function scanHint(
  tracking: TrackingEvent | null,
  aim: AimEvent | null,
  corners: Vector3[]
): string {
  const lost = trackingHint(tracking);
  if (lost) return lost;
  if (!tracking!.floorFound && corners.length === 0) {
    return 'Point the camera at the floor and move the phone slowly to find it.';
  }
  if (aim?.cornersRaised && corners.length > 0) {
    return 'Those corners are on a table or bed, not the floor. Undo them and aim at the floor.';
  }
  if (!aim?.onFloor) return 'Point the crosshair at the floor.';
  if (corners.length === 0) {
    return 'Aim at a corner of the room where the walls meet the floor, then tap Add corner.';
  }
  if (corners.length >= 3 && aim.toFirst !== undefined && aim.toFirst <= CLOSE_DISTANCE) {
    return 'You’re back at the first corner. Tap Add corner to close the room.';
  }
  return 'Follow the wall to the next corner and tap Add corner.';
}

/** One line telling the person what to do next while marking doors and windows. */
export function openingHint(
  tracking: TrackingEvent | null,
  aim: AimEvent | null,
  kind: OpeningKind,
  pending: WallPoint | null
): string {
  const lost = trackingHint(tracking);
  if (lost) return lost;
  const name = OPENING_NAMES[kind];
  const wall = aim?.wall;
  if (!wall) return 'Point the crosshair at a wall of a room you’ve scanned.';
  if (!pending) {
    return kind === 'window'
      ? 'Aim at a bottom corner of the window, then tap Mark corner.'
      : `Aim at a top corner of the ${name}, then tap Mark corner.`;
  }
  if (wall.room !== pending.room || wall.wall !== pending.wall) {
    return 'That’s another wall. Aim at the wall the first corner is on.';
  }
  return kind === 'window'
    ? 'Now aim at the opposite top corner and tap Mark corner.'
    : `Now aim at the other top corner of the ${name} and tap Mark corner.`;
}

/** What to tell the person while ARCore isn't tracking, or null when it is. */
function trackingHint(tracking: TrackingEvent | null): string | null {
  if (!tracking || tracking.state === 'stopped') return 'Starting the camera…';
  if (tracking.state === 'paused') {
    switch (tracking.reason) {
      case 'insufficient-light':
        return 'It’s too dark to track. Turn on a light.';
      case 'excessive-motion':
        return 'Move the phone more slowly.';
      case 'insufficient-features':
        return 'Point the camera at something with more detail, like a rug or the edge of the floor.';
      case 'camera-unavailable':
        return 'Another app is using the camera.';
      default:
        return 'Move the phone slowly from side to side.';
    }
  }
  return null;
}

/** A distance for display, such as "2.35 m" or "85 cm". */
export function formatDistance(metres: number): string {
  return metres < 1 ? `${Math.round(metres * 100)} cm` : `${metres.toFixed(2)} m`;
}

/** Reads a ceiling height typed in metres, or null when it isn't a believable one. */
export function parseCeilingHeight(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'));
  if (!Number.isFinite(value) || value < 1.8 || value > 6) return null;
  return value;
}
