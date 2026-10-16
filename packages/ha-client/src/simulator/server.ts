import type { WebSocketConstructor, WebSocketLike } from '../connection.ts';
import type {
  CallServiceResult,
  CompressedState,
  CompressedStateDiff,
  EntitiesEvent,
  HassEntity,
  HassServiceTarget,
} from '../messages.ts';
import { advance, createEntity, render, scheduleFlip } from './entities.ts';
import type { Attributes, SimEntity } from './entities.ts';
import { parseFixture, toDeviceEntry, toEntityEntry } from './fixture.ts';
import type { SimulatedHomeFixture } from './fixture.ts';
import { createRandom } from './random.ts';
import { SimulatedServiceError, findService, targetDomains } from './services.ts';

/** The address a simulated home answers to. It never touches the network. */
export const SIMULATED_URL = 'http://simulated-home.invalid:8123';

/** Any non-empty token is accepted unless the simulator is given one to require. */
export const SIMULATED_TOKEN = 'simulated-token';

export interface SimulatorOptions {
  /** Seeds the randomness, so a run can be repeated. Defaults to 1. */
  seed?: number;
  /** Starting time in ms since the epoch. Defaults to now. */
  startTime?: number;
  /** How often start() advances the simulation, in real ms. Defaults to 1000. */
  tickMs?: number;
  /** Simulated seconds that pass per real second under start(). 60 makes a minute a second. */
  speed?: number;
  haVersion?: string;
  /** When set, connections must authenticate with exactly this token. */
  accessToken?: string;
}

/** Longest stretch of simulated time advanced in one step, so fast-forwarding stays accurate. */
const MAX_STEP_SECONDS = 5;

interface Change {
  entity: SimEntity;
  previous: { state: string; attributes: Attributes };
  stateChanged: boolean;
}

type ChangeListener = (change: Change) => void;

/**
 * A Home Assistant that lives in memory. Give `WebSocket` to a HomeAssistantConnection and the
 * client talks to it exactly as it would a real server: it authenticates, loads the registries,
 * subscribes to entities, and calls services. Devices change by themselves as simulated time
 * passes (see `tick` and `start`) and react to the commands the client sends.
 *
 * For development and tests only: it is not exported from the package's main entry point.
 */
export class SimulatedHomeAssistant {
  readonly url = SIMULATED_URL;
  readonly fixture: SimulatedHomeFixture;
  readonly haVersion: string;

  #entities = new Map<string, SimEntity>();
  #random: () => number;
  #clock: number;
  #tickMs: number;
  #speed: number;
  #accessToken: string | null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #lastWallTime = 0;
  #contextCounter = 0;
  #listeners = new Set<ChangeListener>();
  #sockets = new Set<SimulatedSocket>();
  #socketClass: WebSocketConstructor;

