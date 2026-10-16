import {
  OUTSIDE,
  createEmptyLayout,
  validateLayout,
  type HomeLayout,
  type Point2,
} from '@spatial-home/home-model';
import sample from '@spatial-home/home-model/examples/sample-flat.json';
import { describe, expect, test } from 'vitest';
import {
  addMissingFloor,
  addOpening,
  addRoom,
  deleteItem,
  missingFloors,
  moveCorner,
  moveRoom,
  nearestWall,
  roomAcross,
  snapPoint,
  snapToGrid,
  uniqueId,
  uniqueIds,
  updateOpening,
  updateRoom,
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

  test('renames items whose ids are already used, keeping what refers to them', () => {
    const flat = sampleFlat();
    const kitchen = flat.rooms.find((room) => room.id === 'kitchen')!;
    const annex = { ...kitchen, outline: kitchen.outline.map(([x, y]) => [x + 20, y] as Point2) };
    const layout: HomeLayout = {
      ...flat,
      // A floor that shares the hallway's id comes first, so the hallway is the one renamed.
      floors: [...flat.floors, { id: 'hallway', name: 'Loft', level: 1, elevation: 3 }],
      rooms: [...flat.rooms, annex],
      openings: [...flat.openings, { ...flat.openings[0]! }],
    };
    expect(errorCodes(layout)).toContain('duplicate-id');

    const { layout: fixed, renamed } = uniqueIds(layout);
    expect(renamed).toBe(3);
    expect(errorCodes(fixed)).toEqual([]);
    expect(fixed.floors.map((floor) => floor.id)).toEqual(['ground-floor', 'hallway']);
    expect(fixed.rooms.map((room) => room.id)).toEqual([
      'living-room',
      'kitchen',
      'hallway-2',
      'bathroom',
      'bedroom',
      'kitchen-2',
    ]);
    expect(fixed.rooms.at(-1)!.outline).toEqual(annex.outline);
    // Only one room was called hallway, so what referred to it now refers to its new id.
    const door = (l: HomeLayout, id: string) => l.openings.find((o) => o.id === id)!;
    expect(door(fixed, 'kitchen-door').wall.roomId).toBe('hallway-2');
    expect(door(fixed, 'living-room-door').wall.roomId).toBe('hallway-2');
    // Two rooms were called kitchen, so a reference to it stays with the first.
    expect(door(fixed, 'kitchen-door').connects).toBe('kitchen');
    expect(fixed.openings.at(-1)!.id).toBe(`${flat.openings[0]!.id}-2`);
    // A layout without duplicates comes back as it was.
    expect(uniqueIds(flat)).toEqual({ layout: flat, renamed: 0 });
  });

  test('numbered ids stay within the longest an id can be, and unique', () => {
    const long = 'a'.repeat(100);
    const flat = sampleFlat();
    const room = flat.rooms[0]!;
    // Two rooms with the longest id, and a third whose id is what numbering would cut it to.
    const layout: HomeLayout = {
      ...flat,
      rooms: [
        ...flat.rooms,
        { ...room, id: long },
        { ...room, id: long },
        { ...room, id: `${'a'.repeat(98)}-2` },
      ],
    };
    expect(uniqueId(layout, long)).toBe(`${'a'.repeat(98)}-3`);
    const { layout: fixed } = uniqueIds(layout);
    const ids = fixed.rooms.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length <= 100)).toBe(true);
    expect(errorCodes(fixed)).not.toContain('invalid-too-big');
  });

  test('unique ids avoid every id in the layout and the reserved one', () => {
    const layout = sampleFlat();
    expect(uniqueId(layout, 'kitchen')).toBe('kitchen-2');
    expect(uniqueId(layout, 'outside')).toBe('outside-2');
    expect(uniqueId(layout, 'garage')).toBe('garage');
  });
});

