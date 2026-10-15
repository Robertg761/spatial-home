// Whether the phone is ready to scan, kept apart from the screen so the install rules can be tested.

import type { ArcoreAvailability, InstallResult } from '../../modules/arcore-scanner/index.ts';

export type Readiness =
  | { kind: 'checking' }
  /** ARCore is still finding out whether it supports the phone; it says to ask again soon. */
  | { kind: 'still-checking' }
  /** ARCore couldn't find out, often because the phone is offline. Nothing is known about the phone. */
  | { kind: 'check-failed' }
  | { kind: 'not-android' }
  | { kind: 'not-included' }
  | { kind: 'unsupported' }
  | { kind: 'needs-install'; update: boolean; waiting: boolean }
  | { kind: 'camera-denied'; canAsk: boolean }
  | { kind: 'ready' };

/**
 * What to do once ARCore has said whether it supports the phone. Even when Google Play Services
 * for AR is installed, ARCore wants `requestInstall` to say it's ready before a session starts,
 * because that call also fetches the phone's calibration data.
 */
export function afterAvailability(availability: ArcoreAvailability): 'request-install' | Readiness {
  switch (availability) {
    case 'supported':
      return 'request-install';
    case 'needs-install':
    case 'needs-update':
      return { kind: 'needs-install', update: availability === 'needs-update', waiting: false };
    case 'checking':
      return { kind: 'still-checking' };
    case 'unknown':
      return { kind: 'check-failed' };
    case 'unsupported':
      return { kind: 'unsupported' };
  }
}

/** What to do with ARCore's answer to `requestInstall`. */
export function afterInstall(result: InstallResult, update: boolean): 'ask-for-camera' | Readiness {
  switch (result) {
    case 'installed':
      return 'ask-for-camera';
    case 'requested':
      return { kind: 'needs-install', update, waiting: true };
    case 'declined':
      return { kind: 'needs-install', update, waiting: false };
    case 'unsupported':
      return { kind: 'unsupported' };
  }
}
