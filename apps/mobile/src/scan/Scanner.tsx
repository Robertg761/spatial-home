// The scanning screen: the camera view, the crosshair and hints over it, and the controls for
// placing corners, closing rooms, and marking doors and windows on their walls.

import { importScan, type ImportResult } from '@spatial-home/scan-import';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  PermissionsAndroid,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ArcoreScannerView,
  type AimEvent,
  type ArcoreScannerViewRef,
  type ScannerError,
  type TrackingEvent,
  type WallPoint,
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
import { formatDistance, openingHint, parseCeilingHeight, scanHint } from './hints.ts';
import { markOpening, OPENING_NAMES, type MarkedOpening, type OpeningKind } from './openings.ts';
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

/** The rooms with their corners as last read and the openings marked on their walls. */
function capturedRooms(rooms: ScannedRoom[], openings: MarkedOpening[]): CapturedRoom[] {
  return rooms.map((room, index) => ({
    ...room,
    corners: room.corners.map((corner) => corner.point),
    openings: openings.filter((opening) => opening.room === index),
  }));
}

const OPENING_KINDS: OpeningKind[] = ['door', 'window', 'opening'];

/**
 * Asks for the camera again after it was taken away mid-scan, such as in Settings or when a one-time
 * permission ran out. The scan stays on screen, so the rooms already scanned are kept: the view
 * starts the camera again when the app comes back from the prompt or from Settings.
 */
