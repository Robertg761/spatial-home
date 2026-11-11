// The editor's link to Home Assistant: one connection at a time, to a real server or (in
// development) to the simulated home, with its registries and live entity states.

import {
  EntityStore,
  HomeAssistantConnection,
  fetchHomeRegistries,
  normalizeBaseUrl,
  type ConnectionStatus,
  type HassEntity,
  type HomeRegistries,
} from '@spatial-home/ha-client';

/** The simulated home is for development, so release builds leave it out. */
export const SIMULATOR_AVAILABLE = import.meta.env.DEV;

export interface LinkSnapshot {
  /** `off` until a connection is asked for, and after disconnecting. */
  status: ConnectionStatus | 'off';
  source: 'server' | 'simulator' | null;
  /** The Home Assistant address, or the simulator's. */
  url: string | null;
  haVersion: string | null;
  /** Why the last attempt failed, in words for the user. */
  error: string | null;
  registries: HomeRegistries | null;
  /** Bumped when entity states change, at most a couple of times a second. */
  statesVersion: number;
}

export interface SavedLink {
  url: string;
  /** Only kept when the user asks for it. */
  token?: string;
  simulated?: boolean;
}

const SETTINGS_KEY = 'spatial-home.editor.home-assistant';
/** Entity state changes are shown at most this often, so a busy home doesn't redraw constantly. */
const STATES_THROTTLE_MS = 500;
/** Registry change events that arrive together are fetched once. */
const REGISTRY_DEBOUNCE_MS = 400;
const REGISTRY_EVENTS = [
  'floor_registry_updated',
  'area_registry_updated',
  'device_registry_updated',
  'entity_registry_updated',
];

const OFF: LinkSnapshot = {
  status: 'off',
  source: null,
  url: null,
  haVersion: null,
  error: null,
  registries: null,
  statesVersion: 0,
};

export class HomeAssistantLink {
  #snapshot: LinkSnapshot = OFF;
  #listeners = new Set<() => void>();
  #connection: HomeAssistantConnection | null = null;
  #entities: EntityStore | null = null;
  #cleanup: (() => void)[] = [];
  /** Bumped by every connect and disconnect, so late results from an old connection are dropped. */
  #generation = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): LinkSnapshot => this.#snapshot;

  /** An entity's live state, while connected. */
  entity(entityId: string): HassEntity | undefined {
    return this.#entities?.get(entityId);
  }

  /** Reconnects to what was saved last time, if a token or the simulator was saved. */
  resume(): void {
    const saved = loadSavedLink();
    if (saved?.simulated && SIMULATOR_AVAILABLE) void this.connectSimulator();
    else if (saved?.token) this.connect(saved.url, saved.token, true);
  }

  /**
   * Connects to a Home Assistant server. Returns an error to show next to the form instead when the
   * address or token can't be used.
   */
  connect(rawUrl: string, token: string, remember: boolean): string | null {
    const url = normalizeBaseUrl(rawUrl);
    if (!url) return 'That isn’t a web address, such as http://homeassistant.local:8123.';
    if (!token.trim()) return 'Paste a long-lived access token.';
    if (globalThis.location?.protocol === 'https:' && url.startsWith('http:')) {
      return 'This page was opened over https, so the browser won’t let it reach Home Assistant over http. Use an https address for Home Assistant.';
    }
    saveLink(remember ? { url, token: token.trim() } : { url });
    this.#open(new HomeAssistantConnection({ url, accessToken: token }), 'server', url);
    return null;
  }

  /** Connects to the simulated demo home, which lives in this page. Development builds only. */
  async connectSimulator(): Promise<void> {
    if (!SIMULATOR_AVAILABLE) return;
    const generation = ++this.#generation;
    const { createDemoSimulator } = await import('@spatial-home/ha-client/simulator');
    if (generation !== this.#generation) return;
    const simulator = createDemoSimulator({ speed: 1 });
    simulator.start();
    const previous = loadSavedLink();
    saveLink({ ...(previous && !previous.simulated ? previous : { url: '' }), simulated: true });
    this.#open(
      new HomeAssistantConnection(simulator.connectionOptions),
      'simulator',
      simulator.url,
      () => simulator.stop()
    );
  }

