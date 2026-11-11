import { createEmptyLayout, validateLayout, type HomeLayout } from '@spatial-home/home-model';
import sample from '@spatial-home/home-model/examples/sample-flat.json';
import { describe, expect, test } from 'vitest';
import { deleteItem } from '../src/editor/plan.ts';
import { editorReducer, initialState } from '../src/editor/state.ts';
import { selectionForIssue } from '../src/components/IssuesPanel.tsx';
import {
  addFixture,
  findPlacedDevice,
  fixtureCorners,
  fixturePreset,
  headingTowards,
  matchRoomsToAreas,
  moveThing,
  normalizeAngle,
  placeDevice,
  pointAt,
  setRoomArea,
  updateDevice,
  updateFixture,
  type DeviceSpec,
} from '../src/editor/things.ts';

function sampleFlat(): HomeLayout {
  const result = validateLayout(structuredClone(sample));
  if (!result.ok) throw new Error('sample flat is invalid');
  return result.layout;
}

const FLOOR = 'ground-floor';
const desk = fixturePreset('desk')!;

function expectValid(layout: HomeLayout) {
  const result = validateLayout(layout);
  expect(result.ok ? [] : result.errors).toEqual([]);
  expect(result.warnings).toEqual([]);
}

describe('furniture', () => {
  test('goes into the room it is dropped in, snapped to 5 cm', () => {
    const result = addFixture(sampleFlat(), FLOOR, desk, [2.53, 6.02]);
    if ('error' in result) throw new Error(result.error);
    const fixture = result.layout.fixtures.find((item) => item.id === result.id)!;
    expect(fixture).toMatchObject({
      name: 'Desk 2', // the sample flat already has a desk
      kind: 'desk',
      roomId: 'kitchen',
      position: [2.55, 6],
      size: { width: 1.2, depth: 0.6, height: 0.75 },
      rotation: 0,
    });
    expect(result.id).toBe('desk-2');
    expectValid(result.layout);
  });

  test('has to be dropped inside a room', () => {
    expect(addFixture(sampleFlat(), FLOOR, desk, [-3, -3])).toEqual({
      error: 'Put the desk inside a room.',
    });
    expect(addFixture(createEmptyLayout(), 'ground-floor', desk, [0, 0])).toHaveProperty('error');
  });

  test('changes room when moved into another one', () => {
    const moved = moveThing(sampleFlat(), { kind: 'fixture', id: 'sofa' }, [2.51, 6.04], FLOOR);
    expect(moved.fixtures.find((item) => item.id === 'sofa')).toMatchObject({
      roomId: 'kitchen',
      position: [2.5, 6.05],
    });
    // Outside every room it keeps its room, and the checks say it's outside.
    const outside = moveThing(sampleFlat(), { kind: 'fixture', id: 'sofa' }, [-2, -2], FLOOR);
    expect(outside.fixtures.find((item) => item.id === 'sofa')?.roomId).toBe('living-room');
    expect(validateLayout(outside).warnings.map((issue) => issue.code)).toEqual(['outside-room']);
  });

  test('turns to any angle, kept within 0 to 360', () => {
    const turned = updateFixture(sampleFlat(), 'sofa', { rotation: 450 });
    expect(turned.fixtures.find((item) => item.id === 'sofa')?.rotation).toBe(90);
    expect(updateFixture(sampleFlat(), 'sofa', { rotation: -90 }).fixtures[0]?.rotation).toBe(270);
  });

  test('has its front edge first, facing where it is turned', () => {
    const corners = fixtureCorners({
      position: [0, 0],
      size: { width: 2, depth: 1, height: 1 },
      rotation: 90,
    });
    // Turned to face the right of the plan, its front edge is on the right.
    expect(corners[0]![0]).toBeCloseTo(0.5);
    expect(corners[1]![0]).toBeCloseTo(0.5);
    expect(corners[2]![0]).toBeCloseTo(-0.5);
  });
});

const motionSpec: DeviceSpec = {
  name: 'Landing motion',
  ha: { deviceId: 'landing', entityIds: ['binary_sensor.landing_motion'] },
  coverage: [{ kind: 'motion', range: 7, fieldOfView: 110 }],
  height: 2.2,
  heading: 0,
};

