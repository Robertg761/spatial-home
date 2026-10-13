import type { HomeAssistantConnection } from './connection.ts';
import { HomeAssistantError } from './errors.ts';
import type {
  CompressedState,
  CompressedStateDiff,
  EntitiesEvent,
  HassContext,
  HassEntity,
} from './messages.ts';

export interface EntityStoreOptions {
  /**
   * Follow only these entities instead of all of them. An empty list follows none: the store stays
   * empty and sends nothing, since Home Assistant reads an empty filter as "every entity".
   */
  entityIds?: string[];
  /**
   * How long to wait for the first snapshot after connecting. A large instance can take a while
   * to serialize every entity; each timeout in a row doubles the wait, up to four times this.
   */
  snapshotTimeoutMs?: number;
}

export interface EntitiesChange {
  /**
   * True when the whole set was replaced: the first snapshot, or a fresh one after a reconnect.
   * Entities removed while disconnected are simply absent, so re-read everything.
   */
  snapshot: boolean;
  /** Entities added or changed. */
  changed: string[];
  removed: string[];
}

export type EntitiesListener = (change: EntitiesChange) => void;

const DEFAULT_SNAPSHOT_TIMEOUT_MS = 90_000;
const MAX_SNAPSHOT_TIMEOUT_GROWTH = 4;

interface SnapshotWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Live entity states, kept current with `subscribe_entities`. Unlike `get_states` followed by
 * `subscribe_events`, the subscription delivers the snapshot and every later change in order, so no
 * change can fall between the two.
 *
 * The store holds the connection at `syncing` until the first snapshot arrives, so `connected`
 * means the states are current. Entity objects are replaced, never mutated, when they change.
 */
export class EntityStore {
  #connection: HomeAssistantConnection;
  #snapshotTimeoutMs: number;
  #entities = new Map<string, HassEntity>();
  #listeners = new Set<EntitiesListener>();
  #awaitingSnapshot = true;
  #hasSnapshot = false;
  #snapshotTimeoutsInARow = 0;
  #waiter: SnapshotWaiter | null = null;
  #unsubscribe: () => void;
  #removeStartupTask: () => void;

