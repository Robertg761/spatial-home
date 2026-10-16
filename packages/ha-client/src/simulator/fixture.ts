import type { AreaEntry, DeviceEntry, EntityRegistryEntry, FloorEntry } from '../registries.ts';

// The description of a simulated home: the registries a real Home Assistant would report, plus each
// entity's starting state and how it behaves over time. See fixtures/demo-home.json.

/** A numeric sensor that drifts around `base` (a temperature, a humidity reading). */
export interface RandomWalkBehavior {
  kind: 'random-walk';
  /** The value it drifts back toward. Defaults to the starting state. */
  base?: number;
  min: number;
  max: number;
  /** Typical change per simulated minute. */
  step: number;
  /** Digits kept after the decimal point. Defaults to 1. */
  decimals?: number;
}

/** A binary sensor that switches on and off at random (motion, a door, a window). */
export interface FlipBehavior {
  kind: 'flip';
  /** Average simulated seconds it stays `on` before switching off. */
  meanOnSeconds: number;
  /** Average simulated seconds it stays `off` before switching on. */
  meanOffSeconds: number;
}

/** How a climate entity's room responds to heating and cooling. */
export interface ThermostatBehavior {
  kind: 'thermostat';
  /** The temperature the room settles at with the system off. Defaults to 19. */
  ambient?: number;
  /** Degrees gained or lost per simulated minute while heating or cooling. Defaults to 0.5. */
  ratePerMinute?: number;
}

/** How fast a cover travels. */
export interface CoverBehavior {
  kind: 'cover';
  /** Simulated seconds from fully closed to fully open. Defaults to 20. */
  secondsToTravel?: number;
}

export type Behavior = RandomWalkBehavior | FlipBehavior | ThermostatBehavior | CoverBehavior;

export interface SimulatedEntityConfig {
  /** `domain.object_id`, such as `light.reading_lamp`. */
  entity_id: string;
  /** Shown as the `friendly_name` attribute. */
  name?: string;
  device_id?: string | null;
  /** Overrides the device's area. */
  area_id?: string | null;
  state: string;
  attributes?: Record<string, unknown>;
  simulate?: Behavior;
}

export interface SimulatedDeviceConfig {
  id: string;
  name: string;
  area_id?: string | null;
  manufacturer?: string | null;
  model?: string | null;
}

export interface SimulatedHomeFixture {
  name?: string;
  floors?: Array<Pick<FloorEntry, 'floor_id' | 'name'> & Partial<FloorEntry>>;
  areas?: Array<Pick<AreaEntry, 'area_id' | 'name'> & Partial<AreaEntry>>;
  devices?: SimulatedDeviceConfig[];
  entities: SimulatedEntityConfig[];
}

/** The domains the simulator knows how to run. Others are served as static states. */
export const SIMULATED_DOMAINS = [
  'light',
  'switch',
  'binary_sensor',
  'sensor',
  'climate',
  'cover',
] as const;

export function domainOf(entityId: string): string {
  return entityId.slice(0, entityId.indexOf('.'));
}

function fail(message: string): never {
  throw new Error(`Invalid simulated home: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkBehavior(entityId: string, behavior: unknown): void {
  if (!isRecord(behavior)) fail(`${entityId}: "simulate" must be an object`);
  const domain = domainOf(entityId);
  const expected: Record<string, string> = {
    'random-walk': 'sensor',
    flip: 'binary_sensor',
    thermostat: 'climate',
    cover: 'cover',
  };
  const kind = String(behavior.kind);
  if (!(kind in expected)) fail(`${entityId}: unknown behavior "${kind}"`);
  if (expected[kind] !== domain) {
    fail(`${entityId}: the "${kind}" behavior belongs on ${expected[kind]} entities`);
  }
  if (kind === 'random-walk') {
    for (const key of ['min', 'max', 'step']) {
      if (typeof behavior[key] !== 'number')
        fail(`${entityId}: random-walk needs a numeric ${key}`);
    }
  }
  if (kind === 'flip') {
    for (const key of ['meanOnSeconds', 'meanOffSeconds']) {
      const value = behavior[key];
      if (typeof value !== 'number' || value <= 0)
        fail(`${entityId}: flip needs a positive ${key}`);
    }
  }
}

/** Checks a fixture's shape and references, throwing an Error that names the first problem. */
export function parseFixture(raw: unknown): SimulatedHomeFixture {
  if (!isRecord(raw)) fail('expected an object');
  if (!Array.isArray(raw.entities)) fail('"entities" must be an array');
  const fixture = raw as unknown as SimulatedHomeFixture;

  const floorIds = new Set<string>();
  for (const floor of fixture.floors ?? []) {
    if (!floor.floor_id || !floor.name) fail('every floor needs floor_id and name');
    floorIds.add(floor.floor_id);
  }
  const areaIds = new Set<string>();
  for (const area of fixture.areas ?? []) {
    if (!area.area_id || !area.name) fail('every area needs area_id and name');
    if (area.floor_id && !floorIds.has(area.floor_id)) {
      fail(`area ${area.area_id} is on unknown floor ${area.floor_id}`);
    }
    areaIds.add(area.area_id);
  }
  const deviceIds = new Set<string>();
  for (const device of fixture.devices ?? []) {
    if (!device.id || !device.name) fail('every device needs id and name');
    if (device.area_id && !areaIds.has(device.area_id)) {
      fail(`device ${device.id} is in unknown area ${device.area_id}`);
    }
    deviceIds.add(device.id);
  }
  const entityIds = new Set<string>();
  for (const entity of fixture.entities) {
    const id = entity?.entity_id;
    if (typeof id !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(id)) {
      fail(`bad entity_id ${JSON.stringify(id)}`);
    }
    if (entityIds.has(id)) fail(`duplicate entity ${id}`);
    entityIds.add(id);
    if (typeof entity.state !== 'string') fail(`${id}: "state" must be a string`);
    if (entity.device_id && !deviceIds.has(entity.device_id)) {
      fail(`${id} belongs to unknown device ${entity.device_id}`);
    }
    if (entity.area_id && !areaIds.has(entity.area_id)) {
      fail(`${id} is in unknown area ${entity.area_id}`);
    }
    if (entity.simulate !== undefined) checkBehavior(id, entity.simulate);
  }
  return fixture;
}

export function toDeviceEntry(device: SimulatedDeviceConfig): DeviceEntry {
  return {
    id: device.id,
    name: device.name,
    name_by_user: null,
    area_id: device.area_id ?? null,
    manufacturer: device.manufacturer ?? null,
    model: device.model ?? null,
    disabled_by: null,
    entry_type: null,
    via_device_id: null,
  };
}

export function toEntityEntry(entity: SimulatedEntityConfig): EntityRegistryEntry {
  return {
    entity_id: entity.entity_id,
    name: null,
    original_name: entity.name ?? null,
    device_id: entity.device_id ?? null,
    area_id: entity.area_id ?? null,
    platform: 'simulator',
    disabled_by: null,
    hidden_by: null,
    entity_category: null,
    icon: null,
  };
}