describe('devices', () => {
  test('are placed in a room with their links and coverage', () => {
    const result = placeDevice(sampleFlat(), FLOOR, motionSpec, [2.02, 5.01]);
    if ('error' in result) throw new Error(result.error);
    expect(result.moved).toBeUndefined();
    expect(result.layout.devices.find((item) => item.id === result.id)).toEqual({
      id: 'landing-motion',
      name: 'Landing motion',
      roomId: 'kitchen',
      position: [2, 5, 2.2],
      heading: 0,
      coverage: [{ kind: 'motion', range: 7, fieldOfView: 110 }],
      ha: { deviceId: 'landing', entityIds: ['binary_sensor.landing_motion'] },
    });
    expectValid(result.layout);
  });

  test('on the ceiling sit just below it, and never above it', () => {
    const ceiling = placeDevice(
      sampleFlat(),
      FLOOR,
      { name: 'Pendant', height: 'ceiling' },
      [2, 5]
    );
    if ('error' in ceiling) throw new Error(ceiling.error);
    expect(ceiling.layout.devices.at(-1)?.position[2]).toBe(2.55);
    const tall = placeDevice(sampleFlat(), FLOOR, { name: 'Tall', height: 9 }, [2, 5]);
    if ('error' in tall) throw new Error(tall.error);
    expect(tall.layout.devices.at(-1)?.position[2]).toBe(2.6);
  });

  test('already in the layout are moved rather than placed twice', () => {
    const layout = sampleFlat();
    // The sample's reading lamp lists its entity but no device id.
    const result = placeDevice(
      layout,
      FLOOR,
      {
        name: 'Reading lamp',
        ha: { deviceId: 'reading_lamp', entityIds: ['light.reading_lamp'] },
        height: 1.5,
      },
      [2, 6]
    );
    if ('error' in result) throw new Error(result.error);
    expect(result).toMatchObject({ id: 'reading-lamp', moved: true });
    expect(result.layout.devices).toHaveLength(layout.devices.length);
    const lamp = result.layout.devices.find((item) => item.id === 'reading-lamp')!;
    // It keeps its height and coverage, and joins the room it was dropped in.
    expect(lamp).toMatchObject({ roomId: 'kitchen', position: [2, 6, 1.5] });
    expect(lamp.coverage).toEqual([{ kind: 'light', range: 2.5 }]);
  });

  test('are found by device id or by any entity', () => {
    const layout = sampleFlat();
    expect(findPlacedDevice(layout, { entityIds: ['sensor.hallway_motion_battery'] })?.id).toBe(
      'hallway-motion'
    );
    expect(findPlacedDevice(layout, { entityIds: ['light.nowhere'] })).toBeUndefined();
    const placed = placeDevice(layout, FLOOR, motionSpec, [2, 5]);
    if ('error' in placed) throw new Error(placed.error);
    expect(
      findPlacedDevice(placed.layout, { deviceId: 'landing', entityIds: ['x.renamed'] })?.id
    ).toBe('landing-motion');
  });

  test('have to be dropped inside a room', () => {
    expect(placeDevice(sampleFlat(), FLOOR, motionSpec, [20, 20])).toEqual({
      error: 'Put Landing motion inside a room.',
    });
  });

  test('keep their height when moved', () => {
    const moved = moveThing(sampleFlat(), { kind: 'device', id: 'hallway-motion' }, [1, 1], FLOOR);
    expect(moved.devices.find((item) => item.id === 'hallway-motion')).toMatchObject({
      roomId: 'living-room',
      position: [1, 1, 2.3],
    });
  });

  test('gain a heading when they gain a cone, and lose fields set to undefined', () => {
    const layout = sampleFlat();
    const coned = updateDevice(layout, 'reading-lamp', {
      coverage: [{ kind: 'light', range: 3, fieldOfView: 60 }],
    });
    expect(coned.devices.find((item) => item.id === 'reading-lamp')?.heading).toBe(0);
    expectValid(coned);

    const cleared = updateDevice(layout, 'hallway-motion', {
      tilt: undefined,
      coverage: [],
      ha: undefined,
    });
    const device = cleared.devices.find((item) => item.id === 'hallway-motion')!;
    expect(device).not.toHaveProperty('tilt');
    expect(device).not.toHaveProperty('coverage');
    expect(device).not.toHaveProperty('ha');
    expect(device.heading).toBe(180);
  });

  test('turn towards the cursor in 5° steps', () => {
    expect(headingTowards([0, 0], [1, 0])).toBe(90);
    expect(headingTowards([0, 0], [0, -1])).toBe(180);
    expect(headingTowards([0, 0], [-1, 1.02])).toBe(315);
    expect(headingTowards([0, 0], [-0.01, 1])).toBe(0);
    expect(normalizeAngle(-5)).toBe(355);
    const [x, y] = pointAt([1, 1], 90, 2);
    expect(x).toBeCloseTo(3);
    expect(y).toBeCloseTo(1);
  });
});

