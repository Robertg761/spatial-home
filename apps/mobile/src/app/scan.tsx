import { Stack } from 'expo-router';
import { ReadinessMessage } from '../scan/ReadinessMessage.tsx';
import { Scanner } from '../scan/Scanner.tsx';
import { useReadiness } from '../scan/useReadiness.ts';

export default function ScanScreen() {
  const [readiness, { install, askForCamera, retry }] = useReadiness();

  return (
    <>
      <Stack.Screen options={{ title: 'Scan rooms' }} />
      {readiness.kind === 'ready' ? (
        <Scanner />
      ) : (
        <ReadinessMessage
          readiness={readiness}
          install={install}
          askForCamera={askForCamera}
          retry={retry}
        />
      )}
    </>
  );
}
