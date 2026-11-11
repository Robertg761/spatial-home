// Edits that place things in rooms: furniture (fixtures) and devices. Like the edits in plan.ts,
// each returns a new layout and leaves the one it was given untouched, so undo can keep the old one.

import {
  planHeading,
  type Coverage,
  type Device,
  type Fixture,
  type HomeLayout,
  type Point2,
} from '@spatial-home/home-model';
import { roomAt, roundTo, slug, snapToGrid, uniqueId } from './plan.ts';

/** Furniture and devices snap to a finer grid than walls, as they rarely line up with a wall. */
export const THING_GRID_STEP = 0.05;
/** Headings and rotations set by dragging snap to this many degrees. */
export const ANGLE_STEP = 5;

export interface FixturePreset {
  kind: string;
  label: string;
  size: Fixture['size'];
}

/** The furniture the editor offers, with typical sizes in metres. */
export const FIXTURE_PRESETS: readonly FixturePreset[] = [
  { kind: 'bed', label: 'Bed', size: { width: 1.6, depth: 2, height: 0.5 } },
  { kind: 'sofa', label: 'Sofa', size: { width: 2.2, depth: 0.9, height: 0.8 } },
  { kind: 'armchair', label: 'Armchair', size: { width: 0.8, depth: 0.8, height: 1 } },
  { kind: 'desk', label: 'Desk', size: { width: 1.2, depth: 0.6, height: 0.75 } },
  { kind: 'table', label: 'Table', size: { width: 1.6, depth: 0.9, height: 0.75 } },
  { kind: 'chair', label: 'Chair', size: { width: 0.5, depth: 0.5, height: 0.9 } },
  { kind: 'tv', label: 'TV', size: { width: 1.2, depth: 0.1, height: 0.7 } },
  { kind: 'wardrobe', label: 'Wardrobe', size: { width: 1, depth: 0.6, height: 2 } },
  { kind: 'counter', label: 'Kitchen counter', size: { width: 2, depth: 0.6, height: 0.9 } },
  { kind: 'bath', label: 'Bath', size: { width: 1.7, depth: 0.75, height: 0.6 } },
  { kind: 'shower', label: 'Shower', size: { width: 0.9, depth: 0.9, height: 2 } },
  { kind: 'toilet', label: 'Toilet', size: { width: 0.4, depth: 0.7, height: 0.8 } },
];

export function fixturePreset(kind: string): FixturePreset | undefined {
  return FIXTURE_PRESETS.find((preset) => preset.kind === kind);
}

export type PlaceResult = { layout: HomeLayout; id: string } | { error: string };

/** Adds a piece of furniture from a preset, centred on a point inside a room on the floor. */
export function addFixture(
  layout: HomeLayout,
  floorId: string,
  preset: FixturePreset,
  point: Point2
): PlaceResult {
  const position = snapToGrid(point, THING_GRID_STEP);
  const room = roomAt(layout, floorId, position) ?? roomAt(layout, floorId, point);
  if (!room) return { error: `Put the ${preset.label.toLowerCase()} inside a room.` };
  const name = nextName(
    layout.fixtures.map((fixture) => fixture.name),
    preset.label
  );
  const id = uniqueId(layout, slug(name) || 'fixture');
  const fixture: Fixture = {
    id,
    name,
    kind: preset.kind,
    roomId: room.id,
    position,
    size: { ...preset.size },
    rotation: 0,
  };
  return { layout: { ...layout, fixtures: [...layout.fixtures, fixture] }, id };
}

/** What a device is and how it senses, before it has a place. */
export interface DeviceSpec {
  name: string;
  ha?: Device['ha'];
  coverage?: Coverage[];
  /** Height above the floor, or `ceiling` for just below the ceiling of the room it goes in. */
  height: number | 'ceiling';
  heading?: number;
  tilt?: number;
}

/** How far below the ceiling a ceiling-mounted device sits. */
const CEILING_GAP = 0.05;

/**
 * Places a device at a point inside a room on the floor. A device already in the layout for the
 * same Home Assistant device or entities is moved there instead, keeping how it was set up, as one
 * device can only be in one place.
 */