describe('rooms and areas', () => {
  test('link and unlink', () => {
    const linked = setRoomArea(sampleFlat(), 'hallway', 'landing');
    expect(linked.rooms.find((room) => room.id === 'hallway')?.ha).toEqual({ areaId: 'landing' });
    const unlinked = setRoomArea(linked, 'hallway', null);
    expect(unlinked.rooms.find((room) => room.id === 'hallway')).not.toHaveProperty('ha');
  });

  test('match by name, once per area, leaving linked rooms alone', () => {
    let layout = sampleFlat();
    for (const room of layout.rooms) layout = setRoomArea(layout, room.id, null);
    layout = setRoomArea(layout, 'kitchen', 'kitchen_old');
    const areas = [
      { area_id: 'kitchen', name: 'Kitchen' },
      { area_id: 'living', name: 'Living Room' },
      { area_id: 'bath', name: 'bathroom' },
      { area_id: 'bath_2', name: 'Bathroom' },
    ];
    const { layout: matched, linked } = matchRoomsToAreas(layout, areas);
    expect(linked).toBe(2);
    const areaOf = (id: string) => matched.rooms.find((room) => room.id === id)?.ha?.areaId;
    expect(areaOf('kitchen')).toBe('kitchen_old');
    expect(areaOf('living-room')).toBe('living');
    expect(areaOf('bathroom')).toBe('bath');
    expect(areaOf('bedroom')).toBeUndefined();
    expect(matchRoomsToAreas(matched, areas).linked).toBe(0);
  });
});

describe('selecting furniture and devices', () => {
  test('follows them across floors and drops them when they go', () => {
    const layout = sampleFlat();
    const withUpstairs: HomeLayout = {
      ...layout,
      floors: [...layout.floors, { id: 'first', name: 'First', level: 1, elevation: 3 }],
      rooms: [
        ...layout.rooms,
        {
          id: 'loft',
          name: 'Loft',
          floorId: 'first',
          outline: [
            [0, 0],
            [3, 0],
            [3, 3],
            [0, 3],
          ],
          ceilingHeight: 2.4,
        },
      ],
    };
    const moved = moveThing(withUpstairs, { kind: 'fixture', id: 'desk' }, [1, 1], 'first');
    let state = initialState(moved);
    state = editorReducer(state, { type: 'select', selection: { kind: 'fixture', id: 'desk' } });
    expect(state.floorId).toBe('first');
    state = editorReducer(state, {
      type: 'edit',
      layout: deleteItem(state.layout, { kind: 'fixture', id: 'desk' }),
    });
    expect(state.selection).toBeNull();
  });

  test('from the checks', () => {
    const outside = moveThing(sampleFlat(), { kind: 'device', id: 'reading-lamp' }, [-3, 0], FLOOR);
    const result = validateLayout(outside);
    const issue = result.warnings.find((item) => item.code === 'outside-room')!;
    expect(selectionForIssue(outside, issue)).toEqual({ kind: 'device', id: 'reading-lamp' });
  });

  test('are deleted on their own', () => {
    const layout = sampleFlat();
    const fewer = deleteItem(layout, { kind: 'device', id: 'reading-lamp' });
    expect(fewer.devices.map((item) => item.id)).not.toContain('reading-lamp');
    expect(fewer.rooms).toBe(layout.rooms);
    expect(deleteItem(layout, { kind: 'fixture', id: 'bed' }).fixtures).toHaveLength(
      layout.fixtures.length - 1
    );
  });
});
