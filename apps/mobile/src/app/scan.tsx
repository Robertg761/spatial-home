import { serializeLayout } from '@spatial-home/home-model';
import { importScan, type ImportResult, type Vector3 } from '@spatial-home/scan-import';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  AppState,
  Linking,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArcoreScannerView,
  getAvailabilityAsync,
  requestInstallAsync,
  scannerIncluded,
  type AimEvent,
  type ArcoreAvailability,
  type InstallResult,
  type ArcoreScannerViewRef,
  type ScannerError,
  type TrackingEvent,
} from '../../modules/arcore-scanner/index.ts';
import {
  addCorner,
  buildScan,
  crossesItself,
  floorArea,
  MIN_ROOM_AREA,
  wallLengths,
  type CapturedRoom,
} from '../scan/guided.ts';
import { formatDistance, parseCeilingHeight, scanHint } from '../scan/hints.ts';
import { afterAvailability, afterInstall, type Readiness } from '../scan/readiness.ts';

const CHECK_INTERVAL = 500;
const CHECK_ATTEMPTS = 20;

/** Works out whether this phone can scan, installing ARCore and asking for the camera on the way. */
function useReadiness(): [Readiness, { install(): void; askForCamera(): void }] {
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
        (now.kind === 'camera-denied' && !now.canAsk);
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

  return [readiness, { install: () => void install(), askForCamera: () => void askForCamera() }];
}

export default function ScanScreen() {
  const [readiness, { install, askForCamera }] = useReadiness();

  return (
    <>
      <Stack.Screen options={{ title: 'Scan rooms' }} />
      {readiness.kind === 'ready' ? (
        <Scanner />
      ) : (
        <Message readiness={readiness} install={install} askForCamera={askForCamera} />
      )}
    </>
  );
}

