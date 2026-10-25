import { validateLayout, type HomeLayout } from '@spatial-home/home-model';
import sample from '@spatial-home/home-model/examples/sample-flat.json';
import { describe, expect, test } from 'vitest';
import { buildModel3D, wallPieces, type WallPiece } from '../src/editor/model3d.ts';
import { addMissingFloor } from '../src/editor/plan.ts';

function sampleFlat(): HomeLayout {
  const result = validateLayout(structuredClone(sample));
  if (!result.ok) throw new Error('sample flat is invalid');
  return result.layout;
}

const FLOOR = 'ground-floor';

function wallOf(model: ReturnType<typeof buildModel3D>, roomId: string, wallIndex: number) {
  return model.walls
    .filter((piece) => piece.roomId === roomId && piece.wallIndex === wallIndex)
    .map(({ start, end, bottom, top }: WallPiece) => ({ start, end, bottom, top }));
}

describe('wall pieces', () => {
  test('a wall without openings is one piece', () => {
    expect(wallPieces(4, 2.5, [])).toEqual([{ from: 0, to: 4, bottom: 0, top: 2.5 }]);
  });

  test('a door leaves the wall either side and the part above it', () => {
    expect(wallPieces(4, 2.5, [{ from: 1, to: 2, bottom: 0, top: 2 }])).toEqual([
      { from: 0, to: 1, bottom: 0, top: 2.5 },
      { from: 1, to: 2, bottom: 2, top: 2.5 },
      { from: 2, to: 4, bottom: 0, top: 2.5 },
    ]);
  });

  test('a window leaves the wall below and above it', () => {
    expect(wallPieces(4, 2.5, [{ from: 1, to: 3, bottom: 0.9, top: 2.1 }])).toEqual([
      { from: 0, to: 1, bottom: 0, top: 2.5 },
      { from: 1, to: 3, bottom: 0, top: 0.9 },
      { from: 1, to: 3, bottom: 2.1, top: 2.5 },
      { from: 3, to: 4, bottom: 0, top: 2.5 },
    ]);
  });

  test('overlapping openings leave one hole, and one reaching the ceiling leaves nothing above', () => {
    expect(
      wallPieces(4, 2.5, [
        { from: 0, to: 2, bottom: 0, top: 2 },
        { from: 1, to: 3, bottom: 1, top: 2.5 },
      ])
    ).toEqual([
      { from: 0, to: 1, bottom: 2, top: 2.5 },
      { from: 2, to: 3, bottom: 0, top: 1 },
      { from: 3, to: 4, bottom: 0, top: 2.5 },
    ]);
  });
});

describe('the 3D model', () => {
  test('has every room, fixture and device of the sample flat', () => {
    const layout = sampleFlat();
    const model = buildModel3D(layout, FLOOR);
    expect(model.rooms.map((room) => room.id)).toEqual(layout.rooms.map((room) => room.id));
    expect(model.fixtures).toHaveLength(layout.fixtures.length);
    expect(model.devices).toHaveLength(layout.devices.length);
    expect(model.panes.map((pane) => pane.openingId).sort()).toEqual(
      layout.openings
        .filter((opening) => opening.kind === 'window')
        .map((opening) => opening.id)
        .sort()
    );
  });

  test('cuts a door out of both rooms it joins', () => {
    const model = buildModel3D(sampleFlat(), FLOOR);
    // The hallway's west wall runs down x = 5 from y = 8, with the kitchen door 2 m along it and the
    // living room door 6 m along it.
    const hallwayWest = wallOf(model, 'hallway', 3);
    expect(hallwayWest).toHaveLength(5);
    expect(hallwayWest[1]!.start[1]).toBeCloseTo(6.4);
    expect(hallwayWest[1]!.end[1]).toBeCloseTo(5.6);
    expect(hallwayWest[1]!.bottom).toBeCloseTo(2.1);
    // The kitchen's east wall runs up x = 5 from y = 4, so it has the same gap 1.6 m along it.
    const kitchenEast = wallOf(model, 'kitchen', 1);
    expect(kitchenEast).toHaveLength(3);
    expect(kitchenEast[0]!.start).toEqual([5, 4]);
    expect(kitchenEast[0]!.end[1]).toBeCloseTo(5.6);
    expect(kitchenEast[1]!.end[1]).toBeCloseTo(6.4);
    expect(kitchenEast[1]!.bottom).toBeCloseTo(2.1);
    expect(kitchenEast[2]!.end).toEqual([5, 8]);
  });

  test('cuts an open passage out of both rooms it joins, all the way up to its top', () => {
    const model = buildModel3D(sampleFlat(), FLOOR);
    // The arch to the kitchen is in the living room's north wall, which the kitchen's south wall
    // runs along.
    for (const [roomId, wallIndex] of [
      ['living-room', 2],
      ['kitchen', 0],
    ] as const) {
      const pieces = wallOf(model, roomId, wallIndex);
      expect(pieces).toHaveLength(3);
      expect(pieces[1]!.bottom).toBeCloseTo(2.2);
    }
  });

  test("doesn't cut a door into a room it doesn't lead to", () => {
    const model = buildModel3D(sampleFlat(), FLOOR);
    // The front door leads outside, so no other room's wall opens for it.
    const living = wallOf(model, 'living-room', 0);
    expect(living).toEqual([{ start: [0, 0], end: [5, 0], bottom: 0, top: 2.6 }]);
  });

  test('puts walls on the outside of the room', () => {
    const model = buildModel3D(sampleFlat(), FLOOR);
    const south = model.walls.find(
      (piece) => piece.roomId === 'living-room' && piece.wallIndex === 0
    );
    expect(south?.normal).toEqual([0, -1]);
  });

  test('shows the floor being edited and those below it, raised to their elevation', () => {
    const layout = sampleFlat();
    const upstairs: HomeLayout = {
      ...layout,
      floors: [
        ...layout.floors,
        { id: 'first-floor', name: 'First floor', level: 1, elevation: 3 },
      ],
      rooms: [
        ...layout.rooms,
        {
          id: 'loft',
          name: 'Loft',
          floorId: 'first-floor',
          outline: [
            [0, 0],
            [4, 0],
            [4, 4],
            [0, 4],
          ],
          ceilingHeight: 2.4,
        },
      ],
    };
    expect(buildModel3D(upstairs, FLOOR).rooms.map((room) => room.id)).not.toContain('loft');
    const model = buildModel3D(upstairs, 'first-floor');
    expect(model.rooms.find((room) => room.id === 'loft')?.elevation).toBe(3);
    expect(wallOf(model, 'loft', 0)).toEqual([{ start: [0, 0], end: [4, 0], bottom: 3, top: 5.4 }]);
  });

  test('puts rooms on a missing floor at ground level', () => {
    const layout = sampleFlat();
    const orphaned: HomeLayout = {
      ...layout,
      rooms: layout.rooms.map((room) =>
        room.id === 'bedroom' ? { ...room, floorId: 'attic' } : room
      ),
    };
    expect(
      buildModel3D(orphaned, 'attic').rooms.find((room) => room.id === 'bedroom')?.elevation
    ).toBe(0);
    // Once the floor is added it sits above the ground floor, and the room goes with it.
    const { layout: repaired } = addMissingFloor(orphaned, 'attic');
    const attic = buildModel3D(repaired, 'attic').rooms.find((room) => room.id === 'bedroom');
    expect(attic?.elevation).toBeGreaterThan(0);
  });
});