export function placeDevice(
  layout: HomeLayout,
  floorId: string,
  spec: DeviceSpec,
  point: Point2
): PlaceResult & { moved?: boolean } {
  const position = snapToGrid(point, THING_GRID_STEP);
  const room = roomAt(layout, floorId, position) ?? roomAt(layout, floorId, point);
  if (!room) return { error: `Put ${spec.name} inside a room.` };

  const existing = spec.ha && findPlacedDevice(layout, spec.ha);
  if (existing) {
    return {
      layout: moveThing(layout, { kind: 'device', id: existing.id }, point, floorId),
      id: existing.id,
      moved: true,
    };
  }

  const z =
    spec.height === 'ceiling'
      ? Math.max(0, room.ceilingHeight - CEILING_GAP)
      : Math.min(spec.height, room.ceilingHeight);
  const id = uniqueId(layout, slug(spec.name) || 'device');
  const device: Device = {
    id,
    name: spec.name,
    roomId: room.id,
    position: [position[0], position[1], roundTo(z)],
    ...(spec.heading !== undefined ? { heading: spec.heading } : {}),
    ...(spec.tilt !== undefined ? { tilt: spec.tilt } : {}),
    ...(spec.coverage?.length ? { coverage: spec.coverage.map((c) => ({ ...c })) } : {}),
    ...(spec.ha ? { ha: { ...spec.ha, entityIds: [...spec.ha.entityIds] } } : {}),
  };
  return { layout: { ...layout, devices: [...layout.devices, device] }, id };
}

/**
 * The device in the layout for a Home Assistant device, matched by its device id or by any of its
 * entities, as layouts written by hand may only list entities.
 */
export function findPlacedDevice(
  layout: HomeLayout,
  ha: { deviceId?: string | undefined; entityIds: readonly string[] }
): Device | undefined {
  const entities = new Set(ha.entityIds);
  return layout.devices.find(
    (device) =>
      !!device.ha &&
      ((ha.deviceId !== undefined && device.ha.deviceId === ha.deviceId) ||
        device.ha.entityIds.some((entityId) => entities.has(entityId)))
  );
}

/**
 * Moves a piece of furniture or a device to a point on the floor, snapped to the grid. It joins the
 * room it lands in; outside every room it stays in its room, and the layout's checks say so.
 */
export function moveThing(
  layout: HomeLayout,
  item: { kind: 'fixture' | 'device'; id: string },
  point: Point2,
  floorId: string
): HomeLayout {
  const position = snapToGrid(point, THING_GRID_STEP);
  const roomId = roomAt(layout, floorId, position)?.id;
  if (item.kind === 'fixture') {
    return {
      ...layout,
      fixtures: layout.fixtures.map((fixture) =>
        fixture.id === item.id
          ? { ...fixture, position, roomId: roomId ?? fixture.roomId }
          : fixture
      ),
    };
  }
  return {
    ...layout,
    devices: layout.devices.map((device) =>
      device.id === item.id
        ? {
            ...device,
            position: [position[0], position[1], device.position[2]],
            roomId: roomId ?? device.roomId,
          }
        : device
    ),
  };
}

export type FixturePatch = Partial<Omit<Fixture, 'id'>>;

export function updateFixture(
  layout: HomeLayout,
  fixtureId: string,
  patch: FixturePatch
): HomeLayout {
  return {
    ...layout,
    fixtures: layout.fixtures.map((fixture) =>
      fixture.id === fixtureId
        ? {
            ...fixture,
            ...patch,
            ...(patch.rotation !== undefined ? { rotation: normalizeAngle(patch.rotation) } : {}),
          }
        : fixture
    ),
  };
}

/** Changes to a device. An optional field set to undefined is removed. */
export type DevicePatch = Partial<Omit<Device, 'id'>>;

/**
 * Changes a device. A device with a cone of coverage needs a heading, so one that gains a cone
 * without having a heading faces the top of the plan until it is turned.
 */