function Message({
  readiness,
  install,
  askForCamera,
}: {
  readiness: Exclude<Readiness, { kind: 'ready' }>;
  install(): void;
  askForCamera(): void;
}) {
  switch (readiness.kind) {
    case 'checking':
      return <Centered title="Checking this phone…" />;
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

const DEFAULT_CEILING = '2.40';

function Scanner() {
  const insets = useSafeAreaInsets();
  const scanner = useRef<ArcoreScannerViewRef>(null);
  const [rooms, setRooms] = useState<CapturedRoom[]>([]);
  const [corners, setCorners] = useState<Vector3[]>([]);
  const [roomName, setRoomName] = useState('');
  const [ceiling, setCeiling] = useState(DEFAULT_CEILING);
  const [tracking, setTracking] = useState<TrackingEvent | null>(null);
  const [aim, setAim] = useState<AimEvent | null>(null);
  const [error, setError] = useState<ScannerError | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);

  const placeholderName = `Room ${rooms.length + 1}`;

  const closeRoom = useCallback(
    (roomCorners: Vector3[]) => {
      if (roomCorners.length < 3) {
        Alert.alert('Not a room yet', 'A room needs at least three corners.');
        return;
      }
      if (floorArea(roomCorners) < MIN_ROOM_AREA) {
        Alert.alert(
          'Not a room yet',
          'These corners hardly enclose any floor. Undo and place them where the walls meet the floor.'
        );
        return;
      }
      if (crossesItself(roomCorners)) {
        Alert.alert(
          'The walls cross',
          'Two walls cross each other. Undo the last corner and try again.'
        );
        return;
      }
      const ceilingHeight = parseCeilingHeight(ceiling);
      if (ceilingHeight === null) {
        Alert.alert('Ceiling height', 'Enter the ceiling height in metres, between 1.8 and 6.');
        return;
      }
      setRooms((done) => [
        ...done,
        { name: roomName.trim() || placeholderName, corners: roomCorners, ceilingHeight },
      ]);
      setCorners([]);
      setRoomName('');
    },
    [ceiling, roomName, placeholderName]
  );

  const placeCorner = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const point = await scanner.current?.getAimAsync();
      if (!point) {
        Alert.alert('Point at the floor', 'Aim the crosshair where the walls meet the floor.');
        return;
      }
      const added = addCorner(corners, point);
      if (added.kind === 'added') setCorners(added.corners);
      else if (added.kind === 'closes') closeRoom(added.corners);
    } finally {
      setBusy(false);
    }
  }, [busy, corners, closeRoom]);

  const finish = useCallback(() => {
    setResult(importScan(buildScan(rooms), { name: 'My home' }));
  }, [rooms]);

  const View3d = ArcoreScannerView!;
  const walls = wallLengths(corners, false);

  return (
    <View style={styles.fill}>
      <View3d
        ref={scanner}
        style={StyleSheet.absoluteFill}
        // Paused, not unmounted, while reviewing: a new AR session would start a new world, and
        // the next room wouldn't line up with the ones already scanned.
        active={!result}
        corners={corners}
        onTrackingChange={(event) => {
          setTracking(event.nativeEvent);
          if (event.nativeEvent.state === 'tracking') setError(null);
        }}
        onAim={(event) => setAim(event.nativeEvent)}
        onError={(event) => setError(event.nativeEvent)}
      />

      {result ? (
        <View style={styles.reviewSheet}>
          <Review
            rooms={rooms}
            result={result}
            onScanMore={() => setResult(null)}
            onStartOver={() => {
              setResult(null);
              setRooms([]);
              setCorners([]);
            }}
          />
        </View>
      ) : (
        <>
          <View pointerEvents="none" style={styles.crosshairBox}>
            <View style={[styles.crosshair, aim?.onFloor && styles.crosshairOnFloor]} />
            {aim?.onFloor && aim.fromLast !== undefined ? (
              <Text style={styles.measure}>{formatDistance(aim.fromLast)}</Text>
            ) : null}
          </View>

          <View style={[styles.top, { paddingTop: 12 }]}>
            <Text style={styles.hint}>
              {error ? error.message : scanHint(tracking, aim, corners)}
            </Text>
            <Text style={styles.progress}>
              {rooms.length > 0
                ? `${rooms.length} room${rooms.length === 1 ? '' : 's'} done · `
                : ''}
              {corners.length} corner{corners.length === 1 ? '' : 's'}
              {walls.length > 0 ? ` · last wall ${formatDistance(walls.at(-1)!)}` : ''}
            </Text>
          </View>

          <View style={[styles.panel, { paddingBottom: insets.bottom + 12 }]}>
            <View style={styles.row}>
              <TextInput
                style={[styles.input, styles.grow]}
                value={roomName}
                onChangeText={setRoomName}
                placeholder={placeholderName}
                placeholderTextColor="#8a8f98"
              />
              <TextInput
                style={[styles.input, styles.ceiling]}
                value={ceiling}
                onChangeText={setCeiling}
                keyboardType="decimal-pad"
                accessibilityLabel="Ceiling height in metres"
              />
              <Text style={styles.unit}>m high</Text>
            </View>
            <View style={styles.row}>
              <Button
                label="Undo"
                kind="secondary"
                disabled={corners.length === 0}
                onPress={() => setCorners((current) => current.slice(0, -1))}
              />
              <Button
                label="Add corner"
                grow
                disabled={busy || tracking?.state !== 'tracking'}
                onPress={() => void placeCorner()}
              />
              {corners.length >= 3 ? (
                <Button label="Close room" kind="secondary" onPress={() => closeRoom(corners)} />
              ) : (
                <Button
                  label="Done"
                  kind="secondary"
                  disabled={rooms.length === 0 || corners.length > 0}
                  onPress={finish}
                />
              )}
            </View>
          </View>
        </>
      )}
    </View>
  );
}

