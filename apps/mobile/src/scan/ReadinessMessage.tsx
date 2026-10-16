// What the scan screen says while the phone isn't ready to scan, and what the person can do.

import { Linking } from 'react-native';
import type { Readiness } from './readiness.ts';
import { Button, Centered } from './ui.tsx';

export function ReadinessMessage({
  readiness,
  install,
  askForCamera,
  retry,
}: {
  readiness: Exclude<Readiness, { kind: 'ready' }>;
  install(): void;
  askForCamera(): void;
  retry(): void;
}) {
  switch (readiness.kind) {
    case 'checking':
      return <Centered title="Checking this phone…" />;
    case 'still-checking':
      return (
        <Centered
          title="Still checking this phone"
          body="ARCore is taking a while to find out whether it supports this phone. This needs an internet connection the first time."
        >
          <Button label="Try again" onPress={retry} />
        </Centered>
      );
    case 'check-failed':
      return (
        <Centered
          title="Couldn’t check this phone"
          body="ARCore couldn’t find out whether it supports this phone. Check the internet connection and try again."
        >
          <Button label="Try again" onPress={retry} />
        </Centered>
      );
    case 'not-android':
      return (
        <Centered
          title="Scanning on this device isn’t ready yet"
          body="The Android scanner uses ARCore. iPhone scanning, with RoomPlan, is on its way."
        />
      );
    case 'not-included':
      return (
        <Centered
          title="This build can’t scan"
          body="Expo Go can’t load the scanner’s native code. Install a development build with `npm run android` in apps/mobile."
        />
      );
    case 'unsupported':
      return (
        <Centered
          title="This phone doesn’t support ARCore"
          body="Room scanning needs a phone on Google’s ARCore list. You can still draw your floor plan in the web editor."
        />
      );
    case 'needs-install':
      return (
        <Centered
          title={
            readiness.update
              ? 'Update Google Play Services for AR'
              : 'Install Google Play Services for AR'
          }
          body="Scanning uses Google’s free AR service. It installs from the Play Store."
        >
          <Button label={readiness.update ? 'Update' : 'Install'} onPress={install} />
        </Centered>
      );
    case 'camera-denied':
      return (
        <Centered
          title="Spatial Home needs the camera"
          body="The camera is how the phone measures the room. Nothing is recorded or uploaded."
        >
          {readiness.canAsk ? (
            <Button label="Allow the camera" onPress={askForCamera} />
          ) : (
            <Button label="Open settings" onPress={() => void Linking.openSettings()} />
          )}
        </Centered>
      );
  }
}
