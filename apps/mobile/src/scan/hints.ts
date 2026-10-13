// What the scanning screen tells the person holding the phone, kept apart from the screen so it can
// be tested.

import type { AimEvent, TrackingEvent } from '../../modules/arcore-scanner/index.ts';
import type { Vector3 } from '@spatial-home/scan-import';
import { CLOSE_DISTANCE } from './guided.ts';

/** One line telling the person what to do next. */
export function scanHint(
  tracking: TrackingEvent | null,
  aim: AimEvent | null,
  corners: Vector3[]
): string {
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
  if (!tracking.floorFound && corners.length === 0) {
    return 'Point the camera at the floor and move the phone slowly to find it.';
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