export function updateDevice(layout: HomeLayout, deviceId: string, patch: DevicePatch): HomeLayout {
  return {
    ...layout,
    devices: layout.devices.map((device) => {
      if (device.id !== deviceId) return device;
      const next: Record<string, unknown> = { ...device };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      if (typeof next.heading === 'number') next.heading = normalizeAngle(next.heading);
      const coverage = next.coverage as Coverage[] | undefined;
      if (coverage && coverage.length === 0) delete next.coverage;
      if (next.heading === undefined && coverage?.some(isCone)) next.heading = 0;
      return next as Device;
    }),
  };
}

/** Whether a coverage is a cone, rather than all the way around. */
export function isCone(coverage: Coverage): boolean {
  return (coverage.fieldOfView ?? 360) < 360;
}

/** Links a room to a Home Assistant area, or unlinks it with null. */
export function setRoomArea(layout: HomeLayout, roomId: string, areaId: string | null): HomeLayout {
  return {
    ...layout,
    rooms: layout.rooms.map((room) => {
      if (room.id !== roomId) return room;
      const { ha: _old, ...rest } = room;
      return areaId ? { ...rest, ha: { areaId } } : rest;
    }),
  };
}

/**
 * Links each room that has no area to the area with the same name, ignoring case, spaces and
 * punctuation, when no other room is linked to that area yet.
 */
export function matchRoomsToAreas(
  layout: HomeLayout,
  areas: readonly { area_id: string; name: string }[]
): { layout: HomeLayout; linked: number } {
  const taken = new Set(layout.rooms.flatMap((room) => (room.ha ? [room.ha.areaId] : [])));
  let linked = 0;
  const rooms = layout.rooms.map((room) => {
    if (room.ha) return room;
    const area = areas.find(
      (candidate) => !taken.has(candidate.area_id) && sameName(candidate.name, room.name)
    );
    if (!area) return room;
    taken.add(area.area_id);
    linked++;
    return { ...room, ha: { areaId: area.area_id } };
  });
  return { layout: linked ? { ...layout, rooms } : layout, linked };
}

function sameName(a: string, b: string): boolean {
  const key = (text: string) =>
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '');
  return key(a) !== '' && key(a) === key(b);
}

/** The heading from `center` towards `point`, snapped to `step` degrees. */
export function headingTowards(center: Point2, point: Point2, step = ANGLE_STEP): number {
  const heading = planHeading([point[0] - center[0], point[1] - center[1]]);
  return normalizeAngle(Math.round(heading / step) * step);
}

/** An angle in degrees brought into [0, 360). */
export function normalizeAngle(degrees: number): number {
  const angle = roundTo(((degrees % 360) + 360) % 360);
  return angle >= 360 ? 0 : angle;
}

/** The point `distance` metres from `origin` in a plan heading. */
export function pointAt(origin: Point2, heading: number, distance: number): Point2 {
  const radians = (heading * Math.PI) / 180;
  return [origin[0] + Math.sin(radians) * distance, origin[1] + Math.cos(radians) * distance];
}

/** The corners of a fixture's footprint on the plan, front edge (the side it faces) first. */
export function fixtureCorners(fixture: Pick<Fixture, 'position' | 'size' | 'rotation'>): Point2[] {
  const { width, depth } = fixture.size;
  const radians = (fixture.rotation * Math.PI) / 180;
  const [cos, sin] = [Math.cos(radians), Math.sin(radians)];
  // Rotating clockwise on a plan whose y points up.
  const turn = ([x, y]: Point2): Point2 => [
    fixture.position[0] + x * cos + y * sin,
    fixture.position[1] - x * sin + y * cos,
  ];
  return (
    [
      [-width / 2, depth / 2],
      [width / 2, depth / 2],
      [width / 2, -depth / 2],
      [-width / 2, -depth / 2],
    ] as Point2[]
  ).map(turn);
}

/** `base`, or `base` with the first number from 2 that no name in `names` has yet. */
function nextName(names: readonly string[], base: string): string {
  const used = new Set(names);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
  }
}

/**
 * Something picked in the side panel to put on the plan, by clicking the plan or dragging onto it:
 * a piece of furniture by its preset, or a Home Assistant device by its catalog key.
 */
export type Placement =
  { kind: 'fixture'; preset: FixturePreset } | { kind: 'device'; key: string; name: string };
