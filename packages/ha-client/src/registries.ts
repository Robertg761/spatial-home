import type { HomeAssistantConnection } from './connection.ts';
import { HomeAssistantError } from './errors.ts';

// Home Assistant's registries describe how the home is organized: floors hold areas, devices sit in
// areas, and entities belong to devices. Spatial Home links its rooms to areas and places devices
// and entities within them. Only the fields Spatial Home uses are typed; Home Assistant sends more.

export interface FloorEntry {
  floor_id: string;
  name: string;
  /** Storey number: 0 is the ground floor, negative numbers are below it. */
  level: number | null;
  icon: string | null;
  aliases: string[];
}

export interface AreaEntry {
  area_id: string;
  name: string;
  floor_id: string | null;
  icon: string | null;
  aliases: string[];
  labels: string[];
}

export interface DeviceEntry {
  id: string;
  name: string | null;
  name_by_user: string | null;
  area_id: string | null;
  manufacturer: string | null;
  model: string | null;
  disabled_by: string | null;
  entry_type: string | null;
  via_device_id: string | null;
}

export interface EntityRegistryEntry {
  entity_id: string;
  name: string | null;
  original_name?: string | null;
  device_id: string | null;
  area_id: string | null;
  platform: string;
  disabled_by: string | null;
  hidden_by: string | null;
  entity_category: string | null;
  icon: string | null;
}

export interface HomeRegistries {
  floors: FloorEntry[];
  areas: AreaEntry[];
  devices: DeviceEntry[];
  entities: EntityRegistryEntry[];
}

export function listFloors(connection: HomeAssistantConnection): Promise<FloorEntry[]> {
  // Floors arrived in Home Assistant 2024.4; older servers don't know the command.
  return connection
    .request<FloorEntry[]>({ type: 'config/floor_registry/list' })
    .catch((error: unknown) => {
      if (error instanceof HomeAssistantError && error.code === 'unknown_command') return [];
      throw error;
    });
}

export function listAreas(connection: HomeAssistantConnection): Promise<AreaEntry[]> {
  return connection.request<AreaEntry[]>({ type: 'config/area_registry/list' });
}

export function listDevices(connection: HomeAssistantConnection): Promise<DeviceEntry[]> {
  return connection.request<DeviceEntry[]>({ type: 'config/device_registry/list' });
}

export function listEntityRegistry(
  connection: HomeAssistantConnection
): Promise<EntityRegistryEntry[]> {
  return connection.request<EntityRegistryEntry[]>({ type: 'config/entity_registry/list' });
}

/** Fetches the floor, area, device and entity registries together. */
export async function fetchHomeRegistries(
  connection: HomeAssistantConnection
): Promise<HomeRegistries> {
  const [floors, areas, devices, entities] = await Promise.all([
    listFloors(connection),
    listAreas(connection),
    listDevices(connection),
    listEntityRegistry(connection),
  ]);
  return { floors, areas, devices, entities };
}

/**
 * The area an entity is in. An entity with no area of its own is in its device's area, which is
 * how Home Assistant itself resolves it.
 */
export function resolveEntityAreaId(
  entity: Pick<EntityRegistryEntry, 'area_id' | 'device_id'>,
  devicesById: ReadonlyMap<string, Pick<DeviceEntry, 'area_id'>>
): string | null {
  if (entity.area_id) return entity.area_id;
  if (!entity.device_id) return null;
  return devicesById.get(entity.device_id)?.area_id ?? null;
}