describe('floors', () => {
  /** The sample with rooms on floors it doesn't have. */
  function onMissingFloors(): HomeLayout {
    const flat = sampleFlat();
    const floorOf: Record<string, string> = { bathroom: 'first-floor', bedroom: 'first-floor' };
    return {
      ...flat,
      rooms: flat.rooms.map((room) => ({ ...room, floorId: floorOf[room.id] ?? room.floorId })),
    };
  }

  test('lists the floors rooms are on that the layout is missing, once each', () => {
    expect(missingFloors(sampleFlat())).toEqual([]);
    const layout = onMissingFloors();
    expect(missingFloors(layout)).toEqual(['first-floor']);
    expect(missingFloors({ ...layout, floors: [] })).toEqual(['ground-floor', 'first-floor']);
    expect(errorCodes(layout)).toEqual(['unknown-floor', 'unknown-floor']);
  });

  test('adds a missing floor above the highest one, keeping its id', () => {
    const { layout, id } = addMissingFloor(onMissingFloors(), 'first-floor');
    expect(id).toBe('first-floor');
    // Above the ground floor by the height of its rooms.
    expect(layout.floors[1]).toEqual({
      id: 'first-floor',
      name: 'First floor',
      level: 1,
      elevation: 2.6,
    });
    expect(layout.rooms.find((room) => room.id === 'bedroom')!.floorId).toBe('first-floor');
    expect(errorCodes(layout)).toEqual([]);
  });

  test('a missing floor added to a layout without floors is the ground floor', () => {
    let layout: HomeLayout = { ...onMissingFloors(), floors: [] };
    layout = addMissingFloor(layout, 'ground-floor').layout;
    expect(layout.floors).toEqual([
      { id: 'ground-floor', name: 'Ground floor', level: 0, elevation: 0 },
    ]);
    layout = addMissingFloor(layout, 'first-floor').layout;
    expect(layout.floors[1]).toMatchObject({ level: 1, elevation: 2.6 });
    expect(errorCodes(layout)).toEqual([]);
  });

  test('a missing floor whose id another item has gets a new one, and its rooms move onto it', () => {
    const flat = sampleFlat();
    const layout = {
      ...flat,
      rooms: flat.rooms.map((room) =>
        room.id === 'bedroom' ? { ...room, floorId: 'kitchen' } : room
      ),
    };
    const { layout: fixed, id } = addMissingFloor(layout, 'kitchen');
    expect(id).toBe('kitchen-2');
    expect(fixed.floors.map((floor) => floor.id)).toEqual(['ground-floor', 'kitchen-2']);
    expect(fixed.rooms.find((room) => room.id === 'bedroom')!.floorId).toBe('kitchen-2');
    expect(fixed.rooms.find((room) => room.id === 'kitchen')!.floorId).toBe('ground-floor');
    expect(errorCodes(fixed)).toEqual([]);
  });

  test('names a missing floor from its id', () => {
    const name = (id: string) => addMissingFloor(sampleFlat(), id).layout.floors[1]!.name;
    expect(name('loft')).toBe('Loft');
    expect(name('L2_upper.east')).toBe('L2 upper east');
  });

  test('moving a room to another floor updates where the openings on and into it lead', () => {
    const flat = sampleFlat();
    const twoFloors = addMissingFloor(flat, 'first-floor').layout;
    const leadsTo = (l: HomeLayout, id: string) => l.openings.find((o) => o.id === id)!.connects;
    const moved = updateRoom(twoFloors, 'living-room', { floorId: 'first-floor' });
    expect(moved.rooms.find((room) => room.id === 'living-room')!.floorId).toBe('first-floor');
    // Nothing is behind the doors between it and the rooms it left, on either floor.
    expect(leadsTo(moved, 'living-room-door')).toBe(OUTSIDE);
    expect(leadsTo(moved, 'kitchen-arch')).toBe(OUTSIDE);
    // What is in it goes along.
    expect(moved.fixtures.filter((f) => f.roomId === 'living-room')).toEqual(
      flat.fixtures.filter((f) => f.roomId === 'living-room')
    );
    expect(errorCodes(moved)).toEqual([]);
    // Moved back, the doors lead to it again.
    const back = updateRoom(moved, 'living-room', { floorId: 'ground-floor' });
    expect(back.openings).toEqual(twoFloors.openings);
  });

  test('moving a room to another floor keeps a destination set by hand', () => {
    const twoFloors = addMissingFloor(sampleFlat(), 'first-floor').layout;
    const layout = updateOpening(twoFloors, 'living-room-window', { connects: 'hallway' });
    const moved = updateRoom(layout, 'living-room', { floorId: 'first-floor' });
    expect(moved.openings.find((o) => o.id === 'living-room-window')!.connects).toBe('hallway');
    const result = validateLayout(moved);
    expect(result.warnings.map((issue) => issue.code)).toContain('opening-between-floors');
  });
});

function errorCodes(layout: HomeLayout): string[] {
  const result = validateLayout(layout);
  return result.ok ? [] : result.errors.map((issue) => issue.code);
}