  /** Disconnects and forgets the saved token, keeping the address for next time. */
  disconnect(): void {
    this.#close();
    const saved = loadSavedLink();
    saveLink({ url: saved?.simulated ? '' : (saved?.url ?? '') });
    this.#set(OFF);
  }

  /** Fetches the registries again, such as after renaming things in Home Assistant. */
  refresh(): void {
    const connection = this.#connection;
    if (connection?.isConnected()) void this.#loadRegistries(connection, this.#generation);
  }

  /** Closes the connection without forgetting it, as when the page goes away. */
  dispose(): void {
    this.#close();
    this.#snapshot = OFF;
  }

  #open(
    connection: HomeAssistantConnection,
    source: 'server' | 'simulator',
    url: string,
    onClose?: () => void
  ): void {
    this.#close();
    const generation = ++this.#generation;
    const entities = new EntityStore(connection);
    this.#connection = connection;
    this.#entities = entities;
    this.#set({ ...OFF, status: 'connecting', source, url });

    // The registries load before the connection counts as connected, and again after each
    // reconnection, as things may have changed while it was down.
    const removeStartup = connection.addStartupTask(async () => {
      const registries = await fetchHomeRegistries(connection);
      if (generation === this.#generation) this.#set({ registries });
    });
    const removeState = connection.onStateChange((state) => {
      if (generation !== this.#generation) return;
      this.#set({
        status: state.status,
        haVersion: state.haVersion,
        error: describeError(state.status, state.error, url),
      });
    });
    let statesTimer: ReturnType<typeof setTimeout> | undefined;
    const removeEntities = entities.onChange(() => {
      statesTimer ??= setTimeout(() => {
        statesTimer = undefined;
        if (generation === this.#generation) {
          this.#set({ statesVersion: this.#snapshot.statesVersion + 1 });
        }
      }, STATES_THROTTLE_MS);
    });
    let registryTimer: ReturnType<typeof setTimeout> | undefined;
    const removeEvents = REGISTRY_EVENTS.map((eventType) =>
      connection.subscribeEvents(eventType, () => {
        clearTimeout(registryTimer);
        registryTimer = setTimeout(() => this.refresh(), REGISTRY_DEBOUNCE_MS);
      })
    );

    this.#cleanup = [
      removeStartup,
      removeState,
      removeEntities,
      ...removeEvents,
      () => clearTimeout(statesTimer),
      () => clearTimeout(registryTimer),
      () => entities.dispose(),
      () => connection.close(),
      ...(onClose ? [onClose] : []),
    ];
    connection.connect();
  }

  async #loadRegistries(connection: HomeAssistantConnection, generation: number): Promise<void> {
    try {
      const registries = await fetchHomeRegistries(connection);
      if (generation === this.#generation) this.#set({ registries });
    } catch {
      // The list already shown stays; the next reconnection loads it again.
    }
  }

  #close(): void {
    this.#generation++;
    for (const cleanup of this.#cleanup) cleanup();
    this.#cleanup = [];
    this.#connection = null;
    this.#entities = null;
  }

  #set(patch: Partial<LinkSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

function describeError(status: ConnectionStatus, error: Error | null, url: string): string | null {
  if (status === 'auth-failed') {
    return 'Home Assistant turned the access token down. Check it, or make a new one.';
  }
  if (status === 'reconnecting' || status === 'disconnected') {
    return `Can’t reach Home Assistant at ${url}${error ? ` (${error.message})` : ''}. Trying again…`;
  }
  return null;
}

export function loadSavedLink(): SavedLink | null {
  try {
    const text = localStorage.getItem(SETTINGS_KEY);
    if (!text) return null;
    const data = JSON.parse(text) as Partial<SavedLink>;
    if (typeof data.url !== 'string') return null;
    return {
      url: data.url,
      ...(typeof data.token === 'string' && data.token ? { token: data.token } : {}),
      ...(data.simulated === true ? { simulated: true } : {}),
    };
  } catch {
    return null;
  }
}

function saveLink(link: SavedLink): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(link));
  } catch {
    // Storage can be unavailable, such as in a private window; then nothing is remembered.
  }
}
