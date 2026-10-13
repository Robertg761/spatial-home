export { HomeAssistantConnection } from './connection.ts';
export type {
  AccessTokenProvider,
  CallServiceOptions,
  ConnectionOptions,
  ConnectionState,
  ConnectionStatus,
  DisconnectReason,
  Logger,
  ReconnectOptions,
  RequestOptions,
  StartupTask,
  WebSocketConstructor,
  WebSocketLike,
} from './connection.ts';
export { EntityStore, applyDiff, decodeState } from './entities.ts';
export type { EntitiesChange, EntitiesListener, EntityStoreOptions } from './entities.ts';
export { HomeAssistantError } from './errors.ts';
export type { ClientErrorCode } from './errors.ts';
export type {
  CallServiceResult,
  CommandPayload,
  CompressedState,
  CompressedStateDiff,
  EntitiesEvent,
  HassContext,
  HassEntity,
  HassServiceTarget,
} from './messages.ts';
export {
  fetchHomeRegistries,
  listAreas,
  listDevices,
  listEntityRegistry,
  listFloors,
  resolveEntityAreaId,
} from './registries.ts';
export type {
  AreaEntry,
  DeviceEntry,
  EntityRegistryEntry,
  FloorEntry,
  HomeRegistries,
} from './registries.ts';
export { normalizeBaseUrl, toWebSocketUrl } from './url.ts';