  constructor(connection: HomeAssistantConnection, options: EntityStoreOptions = {}) {
    this.#connection = connection;
    this.#snapshotTimeoutMs = options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
    if (options.entityIds?.length === 0) {
      this.#awaitingSnapshot = false;
      this.#hasSnapshot = true;
      this.#unsubscribe = () => {};
      this.#removeStartupTask = () => {};
      return;
    }
    this.#removeStartupTask = connection.addStartupTask((signal) => this.#waitForSnapshot(signal));
    this.#unsubscribe = connection.subscribe<EntitiesEvent>(
      options.entityIds
        ? { type: 'subscribe_entities', entity_ids: options.entityIds }
        : { type: 'subscribe_entities' },
      (event) => this.#apply(event)
    );
  }

  /** Whether a snapshot has arrived since the store was created. */
  get hasSnapshot(): boolean {
    return this.#hasSnapshot;
  }

  get size(): number {
    return this.#entities.size;
  }

  get(entityId: string): HassEntity | undefined {
    return this.#entities.get(entityId);
  }

  all(): HassEntity[] {
    return [...this.#entities.values()];
  }

  /** Calls the listener after each update. Returns a function that removes it. */
  onChange(listener: EntitiesListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Stops following the connection. */
  dispose(): void {
    this.#unsubscribe();
    this.#removeStartupTask();
    // Resolved rather than rejected: a rejection would fail the connection's startup and drop a
    // healthy socket, when the store only stopped needing the snapshot.
    this.#settleWaiter();
    this.#listeners.clear();
  }

  #waitForSnapshot(signal: AbortSignal): Promise<void> {
    this.#awaitingSnapshot = true;
    this.#settleWaiter(new HomeAssistantError('Superseded by a new connection', 'aborted'));

    return new Promise<void>((resolve, reject) => {
      const growth = Math.min(2 ** this.#snapshotTimeoutsInARow, MAX_SNAPSHOT_TIMEOUT_GROWTH);
      const timer = setTimeout(() => {
        this.#waiter = null;
        this.#snapshotTimeoutsInARow += 1;
        reject(
          new HomeAssistantError('Home Assistant did not send entity states in time', 'timeout')
        );
      }, this.#snapshotTimeoutMs * growth);
      this.#waiter = { resolve, reject, timer };

      signal.addEventListener(
        'abort',
        () => {
          if (this.#waiter?.timer !== timer) return;
          this.#settleWaiter(new HomeAssistantError('Connection lost', 'aborted'));
        },
        { once: true }
      );
    });
  }

  #settleWaiter(error?: Error): void {
    const waiter = this.#waiter;
    if (!waiter) return;
    this.#waiter = null;
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve();
  }

  #apply(event: EntitiesEvent): void {
    const snapshot = this.#awaitingSnapshot;
    const changed: string[] = [];
    const removed: string[] = [];

    if (snapshot) {
      this.#entities = new Map();
    }

    if (event.a) {
      for (const [entityId, compressed] of Object.entries(event.a)) {
        this.#entities.set(entityId, decodeState(entityId, compressed));
        changed.push(entityId);
      }
    }

    if (event.c) {
      for (const [entityId, diff] of Object.entries(event.c)) {
        const current = this.#entities.get(entityId);
        if (!current) continue;
        this.#entities.set(entityId, applyDiff(current, diff));
        changed.push(entityId);
      }
    }

    if (event.r) {
      for (const entityId of event.r) {
        if (this.#entities.delete(entityId)) removed.push(entityId);
      }
    }

    if (snapshot) {
      this.#awaitingSnapshot = false;
      this.#hasSnapshot = true;
      this.#snapshotTimeoutsInARow = 0;
      this.#settleWaiter();
    }

    if (!snapshot && changed.length === 0 && removed.length === 0) return;
    const change: EntitiesChange = { snapshot, changed, removed };
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch (error) {
        console.error('[ha-client] Error in an entity listener:', error);
      }
    }
  }
}

function toIsoString(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function decodeContext(context: CompressedState['c'], previous?: HassContext): HassContext {
  const base = previous ?? { id: '', parent_id: null, user_id: null };
  if (typeof context === 'string') return { ...base, id: context };
  if (context) return { ...base, ...context };
  return base;
}

/** Expands one entity from `subscribe_entities`' compressed form into the `get_states` shape. */
export function decodeState(entityId: string, compressed: CompressedState): HassEntity {
  const lastChanged = compressed.lc ?? compressed.lu ?? 0;
  const lastUpdated = compressed.lu ?? lastChanged;
  return {
    entity_id: entityId,
    state: compressed.s,
    attributes: compressed.a ?? {},
    last_changed: toIsoString(lastChanged),
    last_updated: toIsoString(lastUpdated),
    context: decodeContext(compressed.c),
  };
}

/** Applies one `subscribe_entities` change to an entity, returning a new object. */
export function applyDiff(entity: HassEntity, diff: CompressedStateDiff): HassEntity {
  const next: HassEntity = { ...entity };
  const added = diff['+'];
  const removedAttributes = diff['-']?.a;

  if (added) {
    if (added.s !== undefined) next.state = added.s;
    if (added.c !== undefined) next.context = decodeContext(added.c, entity.context);
    if (added.lc !== undefined) {
      next.last_changed = next.last_updated = toIsoString(added.lc);
    } else if (added.lu !== undefined) {
      next.last_updated = toIsoString(added.lu);
    }
  }

  if (added?.a || removedAttributes) {
    const attributes = { ...entity.attributes, ...added?.a };
    for (const key of removedAttributes ?? []) delete attributes[key];
    next.attributes = attributes;
  }

  return next;
}
