import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ComponentType, Ref } from 'react';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';

/** A point in the AR session's world: metres, y up. */
export type Vector3 = [number, number, number];

export type ArcoreAvailability =
  'supported' | 'needs-install' | 'needs-update' | 'unsupported' | 'checking' | 'unknown';
export type InstallResult = 'installed' | 'requested' | 'declined' | 'unsupported';

export interface TrackingEvent {
  state: 'tracking' | 'paused' | 'stopped';
  reason:
    | 'none'
    | 'insufficient-light'
    | 'excessive-motion'
    | 'insufficient-features'
    | 'camera-unavailable'
    | 'bad-state';
  floorFound: boolean;
}

export interface AimEvent {
  /** Whether the crosshair is on the floor. */
  onFloor: boolean;
  point?: Vector3;
  /** Distance along the floor from the last corner placed, in metres. */
  fromLast?: number;
  /** Distance along the floor to the first corner, for closing the room. */
  toFirst?: number;
  /** The floor has turned up lower than the corners placed so far, which are on a table or bed. */
  cornersRaised?: boolean;
}

export interface ScannerError {
  code:
    | 'camera-permission'
    | 'arcore-not-installed'
    | 'arcore-too-old'
    | 'app-too-old'
    | 'device-not-supported'
    | 'camera-unavailable'
    | 'unknown';
  message: string;
}

export interface ArcoreScannerViewProps extends ViewProps {
  /** Runs the camera and AR session while true. */
  active: boolean;
  /** The current room's corners, by the ids `addCornerAsync` gave them, drawn joined by walls. */
  cornerIds: number[];
  onTrackingChange?: (event: NativeSyntheticEvent<TrackingEvent>) => void;
  onAim?: (event: NativeSyntheticEvent<AimEvent>) => void;
  onError?: (event: NativeSyntheticEvent<ScannerError>) => void;
}

export interface ArcoreScannerViewRef {
  /** Where the crosshair meets the floor now, or null when it isn't on the floor. */
  getAimAsync(): Promise<Vector3 | null>;
  /**
   * Anchors a corner at `point` and resolves with its id. An anchored corner stays on the same
   * spot on the floor as ARCore refines its map of the room, so read it again before using it.
   */
  addCornerAsync(point: Vector3): Promise<number>;
  /** Where the corners are now, in the same order, with null for any that were removed. */
  getCornerPositionsAsync(ids: number[]): Promise<(Vector3 | null)[]>;
  removeCornersAsync(ids: number[]): Promise<void>;
}

interface ArcoreScannerNativeModule {
  getAvailabilityAsync(): Promise<ArcoreAvailability>;
  requestInstallAsync(userRequested: boolean): Promise<InstallResult>;
}

// Absent on iPhone, on the web and in Expo Go, which can't load custom native code.
const native = requireOptionalNativeModule<ArcoreScannerNativeModule>('ArcoreScanner');

/** Whether this build of the app includes the Android scanner. */
export const scannerIncluded = native !== null;

export function getAvailabilityAsync(): Promise<ArcoreAvailability> {
  return native ? native.getAvailabilityAsync() : Promise.resolve('unsupported');
}

/**
 * Asks ARCore whether it's ready, installing or updating it if needed. Call it before every scan,
 * even when it's installed. `userRequested` is true the first time and when the person asks for an
 * install, and false when checking again after the Play Store.
 */
export function requestInstallAsync(userRequested = true): Promise<InstallResult> {
  return native ? native.requestInstallAsync(userRequested) : Promise.resolve('unsupported');
}

export const ArcoreScannerView: ComponentType<
  ArcoreScannerViewProps & { ref?: Ref<ArcoreScannerViewRef> }
> | null = native ? requireNativeView('ArcoreScanner') : null;
