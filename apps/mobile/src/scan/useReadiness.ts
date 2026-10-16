// Works out whether the phone can scan: ARCore's availability, its install, and the camera
// permission. The rules for each answer are in readiness.ts.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, PermissionsAndroid, Platform } from 'react-native';
import {
  getAvailabilityAsync,
  requestInstallAsync,
  scannerIncluded,
  type ArcoreAvailability,
  type InstallResult,
} from '../../modules/arcore-scanner/index.ts';
import { afterAvailability, afterInstall, type Readiness } from './readiness.ts';

const CHECK_INTERVAL = 500;
const CHECK_ATTEMPTS = 20;

/** Works out whether this phone can scan, installing ARCore and asking for the camera on the way. */
export function useReadiness(): [
  Readiness,
  { install(): void; askForCamera(): void; retry(): void },
] {
  const [readiness, setReadiness] = useState<Readiness>(() =>
    Platform.OS !== 'android'
      ? { kind: 'not-android' }
      : scannerIncluded
        ? { kind: 'checking' }
        : { kind: 'not-included' }
  );

  const askForCamera = useCallback(async () => {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA, {
      title: 'Camera',
      message:
        'Spatial Home uses the camera to measure your rooms. Nothing is recorded or uploaded.',
      buttonPositive: 'Continue',
    });
    if (result === PermissionsAndroid.RESULTS.GRANTED) setReadiness({ kind: 'ready' });
    else
      setReadiness({ kind: 'camera-denied', canAsk: result === PermissionsAndroid.RESULTS.DENIED });
  }, []);

  // ARCore wants to be told whether the person asked for an install: true the first time and when
  // they tap Install, false when looking again after the Play Store, so a refusal isn't asked twice.
  const userRequestedInstall = useRef(true);

  const requestInstall = useCallback(
    async (update: boolean) => {
      let result: InstallResult;
      try {
        result = await requestInstallAsync(userRequestedInstall.current);
      } catch (error) {
        Alert.alert(
          'Couldn’t set up ARCore',
          error instanceof Error ? error.message : String(error)
        );
        setReadiness({ kind: 'needs-install', update, waiting: false });
        return;
      }
      userRequestedInstall.current = result !== 'requested';
      const next = afterInstall(result, update);
      if (next !== 'ask-for-camera') {
        setReadiness(next);
        return;
      }
      const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA);
      if (granted) setReadiness({ kind: 'ready' });
      else await askForCamera();
    },
    [askForCamera]
  );

  const check = useCallback(async () => {
    let availability: ArcoreAvailability = 'checking';
    // ARCore can take a moment to find out, the first time, whether it supports this phone.
    for (let attempt = 0; availability === 'checking' && attempt < CHECK_ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL));
      availability = await getAvailabilityAsync();
    }
    const next = afterAvailability(availability);
    if (next === 'request-install') await requestInstall(false);
    else setReadiness(next);
  }, [requestInstall]);

  useEffect(() => {
    if (Platform.OS === 'android' && scannerIncluded) void check();
  }, [check]);

  // Coming back from the Play Store or the settings app: look again.
  const current = useRef(readiness);
  current.current = readiness;
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      const now = current.current;
      // Not while the camera prompt can still be shown: the prompt itself sends the app inactive.
      const changed =
        (now.kind === 'needs-install' && now.waiting) ||
        (now.kind === 'camera-denied' && !now.canAsk) ||
        now.kind === 'still-checking' ||
        now.kind === 'check-failed';
      if (state === 'active' && changed) {
        setReadiness({ kind: 'checking' });
        void check();
      }
    });
    return () => subscription.remove();
  }, [check]);

  const install = useCallback(async () => {
    const update = current.current.kind === 'needs-install' && current.current.update;
    userRequestedInstall.current = true;
    await requestInstall(update);
  }, [requestInstall]);

  const retry = useCallback(() => {
    setReadiness({ kind: 'checking' });
    void check();
  }, [check]);

  return [
    readiness,
    { install: () => void install(), askForCamera: () => void askForCamera(), retry },
  ];
}