  constructor(fixture: unknown, options: SimulatorOptions = {}) {
    this.fixture = parseFixture(fixture);
    this.haVersion = options.haVersion ?? '2026.10.0';
    this.#random = createRandom(options.seed ?? 1);
    this.#clock = options.startTime ?? Date.now();
    this.#tickMs = options.tickMs ?? 1000;
    this.#speed = options.speed ?? 1;
    this.#accessToken = options.accessToken ?? null;

    for (const config of this.fixture.entities) {
      const entity = createEntity(config, this.#clock / 1000);
      scheduleFlip(entity, this.#clock, this.#random);
      this.#entities.set(entity.id, entity);
    }

    const simulator = this;
    this.#socketClass = class extends SimulatedSocket {
      constructor(url: string) {
        super(simulator, url);
      }
    };
  }

  /** Pass this as the `WebSocket` option of a HomeAssistantConnection. */
  get WebSocket(): WebSocketConstructor {
    return this.#socketClass;
  }

  /** The simulated time, in ms since the epoch. */
  get now(): number {
    return this.#clock;
  }

  /** Options for `new HomeAssistantConnection(...)` that point it at this simulator. */
  get connectionOptions(): { url: string; accessToken: string; WebSocket: WebSocketConstructor } {
    return {
      url: this.url,
      accessToken: this.#accessToken ?? SIMULATED_TOKEN,
      WebSocket: this.#socketClass,
    };
  }

  // --- Time ---

  /** Runs the simulation in real time (times `speed`) until stop(). */
  start(): void {
    if (this.#timer) return;
    this.#lastWallTime = Date.now();
    this.#timer = setInterval(() => {
      const wall = Date.now();
      const elapsed = (wall - this.#lastWallTime) / 1000;
      this.#lastWallTime = wall;
      this.tick(elapsed * this.#speed);
    }, this.#tickMs);
    // A simulator on its own should not keep a script alive.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Advances simulated time by `seconds`. Devices that changed are sent to subscribers. */
  tick(seconds: number): void {
    let remaining = seconds;
    while (remaining > 0) {
      const step = Math.min(remaining, MAX_STEP_SECONDS);
      remaining -= step;
      this.#clock += step * 1000;
      for (const entity of this.#entities.values()) {
        advance(entity, step, this.#clock, this.#random);
        this.#refresh(entity);
      }
    }
  }

  // --- States ---

  getState(entityId: string): HassEntity | undefined {
    const entity = this.#entities.get(entityId);
    return entity && toHassEntity(entity);
  }

  getStates(): HassEntity[] {
    return [...this.#entities.values()].map(toHassEntity);
  }

  /**
   * Forces a switch, light or binary sensor on or off, or gives a sensor a reading: handy for
   * playing a scene, such as opening the front door. Other devices take commands via callService.
   */
  setState(entityId: string, state: string): void {
    const entity = this.#require(entityId);
    switch (entity.domain) {
      case 'light':
        entity.light.on = state === 'on';
        break;
      case 'sensor': {
        entity.text = state;
        if (Number.isFinite(Number(state))) entity.value = Number(state);
        break;
      }
      case 'switch':
      case 'binary_sensor':
        entity.text = state;
        scheduleFlip(entity, this.#clock, this.#random);
        break;
      default:
        throw new Error(`setState does not support ${entity.domain} entities; use callService`);
    }
    this.#refresh(entity);
  }

  /** Runs a service the way a `call_service` command does. Rejects like Home Assistant would. */
  callService(
    domain: string,
    service: string,
    serviceData: Record<string, unknown> = {},
    target: HassServiceTarget = {}
  ): CallServiceResult {
    const handler = findService(domain, service);
    if (!handler) {
      throw new SimulatedServiceError(
        `Service ${domain}.${service} not found.`,
        'service_not_found'
      );
    }
    const { entity_id: dataEntityId, ...data } = serviceData;
    const merged: HassServiceTarget = { ...target };
    const named = target.entity_id ?? (dataEntityId as string | string[] | undefined);
    if (named !== undefined) merged.entity_id = named;
    const entities = this.#resolveTargets(domain, merged);
    const contextId = this.#nextContextId();
    for (const entity of entities) {
      handler(entity, data);
      this.#refresh(entity, contextId);
    }
    return { context: { id: contextId, parent_id: null, user_id: null } };
  }

  /** Closes every open connection as if the server went away, so reconnection can be tried. */
  dropConnections(): void {
    for (const socket of [...this.#sockets]) socket.drop();
  }

  // --- Used by the sockets ---

  /** @internal */
  _onChange(listener: ChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** @internal */
  _register(socket: SimulatedSocket): () => void {
    this.#sockets.add(socket);
    return () => this.#sockets.delete(socket);
  }

  /** @internal */
  _checkToken(token: unknown): boolean {
    if (typeof token !== 'string' || !token) return false;
    return this.#accessToken === null || token === this.#accessToken;
  }

  /** @internal */
  _registries() {
    const f = this.fixture;
    return {
      floors: (f.floors ?? []).map((floor) => ({
        level: null,
        icon: null,
        aliases: [],
        ...floor,
      })),
      areas: (f.areas ?? []).map((area) => ({
        floor_id: null,
        icon: null,
        aliases: [],
        labels: [],
        ...area,
      })),
      devices: (f.devices ?? []).map(toDeviceEntry),
      entities: f.entities.map(toEntityEntry),
    };
  }

  /** @internal */
  _compressedStates(entityIds?: string[]): Record<string, CompressedState> {
    const states: Record<string, CompressedState> = {};
    for (const entity of this.#entities.values()) {
      if (entityIds && !entityIds.includes(entity.id)) continue;
      states[entity.id] = {
        s: entity.state,
        a: entity.attributes,
        c: entity.contextId,
        lc: entity.lastChanged,
        lu: entity.lastUpdated,
      };
    }
    return states;
  }

  /** @internal */
  _config() {
    return {
      version: this.haVersion,
      location_name: this.fixture.name ?? 'Simulated home',
      state: 'RUNNING',
      unit_system: { temperature: '°C' },
    };
  }

  // --- Internals ---

  #require(entityId: string): SimEntity {
    const entity = this.#entities.get(entityId);
    if (!entity) throw new SimulatedServiceError(`Entity ${entityId} not found.`);
    return entity;
  }

  #resolveTargets(domain: string, target: HassServiceTarget): SimEntity[] {
    const list = (value: string | string[] | undefined) =>
      value === undefined ? [] : Array.isArray(value) ? value : [value];
    const found = new Map<string, SimEntity>();
    for (const id of list(target.entity_id)) found.set(id, this.#require(id));
    const areaIds = list(target.area_id);
    const deviceIds = list(target.device_id);
    const devicesById = new Map((this.fixture.devices ?? []).map((d) => [d.id, d]));
    for (const entity of this.#entities.values()) {
      const areaId =
        entity.areaId ?? (entity.deviceId ? devicesById.get(entity.deviceId)?.area_id : null);
      if (
        (areaId && areaIds.includes(areaId)) ||
        (entity.deviceId && deviceIds.includes(entity.deviceId))
      ) {
        found.set(entity.id, entity);
      }
    }
    const domains = targetDomains(domain);
    const matching = [...found.values()].filter((e) => !domains || domains.includes(e.domain));
    // Area and device targets sweep up every entity they hold, so only the matching domain acts.
    // An entity named outright in the wrong domain is a mistake worth reporting.
    for (const id of list(target.entity_id)) {
      if (domains && !domains.includes(this.#require(id).domain)) {
        throw new SimulatedServiceError(`Entity ${id} is not a ${domain} entity.`);
      }
    }
    return matching;
  }

  #nextContextId(): string {
    this.#contextCounter += 1;
    return `SIM${String(this.#contextCounter).padStart(23, '0')}`;
  }

  /** Renders an entity again and, if it changed, records and announces the change. */
  #refresh(entity: SimEntity, contextId = this.#nextContextId()): void {
    const next = render(entity);
    const stateChanged = next.state !== entity.state;
    if (!stateChanged && sameAttributes(next.attributes, entity.attributes)) return;
    const previous = { state: entity.state, attributes: entity.attributes };
    const now = this.#clock / 1000;
    entity.state = next.state;
    entity.attributes = next.attributes;
    entity.lastUpdated = now;
    if (stateChanged) entity.lastChanged = now;
    entity.contextId = contextId;
    const change: Change = { entity, previous, stateChanged };
    for (const listener of [...this.#listeners]) listener(change);
  }
}

function sameAttributes(a: Attributes, b: Attributes): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function toIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function toHassEntity(entity: SimEntity): HassEntity {
  return {
    entity_id: entity.id,
    state: entity.state,
    attributes: entity.attributes,
    last_changed: toIso(entity.lastChanged),
    last_updated: toIso(entity.lastUpdated),
    context: { id: entity.contextId, parent_id: null, user_id: null },
  };
}

/** The compressed diff `subscribe_entities` sends for a change. */
function toDiff({ entity, previous, stateChanged }: Change): CompressedStateDiff {
  const added: NonNullable<CompressedStateDiff['+']> = {
    c: entity.contextId,
    lu: entity.lastUpdated,
  };
  if (stateChanged) {
    added.s = entity.state;
    added.lc = entity.lastChanged;
  }
  const changedAttributes: Attributes = {};
  for (const [key, value] of Object.entries(entity.attributes)) {
    if (JSON.stringify(value) !== JSON.stringify(previous.attributes[key])) {
      changedAttributes[key] = value;
    }
  }
  if (Object.keys(changedAttributes).length > 0) added.a = changedAttributes;
  const diff: CompressedStateDiff = { '+': added };
  const removed = Object.keys(previous.attributes).filter((key) => !(key in entity.attributes));
  if (removed.length > 0) diff['-'] = { a: removed };
  return diff;
}

type Subscription =
  | { kind: 'entities'; entityIds: string[] | undefined }
  | { kind: 'events'; eventType: string | undefined };

const OPEN = 1;
const CLOSED = 3;

/** One client connection to the simulator, speaking Home Assistant's WebSocket protocol. */
class SimulatedSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  #simulator: SimulatedHomeAssistant;
  #authenticated = false;
  #subscriptions = new Map<number, Subscription>();
  #cleanup: Array<() => void> = [];

  constructor(simulator: SimulatedHomeAssistant, _url: string) {
    this.#simulator = simulator;
    this.#cleanup.push(simulator._register(this));
    this.#cleanup.push(simulator._onChange((change) => this.#onChange(change)));
    // The client assigns its handlers right after constructing the socket.
    queueMicrotask(() => {
      if (this.readyState !== 0) return;
      this.readyState = OPEN;
      this.onopen?.({});
      this.#emit({ type: 'auth_required', ha_version: simulator.haVersion });
    });
  }

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error('Socket is not open');
    const message = JSON.parse(data) as Record<string, unknown>;
    queueMicrotask(() => {
      if (this.readyState === OPEN) this.#handle(message);
    });
  }

  close(): void {
    this.readyState = CLOSED;
    this.#release();
  }

  /** The server going away. */
  drop(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.#release();
    this.onclose?.({ code: 1006 });
  }

  #release(): void {
    for (const cleanup of this.#cleanup) cleanup();
    this.#cleanup = [];
    this.#subscriptions.clear();
  }

  #emit(message: unknown): void {
    queueMicrotask(() => {
      if (this.readyState === OPEN) this.onmessage?.({ data: JSON.stringify(message) });
    });
  }

  #result(id: unknown, result: unknown = null): void {
    this.#emit({ id, type: 'result', success: true, result });
  }

  #error(id: unknown, code: string, message: string): void {
    this.#emit({ id, type: 'result', success: false, error: { code, message } });
  }

  #handle(message: Record<string, unknown>): void {
    const simulator = this.#simulator;
    if (!this.#authenticated) {
      if (message.type === 'auth' && simulator._checkToken(message.access_token)) {
        this.#authenticated = true;
        this.#emit({ type: 'auth_ok', ha_version: simulator.haVersion });
      } else {
        this.#emit({ type: 'auth_invalid', message: 'Invalid access token or password' });
        queueMicrotask(() => this.drop());
      }
      return;
    }

    const { id, type } = message;
    switch (type) {
      case 'ping':
        this.#emit({ id, type: 'pong' });
        return;
      case 'supported_features':
        this.#result(id);
        return;
      case 'get_config':
        this.#result(id, simulator._config());
        return;
      case 'get_states':
        this.#result(id, simulator.getStates());
        return;
      case 'config/floor_registry/list':
        this.#result(id, simulator._registries().floors);
        return;
      case 'config/area_registry/list':
        this.#result(id, simulator._registries().areas);
        return;
      case 'config/device_registry/list':
        this.#result(id, simulator._registries().devices);
        return;
      case 'config/entity_registry/list':
        this.#result(id, simulator._registries().entities);
        return;
      case 'subscribe_entities': {
        const entityIds = Array.isArray(message.entity_ids)
          ? (message.entity_ids as string[])
          : undefined;
        this.#subscriptions.set(id as number, { kind: 'entities', entityIds });
        this.#result(id);
        const first: EntitiesEvent = { a: simulator._compressedStates(entityIds) };
        this.#emit({ id, type: 'event', event: first });
        return;
      }
      case 'subscribe_events':
        this.#subscriptions.set(id as number, {
          kind: 'events',
          eventType: typeof message.event_type === 'string' ? message.event_type : undefined,
        });
        this.#result(id);
        return;
      case 'unsubscribe_events':
        if (this.#subscriptions.delete(message.subscription as number)) this.#result(id);
        else this.#error(id, 'not_found', 'Subscription not found.');
        return;
      case 'call_service':
        try {
          const result = simulator.callService(
            String(message.domain),
            String(message.service),
            (message.service_data as Record<string, unknown> | undefined) ?? {},
            (message.target as HassServiceTarget | undefined) ?? {}
          );
          this.#result(id, result);
        } catch (error) {
          if (error instanceof SimulatedServiceError) this.#error(id, error.code, error.message);
          else throw error;
        }
        return;
      default:
        this.#error(id, 'unknown_command', 'Unknown command.');
    }
  }

  #onChange(change: Change): void {
    for (const [id, subscription] of this.#subscriptions) {
      const entityId = change.entity.id;
      if (subscription.kind === 'entities') {
        if (subscription.entityIds && !subscription.entityIds.includes(entityId)) continue;
        this.#emit({ id, type: 'event', event: { c: { [entityId]: toDiff(change) } } });
      } else if (!subscription.eventType || subscription.eventType === 'state_changed') {
        this.#emit({
          id,
          type: 'event',
          event: {
            event_type: 'state_changed',
            data: {
              entity_id: entityId,
              old_state: null,
              new_state: toHassEntity(change.entity),
            },
            origin: 'LOCAL',
            time_fired: toIso(change.entity.lastUpdated),
            context: { id: change.entity.contextId, parent_id: null, user_id: null },
          },
        });
      }
    }
  }
}