async function allowCamera() {
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA);
  if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) await Linking.openSettings();
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
  // Doors and windows are marked on the walls of closed rooms, by room index into `rooms`.
  const [mode, setMode] = useState<'rooms' | 'openings'>('rooms');
  const [openingKind, setOpeningKind] = useState<OpeningKind>('door');
  const [openings, setOpenings] = useState<MarkedOpening[]>([]);
  const [pending, setPending] = useState<WallPoint | null>(null);
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
          setResult(importScan(buildScan(capturedRooms(updated, openings)), { name: 'My home' }));
        } catch (error) {
          Alert.alert('Couldn’t finish', error instanceof Error ? error.message : String(error));
        }
      }),
    [exclusively, rooms, openings]
  );

  /** Marks a corner of a door or window where the crosshair meets a wall. The second makes it. */
  const markCorner = useCallback(
    () =>
      exclusively(async () => {
        if (!scanner.current) return;
        try {
          const hit = await scanner.current.wallAimAsync();
          if (!hit) {
            Alert.alert('Point at a wall', 'Aim the crosshair at a wall of a room you’ve scanned.');
            return;
          }
          const point: WallPoint = {
            room: hit.room,
            wall: hit.wall,
            along: hit.along,
            height: hit.height,
          };
          if (!pending) {
            setPending(point);
            return;
          }
          const marked = markOpening(openingKind, pending, point, openings);
          if (!marked.ok) {
            Alert.alert(marked.title, marked.message);
            return;
          }
          setOpenings([...openings, marked.opening]);
          setPending(null);
        } catch (error) {
          Alert.alert(
            'Couldn’t mark the corner',
            error instanceof Error ? error.message : String(error)
          );
        }
      }),
    [exclusively, pending, openingKind, openings]
  );

  /** Takes back the first corner being marked, or else the last door or window. */
  const undoOpening = useCallback(() => {
    if (busyRef.current) return;
    if (pending) setPending(null);
    else setOpenings(openings.slice(0, -1));
  }, [pending, openings]);

  const wallRooms = useMemo(
    () =>
      rooms.map((room) => ({
        cornerIds: room.corners.map((corner) => corner.id),
        ceilingHeight: room.ceilingHeight,
      })),
    [rooms]
  );
  const openingRects = useMemo(
    () =>
      openings.map(({ room, wall, from, to, bottom, top }) => ({
        room,
        wall,
        from,
        to,
        bottom,
        top,
      })),
    [openings]
  );
  const marking = mode === 'openings';
  // The size of the door or window being marked, from its first corner to the crosshair.
  const markingSize =
    pending && aim?.wall && aim.wall.room === pending.room && aim.wall.wall === pending.wall
      ? {
          width: Math.abs(aim.wall.along - pending.along),
          height:
            openingKind === 'window'
              ? Math.abs(aim.wall.height - pending.height)
              : Math.max(aim.wall.height, pending.height),
        }
      : null;

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
        aimMode={marking ? 'walls' : 'floor'}
        wallRooms={wallRooms}
        openings={openingRects}
        pendingCorner={pending && { ...pending, toFloor: openingKind !== 'window' }}
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
            rooms={capturedRooms(rooms, openings)}
            result={result}
            onScanMore={() => setResult(null)}
            onStartOver={() => {
              const ids = [...rooms, { corners }].flatMap((room) => room.corners.map((c) => c.id));
              void scanner.current?.removeCornersAsync(ids).catch(() => {});
              setResult(null);
              setRooms([]);
              setCorners([]);
              setOpenings([]);
              setPending(null);
              setMode('rooms');
            }}
          />
        </View>
      ) : (
        <>
          <View pointerEvents="none" style={styles.crosshairBox}>
            <View
              style={[
                styles.crosshair,
                (marking ? aim?.wall : aim?.onFloor) && styles.crosshairOnFloor,
              ]}
            />
            {!marking && aim?.onFloor && aim.fromLast !== undefined ? (
              <Text style={styles.measure}>{formatDistance(aim.fromLast)}</Text>
            ) : null}
            {marking && markingSize ? (
              <Text style={styles.measure}>
                {formatDistance(markingSize.width)} × {formatDistance(markingSize.height)}
              </Text>
            ) : null}
          </View>

          <View style={[styles.top, { paddingTop: 12 }]}>
            <Text style={styles.hint}>
              {error
                ? error.message
                : marking
                  ? openingHint(tracking, aim, openingKind, pending)
                  : scanHint(tracking, aim, points)}
            </Text>
            {error?.code === 'camera-permission' ? (
              <Button label="Allow the camera" onPress={() => void allowCamera()} />
            ) : null}
            <Text style={styles.progress}>
              {rooms.length > 0
                ? `${rooms.length} room${rooms.length === 1 ? '' : 's'} done · `
                : ''}
              {marking
                ? `Doors and windows marked: ${openings.length}`
                : `${corners.length} corner${corners.length === 1 ? '' : 's'}`}
              {!marking && walls.length > 0 ? ` · last wall ${formatDistance(walls.at(-1)!)}` : ''}
            </Text>
          </View>

          {marking ? (
            <View style={[styles.panel, { paddingBottom: insets.bottom + 12 }]}>
              <View style={styles.row}>
                {OPENING_KINDS.map((kind) => (
                  <Button
                    key={kind}
                    label={OPENING_NAMES[kind].replace(/^./, (c) => c.toUpperCase())}
                    kind={openingKind === kind ? 'primary' : 'secondary'}
                    grow
                    onPress={() => setOpeningKind(kind)}
                  />
                ))}
              </View>
              <View style={styles.row}>
                <Button
                  label="Undo"
                  kind="secondary"
                  disabled={busy || (!pending && openings.length === 0)}
                  onPress={undoOpening}
                />
                <Button
                  label="Mark corner"
                  grow
                  disabled={busy || tracking?.state !== 'tracking'}
                  onPress={() => void markCorner()}
                />
                <Button
                  label="Rooms"
                  kind="secondary"
                  disabled={busy}
                  onPress={() => {
                    setPending(null);
                    setMode('rooms');
                  }}
                />
              </View>
            </View>
          ) : (
            <View style={[styles.panel, { paddingBottom: insets.bottom + 12 }]}>
              {rooms.length > 0 && corners.length === 0 ? (
                <Button
                  label="Mark doors and windows"
                  kind="secondary"
                  disabled={busy}
                  onPress={() => setMode('openings')}
                />
              ) : null}
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
                    disabled={busy || tracking?.state !== 'tracking'}
                    onPress={() => void closeCurrentRoom()}
                  />
                ) : (
                  <Button
                    label="Done"
                    kind="secondary"
                    disabled={
                      busy ||
                      tracking?.state !== 'tracking' ||
                      rooms.length === 0 ||
                      corners.length > 0
                    }
                    onPress={() => void finish()}
                  />
                )}
              </View>
            </View>
          )}
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
