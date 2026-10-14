import {
  OUTSIDE,
  createEmptyLayout,
  validateLayout,
  type HomeLayout,
} from '@spatial-home/home-model';
import sample from '@spatial-home/home-model/examples/sample-flat.json';
import { describe, expect, test } from 'vitest';
import {
  addOpening,
  addRoom,
  deleteItem,
  moveCorner,
  moveRoom,
  nearestWall,
  roomAcross,
  snapPoint,
  snapToGrid,
  uniqueId,
  updateOpening,
} from '../src/editor/plan.ts';

function sampleFlat(): HomeLayout {
  const result = validateLayout(structuredClone(sample));
  if (!result.ok) throw new Error('sample flat is invalid');
  return result.layout;
}

const FLOOR = 'ground-floor';

describe('snapping', () => {
  test('rounds to a 10 cm grid without floating-point noise', () => {
    expect(snapToGrid([1.234, -0.06])).toEqual([1.2, -0.1]);
    expect(snapToGrid([0.30000000000000004, 0.7])).toEqual([0.3, 0.7]);
  });

  test('prefers a nearby corner of another room', () => {
    const layout = sampleFlat();
    expect(snapPoint(layout, FLOOR, [5.07, 3.96], 0.2)).toEqual([5, 4]);
    expect(snapPoint(layout, FLOOR, [5.5, 3.96], 0.2)).toEqual([5.5, 4]);
  });
});

describe('walls', () => {
  test('finds the nearest wall within reach', () => {
    const layout = sampleFlat();
    const hit = nearestWall(layout, FLOOR, [0.05, 2], 0.2);
    expect(hit).toMatchObject({ roomId: 'living-room', wallIndex: 3, length: 4 });
    expect(hit?.offset).toBeCloseTo(2);
    expect(nearestWall(layout, FLOOR, [2.5, 2], 0.2)).toBeNull();
  });

  test('knows what is on the other side of a wall', () => {
    const layout = sampleFlat();
    // The living room's east wall backs onto the hallway; its west wall is an outside wall.
    expect(roomAcross(layout, 'living-room', 1, 2)).toBe('hallway');
    expect(roomAcross(layout, 'living-room', 3, 2)).toBe(OUTSIDE);
    expect(roomAcross(layout, 'living-room', 2, 3)).toBe('kitchen');
  });
});

