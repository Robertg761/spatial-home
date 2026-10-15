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
  refreshCorners,
  wallLengths,
  type CapturedRoom,
  type PlacedCorner,
} from '../scan/guided.ts';
import { formatDistance, parseCeilingHeight, scanHint } from '../scan/hints.ts';
import { afterAvailability, afterInstall, type Readiness } from '../scan/readiness.ts';
import { shareJsonFile } from '../scan/share.ts';

const CHECK_INTERVAL = 500;
const CHECK_ATTEMPTS = 20;

/** Works out whether this phone can scan, installing ARCore and asking for the camera on the way. */
function useReadiness(): [Readiness, { install(): void; askForCamera(): void; retry(): void }] {
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
        now.kind === 'still-checking';
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

export default function ScanScreen() {
  const [readiness, { install, askForCamera, retry }] = useReadiness();

  return (
    <>
      <Stack.Screen options={{ title: 'Scan rooms' }} />
      {readiness.kind === 'ready' ? (
        <Scanner />
      ) : (
        <Message
          readiness={readiness}
          install={install}
          askForCamera={askForCamera}
          retry={retry}
        />
      )}
    </>
  );
}

function Message({
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
const RAISED_MESSAGE =
  'The corners are on a table or bed, not the floor. Undo them and place them where the walls meet the floor.';

/** A room scanned in this session, with its corners still anchored. */
interface ScannedRoom {
  name: string;
  corners: PlacedCorner[];
  ceilingHeight: number;
}

function capturedRoom(room: ScannedRoom): CapturedRoom {
  return { ...room, corners: room.corners.map((corner) => corner.point) };
}

function Scanner() {
  const insets = useSafeAreaInsets();
  const scanner = useRef<ArcoreScannerViewRef>(null);
  // Rooms keep their anchored corners until the end, so they all take ARCore's latest corrections.
  const [rooms, setRooms] = useState<ScannedRoom[]>([]);
  const [corners, setCorners] = useState<PlacedCorner[]>([]);
  const [roomName, setRoomName] = useState('');
  const [ceiling, setCeiling] = useState(DEFAULT_CEILING);
  const [tracking, setTracking] = useState<TrackingEvent | null>(null);
  const [aim, setAim] = useState<AimEvent | null>(null);
  const [error, setError] = useState<ScannerError | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  // A ref as well as state: two taps in a row can both run before React re-renders with busy set.
  const busyRef = useRef(false);
  const aimRef = useRef<AimEvent | null>(null);
  aimRef.current = aim;

  /** Runs one corner or room action at a time, ignoring taps while another is under way. */
  const exclusively = useCallback(async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const placeholderName = `Room ${rooms.length + 1}`;

  const closeRoom = useCallback(
    (roomCorners: PlacedCorner[]) => {
      if (aimRef.current?.cornersRaised) {
        Alert.alert('Corners on furniture', RAISED_MESSAGE);
        return;
      }
      const points = roomCorners.map((corner) => corner.point);
      if (points.length < 3) {
        Alert.alert('Not a room yet', 'A room needs at least three corners.');
        return;
      }
      if (floorArea(points) < MIN_ROOM_AREA) {
        Alert.alert(
          'Not a room yet',
          'These corners hardly enclose any floor. Undo and place them where the walls meet the floor.'
        );
        return;
      }
      if (crossesItself(points)) {
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

  /** The current room's corners, moved to where ARCore puts their anchors now. */
  const freshCorners = useCallback(async (): Promise<PlacedCorner[]> => {
    if (corners.length === 0) return corners;
    const positions = await scanner.current!.getCornerPositionsAsync(corners.map((c) => c.id));
    return refreshCorners(corners, positions);
  }, [corners]);

  const placeCorner = useCallback(
    () =>
      exclusively(async () => {
        if (!scanner.current) return;
        try {
          if (aimRef.current?.cornersRaised) {
            Alert.alert('Corners on furniture', RAISED_MESSAGE);
            return;
          }
          const point = await scanner.current.getAimAsync();
          if (!point) {
            Alert.alert('Point at the floor', 'Aim the crosshair where the walls meet the floor.');
            return;
          }
          const current = await freshCorners();
          const added = addCorner(
            current.map((corner) => corner.point),
            point
          );
          if (added.kind === 'added') {
            const id = await scanner.current.addCornerAsync(point);
            setCorners([...current, { id, point }]);
          } else if (added.kind === 'closes') closeRoom(current);
          else setCorners(current);
        } catch (error) {
          Alert.alert(
            'Couldn’t place the corner',
            error instanceof Error ? error.message : String(error)
          );
        }
      }),
    [exclusively, freshCorners, closeRoom]
  );

  const closeCurrentRoom = useCallback(
    () =>
      exclusively(async () => {
        try {
          closeRoom(await freshCorners());
        } catch (error) {
          Alert.alert(
            'Couldn’t close the room',
            error instanceof Error ? error.message : String(error)
          );
        }
      }),
    [exclusively, freshCorners, closeRoom]
  );

  const undoCorner = useCallback(
    () =>
      exclusively(async () => {
        const last = corners.at(-1);
        if (!last) return;
        setCorners(corners.slice(0, -1));
        await scanner.current?.removeCornersAsync([last.id]).catch(() => {});
      }),
    [exclusively, corners]
  );

  const finish = useCallback(
    () =>
      exclusively(async () => {
        if (!scanner.current) return;
        try {
          // Read every room's corners again, so earlier rooms take ARCore's latest corrections too.
          const all = rooms.flatMap((room) => room.corners);
          const positions = await scanner.current.getCornerPositionsAsync(all.map((c) => c.id));
          let next = 0;
          const updated = rooms.map((room) => {
            const fresh = refreshCorners(
              room.corners,
              positions.slice(next, next + room.corners.length)
            );
            next += room.corners.length;
            return { ...room, corners: fresh };
          });
          setRooms(updated);
          setResult(importScan(buildScan(updated.map(capturedRoom)), { name: 'My home' }));
        } catch (error) {
          Alert.alert('Couldn’t finish', error instanceof Error ? error.message : String(error));
        }
      }),
    [exclusively, rooms]
  );

  const View3d = ArcoreScannerView!;
  const points = corners.map((corner) => corner.point);
  const walls = wallLengths(points, false);

  return (
    <View style={styles.fill}>
      <View3d
        ref={scanner}
        style={StyleSheet.absoluteFill}
        // Kept running, not just mounted, while the result is shown: the person may walk to the next
        // room before tapping Scan another room, and ARCore has to keep tracking on the way so the
        // next room lines up with the ones already scanned.
        active
        cornerIds={corners.map((corner) => corner.id)}
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
            rooms={rooms.map(capturedRoom)}
            result={result}
            onScanMore={() => setResult(null)}
            onStartOver={() => {
              const ids = [...rooms, { corners }].flatMap((room) => room.corners.map((c) => c.id));
              void scanner.current?.removeCornersAsync(ids).catch(() => {});
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
              {error ? error.message : scanHint(tracking, aim, points)}
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
                disabled={busy || corners.length === 0}
                onPress={() => void undoCorner()}
              />
              <Button
                label="Add corner"
                grow
                disabled={busy || tracking?.state !== 'tracking'}
                onPress={() => void placeCorner()}
              />
              {corners.length >= 3 ? (
                <Button
                  label="Close room"
                  kind="secondary"
                  disabled={busy}
                  onPress={() => void closeCurrentRoom()}
                />
              ) : (
                <Button
                  label="Done"
                  kind="secondary"
                  disabled={busy || rooms.length === 0 || corners.length > 0}
                  onPress={() => void finish()}
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

  const share = (text: string, name: string) => {
    shareJsonFile(name, text).catch((error: unknown) =>
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
