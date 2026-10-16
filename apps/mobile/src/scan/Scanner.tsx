// The scanning screen: the camera view, the crosshair and hints over it, and the controls for
// placing corners and closing rooms.

import { importScan, type ImportResult } from '@spatial-home/scan-import';
import { useCallback, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArcoreScannerView,
  type AimEvent,
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
} from './guided.ts';
import { formatDistance, parseCeilingHeight, scanHint } from './hints.ts';
import { Review } from './Review.tsx';
import { Button } from './ui.tsx';

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

export function Scanner() {
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
          // Anchored first, in the frame that found the aim, then kept only if the tap adds a corner.
          const shot = await scanner.current.anchorAimAsync(corners.map((c) => c.id));
          if (!shot) {
            Alert.alert('Point at the floor', 'Aim the crosshair where the walls meet the floor.');
            return;
          }
          const current = refreshCorners(corners, shot.corners);
          const added = shot.cornersRaised
            ? null
            : addCorner(
                current.map((corner) => corner.point),
                shot.point
              );
          if (added?.kind === 'added') {
            setCorners([...current, { id: shot.id, point: shot.point }]);
            return;
          }
          await scanner.current.removeCornersAsync([shot.id]);
          if (!added) Alert.alert('Corners on furniture', RAISED_MESSAGE);
          else if (added.kind === 'closes') closeRoom(current);
          else setCorners(current);
        } catch (error) {
          Alert.alert(
            'Couldn’t place the corner',
            error instanceof Error ? error.message : String(error)
          );
        }
      }),
    [exclusively, corners, closeRoom]
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

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
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
  reviewSheet: { ...StyleSheet.absoluteFill, backgroundColor: '#fff' },
});
