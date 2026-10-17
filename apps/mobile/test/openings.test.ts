import { importScan } from '@spatial-home/scan-import';
import { describe, expect, test } from 'vitest';
import type { Vector3, WallPoint } from '../modules/arcore-scanner/index.ts';
import { buildScan } from '../src/scan/guided.ts';
import { markOpening, scanOpening, type MarkedOpening } from '../src/scan/openings.ts';

const at = (wall: number, along: number, height: number, room = 0): WallPoint => ({
  room,
  wall,
  along,
  height,
});

describe('markOpening', () => {
  test('a door reaches the floor, from its two top corners', () => {
    expect(markOpening('door', at(1, 1.9, 2.02), at(1, 1.0, 2.05), [])).toEqual({
      ok: true,
      opening: { kind: 'door', room: 0, wall: 1, from: 1.0, to: 1.9, bottom: 0, top: 2.05 },
    });
  });

  test('a window runs between its two heights, from opposite corners', () => {
    expect(markOpening('window', at(0, 2.6, 2.1), at(0, 1.4, 0.9), [])).toEqual({
      ok: true,
      opening: { kind: 'window', room: 0, wall: 0, from: 1.4, to: 2.6, bottom: 0.9, top: 2.1 },
    });
  });

  test('both corners must be on one wall', () => {
    const result = markOpening('door', at(1, 1, 2), at(2, 0.2, 2), []);
    expect(result.ok).toBe(false);
    expect(markOpening('door', at(1, 1, 2), at(1, 2, 2, 1), []).ok).toBe(false);
  });

  test('a slip too small for the kind is refused', () => {
    // Two taps on nearly the same spot.
    expect(markOpening('window', at(0, 1, 1), at(0, 1.05, 1.5), []).ok).toBe(false);
    // A door's corners marked near the floor instead of at the top.
    expect(markOpening('door', at(0, 1, 0.1), at(0, 1.9, 0.05), []).ok).toBe(false);
  });

  test('openings can sit side by side or one above the other, but not overlap', () => {
    const door: MarkedOpening = {
      kind: 'door',
      room: 0,
      wall: 1,
      from: 1,
      to: 1.9,
      bottom: 0,
      top: 2,
    };
    expect(markOpening('window', at(1, 1.5, 1), at(1, 2.5, 1.8), [door]).ok).toBe(false);
    expect(markOpening('window', at(1, 1.9, 1), at(1, 2.5, 1.8), [door]).ok).toBe(true);
    // Above the door, as with a transom window.
    expect(markOpening('window', at(1, 1, 2), at(1, 1.9, 2.3), [door]).ok).toBe(true);
    // The same spot on another wall or in another room is fine.
    expect(markOpening('door', at(2, 1, 2), at(2, 1.9, 2), [door]).ok).toBe(true);
    expect(markOpening('door', at(1, 1, 2, 1), at(1, 1.9, 2, 1), [door]).ok).toBe(true);
  });
});

// A 4 × 3 m room and a 3 × 3 m room beside it, behind a 10 cm wall, on a floor 1.3 m below the
// phone's starting point.
const living: Vector3[] = [
  [0, -1.3, 0],
  [4, -1.3, 0],
  [4, -1.3, -3],
  [0, -1.3, -3],
];
const study: Vector3[] = [
  [4.1, -1.3, 0],
  [7.1, -1.3, 0],
  [7.1, -1.3, -3],
  [4.1, -1.3, -3],
];

test('scanOpening places the centre on the wall, at mid height', () => {
  const door: MarkedOpening = {
    kind: 'door',
    room: 0,
    wall: 1,
    from: 1,
    to: 1.9,
    bottom: 0,
    top: 2,
  };
  const scanned = scanOpening(door, living);
  expect(scanned.kind).toBe('door');
  expect(scanned.width).toBeCloseTo(0.9);
  expect(scanned.height).toBe(2);
  expect(scanned.center[0]).toBeCloseTo(4);
  expect(scanned.center[1]).toBeCloseTo(-0.3);
  expect(scanned.center[2]).toBeCloseTo(-1.45);
});

test('marked doors and windows come through the import on the right walls', () => {
  const door = markOpening('door', at(1, 1, 2), at(1, 1.9, 2), []);
  const window = markOpening('window', at(0, 1.4, 0.9), at(0, 2.6, 2.1), []);
  if (!door.ok || !window.ok) throw new Error('both should be marked');
  const result = importScan(
    buildScan([
      {
        name: 'Living room',
        corners: living,
        ceilingHeight: 2.4,
        openings: [door.opening, window.opening],
      },
      { name: 'Study', corners: study, ceilingHeight: 2.4 },
    ]),
    { name: 'Test home' }
  );
  if (!result.ok) throw new Error(result.errors.join('\n'));
  expect(result.validation.ok).toBe(true);
  const living_ = result.layout.rooms.find((room) => room.name === 'Living room')!;
  const study_ = result.layout.rooms.find((room) => room.name === 'Study')!;
  const doorOut = result.layout.openings.find((opening) => opening.kind === 'door')!;
  const windowOut = result.layout.openings.find((opening) => opening.kind === 'window')!;
  expect(doorOut.wall.roomId).toBe(living_.id);
  // The door is in the wall shared with the study, so it leads there.
  expect(doorOut.connects).toBe(study_.id);
  expect(doorOut.width).toBeCloseTo(0.9);
  expect(doorOut.height).toBeCloseTo(2);
  expect(windowOut.connects).toBe('outside');
  expect(windowOut.kind === 'window' && windowOut.sillHeight).toBeCloseTo(0.9);
  expect(windowOut.height).toBeCloseTo(1.2);
});