function Review({
  rooms,
  result,
  onScanMore,
  onStartOver,
}: {
  rooms: CapturedRoom[];
  result: ImportResult;
  onScanMore(): void;
  onStartOver(): void;
}) {
  const insets = useSafeAreaInsets();

  const share = (message: string, title: string) => {
    Share.share({ message, title }).catch((error: unknown) =>
      Alert.alert('Couldn’t share', error instanceof Error ? error.message : String(error))
    );
  };

  const issues = result.ok
    ? [
        ...result.notes.map((note) => note.message),
        ...(result.validation.ok ? [] : result.validation.errors.map((issue) => issue.message)),
        ...result.validation.warnings.map((issue) => issue.message),
      ]
    : result.errors;

  return (
    <ScrollView contentContainerStyle={[styles.review, { paddingBottom: insets.bottom + 24 }]}>
      <Text style={styles.title}>
        {result.ok ? 'Your floor plan is ready' : 'The scan couldn’t be turned into a plan'}
      </Text>
      {rooms.map((room, index) => (
        <View key={index} style={styles.roomRow}>
          <Text style={styles.roomName}>{room.name}</Text>
          <Text style={styles.roomDetail}>
            {floorArea(room.corners).toFixed(1)} m² · {room.corners.length} walls ·{' '}
            {room.ceilingHeight.toFixed(2)} m ceiling
          </Text>
        </View>
      ))}
      {issues.length > 0 ? (
        <View style={styles.notes}>
          {issues.map((message, index) => (
            <Text key={index} style={styles.note}>
              • {message}
            </Text>
          ))}
        </View>
      ) : null}
      <Text style={styles.body}>
        Share the layout to open it in the web editor, where you can add doors, windows and devices.
      </Text>
      <View style={styles.actions}>
        {result.ok ? (
          <Button
            label="Share layout"
            onPress={() => share(serializeLayout(result.layout), 'home-layout.json')}
          />
        ) : null}
        <Button
          label="Share raw scan"
          kind="secondary"
          onPress={() => share(JSON.stringify(buildScan(rooms), null, 2), 'room-scan.json')}
        />
        <Button label="Scan another room" kind="secondary" onPress={onScanMore} />
        <Button
          label="Start over"
          kind="secondary"
          onPress={() =>
            Alert.alert('Start over?', 'The rooms you scanned will be lost.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Start over', style: 'destructive', onPress: onStartOver },
            ])
          }
        />
      </View>
    </ScrollView>
  );
}

function Centered({
  title,
  body,
  children,
}: {
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  return (
    <View style={styles.centered}>
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {children}
    </View>
  );
}

function Button({
  label,
  onPress,
  kind = 'primary',
  disabled = false,
  grow = false,
}: {
  label: string;
  onPress(): void;
  kind?: 'primary' | 'secondary';
  disabled?: boolean;
  grow?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        kind === 'secondary' && styles.buttonSecondary,
        grow && styles.grow,
        disabled && styles.buttonDisabled,
        pressed && styles.buttonPressed,
      ]}
    >
      <Text style={[styles.buttonLabel, kind === 'secondary' && styles.buttonLabelSecondary]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 20, fontWeight: '600', textAlign: 'center' },
  body: { fontSize: 15, color: '#444', textAlign: 'center', lineHeight: 21 },
  crosshairBox: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  crosshair: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: '#ffffffaa',
  },
  crosshairOnFloor: { borderColor: '#4ade80', backgroundColor: '#4ade8033' },
  measure: {
    marginTop: 8,
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    backgroundColor: '#000a',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
  },
  top: { position: 'absolute', left: 12, right: 12, top: 0, gap: 4 },
  hint: {
    color: '#fff',
    fontSize: 16,
    backgroundColor: '#000a',
    padding: 10,
    borderRadius: 10,
    overflow: 'hidden',
  },
  progress: { color: '#fff', fontSize: 13, textShadowColor: '#000', textShadowRadius: 4 },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: 12,
    gap: 10,
    backgroundColor: '#111c',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1 },
  input: {
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    color: '#111',
  },
  ceiling: { width: 64, textAlign: 'center' },
  unit: { color: '#fff', fontSize: 14 },
  button: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonSecondary: { backgroundColor: '#e5e7eb' },
  buttonDisabled: { opacity: 0.4 },
  buttonPressed: { opacity: 0.7 },
  buttonLabel: { color: '#fff', fontSize: 16, fontWeight: '600' },
  buttonLabelSecondary: { color: '#111' },
  reviewSheet: { ...StyleSheet.absoluteFill, backgroundColor: '#fff' },
  review: { padding: 24, gap: 12 },
  roomRow: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#ccc' },
  roomName: { fontSize: 16, fontWeight: '600' },
  roomDetail: { fontSize: 14, color: '#555' },
  notes: { backgroundColor: '#fef9c3', padding: 12, borderRadius: 8, gap: 4 },
  note: { fontSize: 14, color: '#713f12' },
  actions: { gap: 8 },
});
