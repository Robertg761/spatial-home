// What the editor offers to place from Home Assistant: its physical devices, grouped by area, and
// a guess at how each one senses or lights the room around it.

import type {
  AreaEntry,
  DeviceEntry,
  EntityRegistryEntry,
  HassEntity,
  HomeRegistries,
} from '@spatial-home/ha-client';
import type { Coverage, HomeLayout } from '@spatial-home/home-model';
import { findPlacedDevice, type DeviceSpec } from '../editor/things.ts';

/** Something that can be placed: a Home Assistant device, or an entity that has no device. */
export interface CatalogItem {
  /** `device:<id>` or `entity:<entity_id>`, unique in the catalog. */
  key: string;
  name: string;
  deviceId?: string;
  areaId: string | null;
  /** Its entities, the ones that do the main job first and diagnostic ones last. */
  entityIds: string[];
  /** Such as "Signify Hue Go". */
  model?: string;
}

export interface CatalogGroup {
  /** null for the items Home Assistant has in no area. */
  areaId: string | null;
  name: string;
  items: CatalogItem[];
}

/**
 * Domains of entities without a device that stand for something physical. Others, such as scenes,
 * scripts, people and the sun, have no place in a room.
 */
const PHYSICAL_DOMAINS = new Set([
  'alarm_control_panel',
  'binary_sensor',
  'button',
  'camera',
  'climate',
  'cover',
  'fan',
  'humidifier',
  'light',
  'lock',
  'media_player',
  'remote',
  'sensor',
  'siren',
  'switch',
  'vacuum',
  'valve',
  'water_heater',
]);

type StateLookup = (entityId: string) => HassEntity | undefined;

/**
 * Builds the catalog: Home Assistant's devices and loose entities, grouped by area in floor order,
 * then the ones in no area. Disabled and hidden entities are left out, as are services, such as a
 * weather forecast, which Home Assistant lists as devices but which have no place in a room.
 */
export function buildCatalog(
  registries: HomeRegistries,
  state: StateLookup = () => undefined
): CatalogGroup[] {
  const usable = registries.entities.filter((entity) => !entity.disabled_by && !entity.hidden_by);
  const byDevice = new Map<string, EntityRegistryEntry[]>();
  for (const entity of usable) {
    if (!entity.device_id) continue;
    const list = byDevice.get(entity.device_id) ?? [];
    list.push(entity);
    byDevice.set(entity.device_id, list);
  }

  const items: CatalogItem[] = [];
  for (const device of registries.devices) {
    if (device.disabled_by || device.entry_type === 'service') continue;
    const entities = byDevice.get(device.id);
    if (!entities?.length) continue;
    const ordered = [...entities].sort(
      (a, b) => Number(a.entity_category !== null) - Number(b.entity_category !== null)
    );
    const model = [device.manufacturer, device.model].filter(Boolean).join(' ');
    items.push({
      key: `device:${device.id}`,
      name: deviceName(device, ordered[0]!, state),
      deviceId: device.id,
      areaId: device.area_id,
      entityIds: ordered.map((entity) => entity.entity_id),
      ...(model ? { model } : {}),
    });
  }
  const devices = new Set(registries.devices.map((device) => device.id));
  for (const entity of usable) {
    // An entity whose device is missing from the registry is listed on its own.
    if (entity.device_id && devices.has(entity.device_id)) continue;
    if (!PHYSICAL_DOMAINS.has(domainOf(entity.entity_id))) continue;
    items.push({
      key: `entity:${entity.entity_id}`,
      name: entityName(entity, state),
      areaId: entity.area_id,
      entityIds: [entity.entity_id],
    });
  }

  const areas = new Map(registries.areas.map((area) => [area.area_id, area]));
  const floorLevel = new Map(
    registries.floors.map((floor) => [floor.floor_id, floor.level ?? Number.MAX_SAFE_INTEGER])
  );
  const groups = new Map<string | null, CatalogItem[]>();
  for (const item of items) {
    // An item in an area the registry doesn't list is treated as in no area.
    const areaId = item.areaId && areas.has(item.areaId) ? item.areaId : null;
    const list = groups.get(areaId) ?? [];
    list.push(item);
    groups.set(areaId, list);
  }

  const level = (area: AreaEntry) =>
    area.floor_id
      ? (floorLevel.get(area.floor_id) ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
  const ordered = [...registries.areas].sort(
    (a, b) => level(a) - level(b) || a.name.localeCompare(b.name)
  );
  const result: CatalogGroup[] = [];
  for (const area of ordered) {
    const list = groups.get(area.area_id);
    if (list) result.push({ areaId: area.area_id, name: area.name, items: byName(list) });
  }
  const loose = groups.get(null);
  if (loose) result.push({ areaId: null, name: 'No area', items: byName(loose) });
  return result;
}

/** The groups with only the items whose name, model or entity ids contain the query. */
export function filterCatalog(groups: CatalogGroup[], query: string): CatalogGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        [item.name, item.model ?? '', ...item.entityIds].some((text) =>
          text.toLowerCase().includes(needle)
        )
      ),
    }))
    .filter((group) => group.items.length > 0);
}