describe('editing', () => {
  test('adds a room with a unique id and a valid outline', () => {
    let layout = createEmptyLayout();
    const first = addRoom(layout, 'ground-floor', [
      [0, 0],
      [3, 0],
      [3, 3],
      [0, 3],
    ]);
    const second = addRoom(
      first.layout,
      'ground-floor',
      [
        [3, 0],
        [6, 0],
        [6, 3],
        [3, 3],
      ],
      'Room 1'
    );
    layout = second.layout;
    expect([first.id, second.id]).toEqual(['room-1', 'room-1-2']);
    expect(validateLayout(layout).ok).toBe(true);
  });

  test('adds an opening that fits the wall and leads to the room behind it', () => {
    const layout = sampleFlat();
    const hit = nearestWall(layout, FLOOR, [5.02, 0.1], 0.2)!;
    const result = addOpening(layout, 'door', hit);
    expect('id' in result).toBe(true);
    if (!('id' in result)) return;
    const door = result.layout.openings.find((opening) => opening.id === result.id)!;
    // Shifted along the wall so that the whole door fits.
    expect(door.offset).toBe(0.4);
    expect(door.connects).toBe(hit.roomId === 'hallway' ? 'living-room' : 'hallway');
    expect(validateLayout(result.layout).ok).toBe(true);
  });

  test('an opening added at the end of a slanting wall stays on it', () => {
    const { layout } = addRoom(createEmptyLayout(), FLOOR, [
      [0, 0],
      [3, 2],
      [0, 2],
    ]);
    const length = Math.hypot(3, 2);
    const hit = { roomId: 'room-1', wallIndex: 0, offset: length, length, distance: 0 };
    const added = addOpening(layout, 'door', hit);
    if ('error' in added) throw new Error(added.error);
    expect(validateLayout(added.layout).ok).toBe(true);
  });

  test('refuses an opening wider than its wall', () => {
    const layout = addRoom(createEmptyLayout(), 'ground-floor', [
      [0, 0],
      [0.5, 0],
      [0.5, 2],
      [0, 2],
    ]).layout;
    const hit = nearestWall(layout, 'ground-floor', [0.25, 0], 0.2)!;
    expect(addOpening(layout, 'door', hit)).toEqual({
      error: expect.stringContaining('too short'),
    });
  });

  test('moves a room with its fixtures and devices, leaving the original untouched', () => {
    const layout = sampleFlat();
    const moved = moveRoom(layout, 'living-room', 0.3, -0.1);
    expect(moved.rooms[0]!.outline[0]).toEqual([0.3, -0.1]);
    expect(moved.fixtures.find((f) => f.id === 'sofa')!.position).toEqual([3.1, 0.5]);
    expect(moved.devices.find((d) => d.id === 'reading-lamp')!.position).toEqual([0.7, 3.5, 1.5]);
    expect(layout.rooms[0]!.outline[0]).toEqual([0, 0]);
  });

  test('moves one corner', () => {
    const moved = moveCorner(sampleFlat(), 'kitchen', 2, [5.5, 8.5]);
    expect(moved.rooms[1]!.outline).toEqual([
      [0, 4],
      [5, 4],
      [5.5, 8.5],
      [0, 8],
    ]);
  });

  test('moving a room updates where the openings on and into it lead', () => {
    const layout = sampleFlat();
    const leadsTo = (l: HomeLayout, id: string) => l.openings.find((o) => o.id === id)!.connects;
    const away = moveRoom(layout, 'living-room', -10, 0);
    expect(leadsTo(away, 'living-room-door')).toBe(OUTSIDE);
    expect(leadsTo(away, 'kitchen-arch')).toBe(OUTSIDE);
    expect(leadsTo(away, 'living-room-window')).toBe(OUTSIDE);
    // Moved back against the hallway and kitchen, the doors lead to it again.
    const back = moveRoom(away, 'living-room', 10, 0);
    expect(leadsTo(back, 'living-room-door')).toBe('living-room');
    expect(leadsTo(back, 'kitchen-arch')).toBe('kitchen');
  });

  test('moving a room keeps a destination set by hand', () => {
    const layout = updateOpening(sampleFlat(), 'living-room-window', { connects: 'kitchen' });
    const moved = moveRoom(layout, 'living-room', -10, 0);
    expect(moved.openings.find((o) => o.id === 'living-room-window')!.connects).toBe('kitchen');
  });

  test('moving a corner updates where the openings lead', () => {
    // Pulls the living room's north-east corner down, away from the kitchen.
    const moved = moveCorner(sampleFlat(), 'living-room', 2, [5, 1]);
    expect(moved.openings.find((o) => o.id === 'kitchen-arch')!.connects).toBe(OUTSIDE);
  });

  test('moving an opening along its wall updates where it leads', () => {
    // The hallway's west wall runs from the kitchen at its start to the living room at its end.
    const moved = updateOpening(sampleFlat(), 'living-room-door', { offset: 2 });
    expect(moved.openings.find((o) => o.id === 'living-room-door')!.connects).toBe('kitchen');
    const handSet = updateOpening(sampleFlat(), 'living-room-door', { connects: 'bathroom' });
    const kept = updateOpening(handSet, 'living-room-door', { offset: 2 });
    expect(kept.openings.find((o) => o.id === 'living-room-door')!.connects).toBe('bathroom');
  });

  test('a room drawn against an outside window is what the window looks into', () => {
    const { layout, id } = addRoom(sampleFlat(), FLOOR, [
      [-3, 0],
      [0, 0],
      [0, 4],
      [-3, 4],
    ]);
    expect(layout.openings.find((o) => o.id === 'living-room-window')!.connects).toBe(id);
    expect(layout.openings.find((o) => o.id === 'kitchen-window')!.connects).toBe(OUTSIDE);
  });

  test('a new position or width keeps an opening on its wall', () => {
    const offsetOf = (layout: HomeLayout) =>
      layout.openings.find((o) => o.id === 'living-room-door')!.offset;
    // The hallway's west wall is 8 m long, and the door 0.8 m wide.
    expect(offsetOf(updateOpening(sampleFlat(), 'living-room-door', { offset: 0 }))).toBe(0.4);
    expect(offsetOf(updateOpening(sampleFlat(), 'living-room-door', { width: 3 }))).toBe(6);
    expect(offsetOf(updateOpening(sampleFlat(), 'living-room-door', { width: 7 }))).toBe(4.5);
  });

  test('moving a corner leaves openings where they were on its walls', () => {
    // The living room's west wall runs from its north-west corner, which moves, to the south-west.
    const moved = moveCorner(sampleFlat(), 'living-room', 3, [0, 3]);
    const window = moved.openings.find((o) => o.id === 'living-room-window')!;
    expect(window.offset).toBe(1);
    expect(validateLayout(moved).ok).toBe(true);
    // A wall too short for the window keeps it in the middle, for the checks to report.
    const short = moveCorner(sampleFlat(), 'living-room', 3, [0, 1]);
    expect(short.openings.find((o) => o.id === 'living-room-window')!.offset).toBe(0.5);
    const result = validateLayout(short);
    expect(result.ok ? [] : result.errors.map((issue) => issue.code)).toEqual([
      'opening-outside-wall',
    ]);
  });

  test('switching an opening to a window adds a sill, and back removes it', () => {
    const layout = sampleFlat();
    const asWindow = updateOpening(layout, 'kitchen-door', { kind: 'window' });
    expect(asWindow.openings.find((o) => o.id === 'kitchen-door')).toMatchObject({
      kind: 'window',
      sillHeight: 0.9,
    });
    const asDoor = updateOpening(asWindow, 'kitchen-door', { kind: 'door' });
    expect(asDoor.openings.find((o) => o.id === 'kitchen-door')).not.toHaveProperty('sillHeight');
    expect(validateLayout(asDoor).ok).toBe(true);
  });

  test('an empty name removes it', () => {
    const renamed = updateOpening(sampleFlat(), 'front-door', { name: '' });
    expect(renamed.openings.find((o) => o.id === 'front-door')).not.toHaveProperty('name');
  });

  test('deleting a room takes its openings, the doors into it, and what is in it', () => {
    const layout = deleteItem(sampleFlat(), { kind: 'room', id: 'living-room' });
    expect(layout.rooms.map((room) => room.id)).not.toContain('living-room');
    expect(layout.openings.map((opening) => opening.id)).not.toEqual(
      expect.arrayContaining(['living-room-door', 'kitchen-arch', 'living-room-window'])
    );
    expect(layout.openings.some((opening) => opening.connects === 'living-room')).toBe(false);
    // So the openings left still lead to what is behind them.
    for (const { wall, offset, connects } of layout.openings) {
      expect(roomAcross(layout, wall.roomId, wall.index, offset)).toBe(connects);
    }
    expect(layout.fixtures.map((f) => f.id)).not.toContain('sofa');
    expect(layout.devices.map((d) => d.id)).not.toContain('reading-lamp');
    expect(validateLayout(layout).ok).toBe(true);
  });

  test('unique ids avoid every id in the layout and the reserved one', () => {
    const layout = sampleFlat();
    expect(uniqueId(layout, 'kitchen')).toBe('kitchen-2');
    expect(uniqueId(layout, 'outside')).toBe('outside-2');
    expect(uniqueId(layout, 'garage')).toBe('garage');
  });
});