/** The id of the device in the layout placed for a catalog item, if it has been placed. */
export function placedId(layout: HomeLayout, item: CatalogItem): string | undefined {
  return findPlacedDevice(layout, { deviceId: item.deviceId, entityIds: item.entityIds })?.id;
}

/**
 * How a catalog item goes into the layout: its name and links, and a first guess at its height and
 * coverage from what its entities are. Cameras and motion and presence sensors are mounted high and
 * look across the room in a cone; lights reach all around. Everything can be changed afterwards.
 */
export function deviceSpecFor(item: CatalogItem, state: StateLookup = () => undefined): DeviceSpec {
  const ha = {
    ...(item.deviceId ? { deviceId: item.deviceId } : {}),
    entityIds: [...item.entityIds],
  };
  const kinds = item.entityIds.map((entityId) => ({
    domain: domainOf(entityId),
    deviceClass: state(entityId)?.attributes.device_class,
    entityId,
  }));
  const has = (test: (kind: (typeof kinds)[number]) => boolean) => kinds.some(test);
  const cone = (coverage: Coverage): DeviceSpec => ({
    name: item.name,
    ha,
    coverage: [coverage],
    height: 2.2,
    heading: 0,
  });

  if (has((kind) => kind.domain === 'camera')) {
    return cone({ kind: 'camera', range: 8, fieldOfView: 90 });
  }
  if (has((kind) => kind.domain === 'binary_sensor' && kind.deviceClass === 'motion')) {
    return cone({ kind: 'motion', range: 7, fieldOfView: 110 });
  }
  if (
    has(
      (kind) =>
        kind.domain === 'binary_sensor' &&
        (kind.deviceClass === 'occupancy' || kind.deviceClass === 'presence')
    )
  ) {
    return cone({ kind: 'presence', range: 5, fieldOfView: 120 });
  }
  if (has((kind) => kind.domain === 'light')) {
    const ceiling = /ceiling|pendant|downlight|spot/i.test(
      [item.name, ...item.entityIds].join(' ')
    );
    return {
      name: item.name,
      ha,
      coverage: [{ kind: 'light', range: ceiling ? 4 : 2.5 }],
      height: ceiling ? 'ceiling' : 1.5,
    };
  }
  return { name: item.name, ha, height: 1 };
}

/** A short description of what an item is, from its entities' domains, such as "light, sensor". */
export function describeItem(item: CatalogItem): string {
  const domains = [...new Set(item.entityIds.map(domainOf))].map((domain) =>
    domain.replace(/_/g, ' ')
  );
  const shown = domains.slice(0, 3).join(', ');
  return domains.length > 3 ? `${shown} +${domains.length - 3}` : shown;
}

export function domainOf(entityId: string): string {
  return entityId.slice(0, entityId.indexOf('.'));
}

function deviceName(device: DeviceEntry, first: EntityRegistryEntry, state: StateLookup): string {
  return device.name_by_user || device.name || entityName(first, state);
}

/** An entity's name as Home Assistant shows it. */
export function entityName(
  entity: Pick<EntityRegistryEntry, 'entity_id' | 'name' | 'original_name'>,
  state: StateLookup = () => undefined
): string {
  const friendly = state(entity.entity_id)?.attributes.friendly_name;
  return (
    entity.name ||
    (typeof friendly === 'string' && friendly) ||
    entity.original_name ||
    entity.entity_id
  );
}

function byName(items: CatalogItem[]): CatalogItem[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}
