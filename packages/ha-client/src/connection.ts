import { HomeAssistantError } from './errors.ts';
import type {
  CallServiceResult,
  CommandPayload,
  HassServiceTarget,
  IncomingMessage,
} from './messages.ts';
import { normalizeBaseUrl, toWebSocketUrl } from './url.ts';

/** The parts of the WebSocket API the connection uses, so tests and runtimes can supply their own. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * - `idle`: connect() has not been called.
 * - `connecting`: opening the socket and authenticating.
 * - `syncing`: authenticated; startup tasks (such as the first entity snapshot) are running.
 *   Requests can be sent.
 * - `connected`: startup tasks finished; the client has live data.
 * - `reconnecting`: the connection dropped and a retry is scheduled.
 * - `disconnected`: the connection dropped and automatic reconnection is off.
 * - `auth-failed`: Home Assistant rejected the access token. Nothing retries until reconnect()
 *   or connect() is called, since the same token would only be rejected again.
 * - `closed`: close() was called.
 */
export type ConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'syncing'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'auth-failed'
  | 'closed';

/**
 * Why the last connection ended. `timeout` means the server stopped answering (a missed
 * heartbeat, or no authentication in time) rather than closing the socket.
 */
export type DisconnectReason =
  'socket-closed' | 'socket-error' | 'timeout' | 'token-unavailable' | 'startup-failed';

export interface ConnectionState {
  status: ConnectionStatus;
  /** Home Assistant's version, once authenticated. */
  haVersion: string | null;
  reason: DisconnectReason | null;
  error: Error | null;
  /** Failed attempts since the last successful connection. */
  attempt: number;
  /** When the scheduled retry runs (ms since the epoch), while `reconnecting`. */
  nextRetryAt: number | null;
}

/**
 * Runs after every successful authentication. The connection reports `connected` only once all of
 * them resolve; if one rejects, the connection is dropped and retried with backoff. The signal is
 * aborted when that socket goes away, so a task can stop waiting.
 */
export type StartupTask = (signal: AbortSignal) => Promise<void>;

export type AccessTokenProvider = () => string | Promise<string>;

export interface ReconnectOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Up to this much random delay is added to each retry, so clients don't retry in lockstep. */
  jitterMs?: number;
}

export interface ConnectionOptions {
  /** Home Assistant's address, such as `http://homeassistant.local:8123`. */
  url: string;
  /**
   * A long-lived access token, or a function returning a current access token. The function is
   * called on every (re)connection, so an OAuth client can hand over a refreshed token.
   */
  accessToken: string | AccessTokenProvider;
  /** Defaults to the runtime's global WebSocket (browsers, Node 22+). */
  WebSocket?: WebSocketConstructor;
  requestTimeoutMs?: number;
  /** Time allowed to open the socket and authenticate. */
  connectTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  /** false turns automatic reconnection off. */
  reconnect?: ReconnectOptions | false;
  logger?: Logger;
}

export interface RequestOptions {
  timeoutMs?: number;
}

export interface CallServiceOptions {
  target?: HassServiceTarget;
  /** Ask the service for its response data, returned as `response`. */
  returnResponse?: boolean;
}

const SOCKET_OPEN = 1;

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;
const DEFAULT_RECONNECT: Required<ReconnectOptions> = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterMs: 1_000,
};

const defaultLogger: Logger = {
  debug() {},
  info() {},
  warn: (...args) => console.warn('[ha-client]', ...args),
  error: (...args) => console.error('[ha-client]', ...args),
};

interface PendingRequest {
  socket: WebSocketLike;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Subscription {
  payload: CommandPayload;
  onEvent: (event: unknown) => void;
  active: boolean;
  /** Id of the confirmed server-side subscription on the current socket. */
  serverId: number | null;
  /** Id of a subscribe request still waiting for its result. */
  requestId: number | null;
}

/** The startup tasks run for one authenticated socket. */
interface Startup {
  socket: WebSocketLike;
  ran: Set<StartupTask>;
  pending: number;
}

type StateListener = (state: ConnectionState) => void;

/**
 * One connection to Home Assistant's WebSocket API: authentication, numbered requests, event
 * subscriptions that survive reconnects, a heartbeat that notices a silently dead connection, and
 * reconnection with exponential backoff.
 */
export class HomeAssistantConnection {
  /** The normalized Home Assistant origin. */
  readonly baseUrl: string;
  readonly websocketUrl: string;

  #accessToken: string | AccessTokenProvider;
  #WebSocket: WebSocketConstructor;
  #requestTimeoutMs: number;
  #connectTimeoutMs: number;
  #heartbeatIntervalMs: number;
  #heartbeatTimeoutMs: number;
  #reconnect: Required<ReconnectOptions> | null;
  #log: Logger;

  #socket: WebSocketLike | null = null;
  #socketAbort: AbortController | null = null;
  #authenticated = false;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();

  #subscriptions = new Set<Subscription>();
  /** Subscriptions by the id of their subscribe request, which their events carry. */
  #subscriptionsById = new Map<number, Subscription>();
  #startupTasks = new Set<StartupTask>();

  #healthTimer: ReturnType<typeof setTimeout> | null = null;
  #heartbeatId: number | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bumped by every connect and close. State listeners and startup tasks' abort handlers run
   * synchronously and may call connect() or close() themselves, so code that notifies them checks
   * this before carrying on.
   */
  #generation = 0;
  /** The startup in progress while `syncing`. */
  #startup: Startup | null = null;

  #state: ConnectionState = {
    status: 'idle',
    haVersion: null,
    reason: null,
    error: null,
    attempt: 0,
    nextRetryAt: null,
  };
  #listeners = new Set<StateListener>();

  constructor(options: ConnectionOptions) {
    const baseUrl = normalizeBaseUrl(options.url);
    if (!baseUrl) {
      throw new HomeAssistantError(`Not a Home Assistant address: ${options.url}`, 'invalid_url');
    }
    if (typeof options.accessToken === 'string' && !options.accessToken.trim()) {
      throw new HomeAssistantError('An access token is required', 'invalid_token');
    }
    const WebSocketImpl =
      options.WebSocket ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket ?? null;
    if (!WebSocketImpl) {
      throw new Error('No WebSocket implementation available; pass one as options.WebSocket');
    }

    this.baseUrl = baseUrl;
    this.websocketUrl = toWebSocketUrl(baseUrl);
    this.#accessToken =
      typeof options.accessToken === 'string' ? options.accessToken.trim() : options.accessToken;
    this.#WebSocket = WebSocketImpl;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.#reconnect =
      options.reconnect === false ? null : { ...DEFAULT_RECONNECT, ...options.reconnect };
    this.#log = options.logger ?? defaultLogger;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get status(): ConnectionStatus {
    return this.#state.status;
  }

  /**
   * Whether the socket is open and authenticated, i.e. whether request() can succeed. True during
   * `syncing` as well as `connected`.
   */
  isConnected(): boolean {
    return !!this.#socket && this.#socket.readyState === SOCKET_OPEN && this.#authenticated;
  }

  /** Calls the listener on every state change. Returns a function that removes it. */
  onStateChange(listener: StateListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Opens the connection, replacing any current one. */
  connect(): void {
    this.#clearReconnectTimer();
    this.#openSocket();
  }

  /**
   * Reconnects now, skipping any scheduled wait and starting the backoff over. Use it when the
   * user asks to retry, the network comes back, or the machine wakes from sleep.
   */
  reconnect(): void {
    this.#state = { ...this.#state, attempt: 0 };
    this.connect();
  }

  /** Closes the connection and stops reconnecting. */
  close(): void {
    const generation = ++this.#generation;
    this.#clearReconnectTimer();
    const socket = this.#socket;
    if (socket) {
      this.#teardown(socket, new HomeAssistantError('Connection closed', 'connection_lost'));
      // A startup task's abort handler reconnected during teardown; the later call wins.
      if (this.#generation !== generation) return;
    }
    this.#setState({
      status: 'closed',
      reason: null,
      error: null,
      nextRetryAt: null,
    });
  }

  /**
   * Sends a command and resolves with its result. Rejects with a HomeAssistantError carrying Home
   * Assistant's error code when the command fails.
   *
   * Rejects without sending when the socket is not open and authenticated: Home Assistant answers
   * any other message during authentication with auth_invalid and closes, which would look like a
   * revoked token.
   */
  request<T = unknown>(payload: CommandPayload, options: RequestOptions = {}): Promise<T> {
    try {
      return this.#send(payload, options.timeoutMs).result as Promise<T>;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * Starts a subscription (`subscribe_events`, `subscribe_entities`, `subscribe_trigger`, ...) and
   * keeps it alive across reconnects. The handler receives each message's `event`. Returns a
   * function that ends the subscription.
   */
  subscribe<E = unknown>(payload: CommandPayload, onEvent: (event: E) => void): () => void {
    if (!payload || typeof payload.type !== 'string') {
      throw new TypeError('A subscription needs a command type');
    }
    if (typeof onEvent !== 'function') {
      throw new TypeError('A subscription needs an event handler');
    }

    const subscription: Subscription = {
      payload: { ...payload },
      onEvent: onEvent as (event: unknown) => void,
      active: true,
      serverId: null,
      requestId: null,
    };
    this.#subscriptions.add(subscription);
    this.#sendSubscription(subscription);

    return () => {
      if (!subscription.active) return;
      subscription.active = false;
      this.#subscriptions.delete(subscription);
      if (subscription.serverId !== null) {
        this.#subscriptionsById.delete(subscription.serverId);
        this.#sendUnsubscribe(subscription.serverId);
        subscription.serverId = null;
      }
      // An in-flight subscribe request stays registered until it settles. Its success handler sees
      // the subscription is inactive and unsubscribes on the server, instead of leaving a server
      // subscription running for the rest of the socket's life.
    };
  }

  /** Subscribes to a Home Assistant event type, or to every event when none is given. */
  subscribeEvents<E = unknown>(eventType: string | undefined, onEvent: (event: E) => void) {
    return this.subscribe<E>(
      eventType
        ? { type: 'subscribe_events', event_type: eventType }
        : { type: 'subscribe_events' },
      onEvent
    );
  }

  callService(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    options: CallServiceOptions = {}
  ): Promise<CallServiceResult> {
    const payload: CommandPayload = { type: 'call_service', domain, service };
    if (serviceData) payload.service_data = serviceData;
    if (options.target) payload.target = options.target;
    if (options.returnResponse) payload.return_response = true;
    return this.request<CallServiceResult>(payload);
  }

  /**
   * Registers a task to run after every successful authentication; see StartupTask. A task added
   * while `syncing` joins the startup in progress; one added while `connected` first runs on the
   * next connection. Returns a function that removes it.
   */
  addStartupTask(task: StartupTask): () => void {
    this.#startupTasks.add(task);
    if (this.#startup && this.#startup.socket === this.#socket) {
      this.#runStartupTask(this.#startup, task);
    }
    return () => {
      this.#startupTasks.delete(task);
    };
  }

  // --- Socket lifecycle ---

  #openSocket(): void {
    const generation = ++this.#generation;
    const previous = this.#socket;
    if (previous) {
      this.#teardown(previous, new HomeAssistantError('Connection replaced', 'connection_lost'));
      if (this.#generation !== generation) return;
    }

    this.#setState({
      status: 'connecting',
      haVersion: null,
      nextRetryAt: null,
    });
    // A listener closed or reconnected in response.
    if (this.#generation !== generation) return;

    let socket: WebSocketLike;
    try {
      socket = new this.#WebSocket(this.websocketUrl);
    } catch (error) {
      // Browsers throw here for a blocked address, such as ws:// from an https page.
      this.#log.warn('Could not open a WebSocket to Home Assistant:', error);
      this.#afterConnectionLost('socket-error', toError(error));
      return;
    }

    this.#socket = socket;
    this.#socketAbort = new AbortController();
    this.#authenticated = false;
    this.#healthTimer = setTimeout(
      () => this.#failConnection(socket, 'timeout'),
      this.#connectTimeoutMs
    );

    socket.onmessage = (event) => {
      if (this.#socket !== socket) return;
      this.#handleFrame(socket, event.data);
    };

    socket.onerror = () => {
      if (this.#socket !== socket) return;
      // Browsers follow an error with a close event, but Node's WebSocket leaves a socket that
      // failed to connect in CONNECTING without ever closing it, so the error ends the connection.
      // Neither says why it failed.
      this.#log.debug('WebSocket error');
      this.#failConnection(socket, 'socket-error', new Error('Could not reach Home Assistant'));
    };

    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#log.debug('WebSocket closed');
      this.#failConnection(socket, 'socket-closed');
    };
  }

  /**
   * Detaches a socket from the connection: stops its timers, rejects its requests, forgets its
   * server-side subscriptions and closes it. A suspended machine or vanished network can leave a
   * socket that never delivers a close event, so recovery must not wait for one.
   */
  #teardown(socket: WebSocketLike, error: Error): void {
    if (this.#socket === socket) {
      this.#clearHealthCheck();
      this.#socket = null;
      this.#authenticated = false;
      this.#socketAbort?.abort(error);
      this.#socketAbort = null;
      this.#startup = null;
      this.#resetSubscriptionState();
    }
    this.#rejectPending(socket, error);
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // Already closed or never opened.
    }
  }

  #failConnection(socket: WebSocketLike, reason: DisconnectReason, error: Error | null = null) {
    if (this.#socket !== socket) return;
    const generation = this.#generation;
    this.#teardown(socket, new HomeAssistantError('Connection lost', 'connection_lost'));
    // A startup task's abort handler closed or reconnected during teardown.
    if (this.#generation !== generation) return;
    this.#afterConnectionLost(reason, error);
  }

  #afterConnectionLost(reason: DisconnectReason, error: Error | null): void {
    if (!this.#reconnect) {
      this.#setState({ status: 'disconnected', reason, error, nextRetryAt: null });
      return;
    }

    const { baseDelayMs, maxDelayMs, jitterMs } = this.#reconnect;
    const attempt = this.#state.attempt;
    const delay =
      Math.min(baseDelayMs * 2 ** attempt, maxDelayMs) + Math.floor(Math.random() * jitterMs);
    this.#log.debug(`Reconnecting in ${delay} ms (attempt ${attempt + 1})`);
    this.#clearReconnectTimer();
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#openSocket();
    }, delay);
    this.#setState({
      status: 'reconnecting',
      reason,
      error,
      attempt: attempt + 1,
      nextRetryAt: Date.now() + delay,
    });
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer === null) return;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  // --- Heartbeat ---

  #clearHealthCheck(): void {
    if (this.#healthTimer !== null) clearTimeout(this.#healthTimer);
    this.#healthTimer = null;
    this.#heartbeatId = null;
  }

  // A suspended machine or vanished network can leave readyState OPEN indefinitely. Home
  // Assistant's ping/pong checks the server, not merely the local socket.
  #scheduleHeartbeat(socket: WebSocketLike): void {
    this.#clearHealthCheck();
    this.#healthTimer = setTimeout(() => {
      if (this.#socket !== socket || !this.#authenticated) return;
      const id = this.#nextId++;
      this.#heartbeatId = id;
      this.#healthTimer = setTimeout(
        () => this.#failConnection(socket, 'timeout'),
        this.#heartbeatTimeoutMs
      );
      try {
        socket.send(JSON.stringify({ id, type: 'ping' }));
      } catch (error) {
        this.#failConnection(socket, 'socket-error', toError(error));
      }
    }, this.#heartbeatIntervalMs);
  }

  // --- Incoming messages ---

  #handleFrame(socket: WebSocketLike, data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch (error) {
      this.#log.warn('Ignoring a message that is not JSON:', error);
      return;
    }
    // With coalesce_messages, Home Assistant may send several messages in one frame as an array.
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      // A message can tear the socket down (auth_invalid), so the rest of the frame is dropped.
      if (this.#socket !== socket) return;
      if (!message || typeof message !== 'object') continue;
      try {
        this.#handleMessage(socket, message as IncomingMessage);
      } catch (error) {
        this.#log.error('Error handling a Home Assistant message:', error);
      }
    }
  }

  #handleMessage(socket: WebSocketLike, message: IncomingMessage): void {
    switch (message.type) {
      case 'auth_required':
        this.#authenticate(socket);
        return;

      case 'auth_ok':
        this.#onAuthenticated(socket, message.ha_version);
        return;

      case 'auth_invalid': {
        this.#clearReconnectTimer();
        const error = new HomeAssistantError(
          message.message || 'Home Assistant rejected the access token',
          'auth_invalid'
        );
        this.#log.warn('Home Assistant rejected the access token');
        const generation = this.#generation;
        this.#teardown(socket, error);
        if (this.#generation !== generation) return;
        this.#setState({ status: 'auth-failed', reason: null, error, nextRetryAt: null });
        return;
      }

      case 'pong':
        if (this.#heartbeatId !== null && message.id === this.#heartbeatId) {
          this.#scheduleHeartbeat(socket);
        }
        return;

      case 'ping':
        try {
          socket.send(
            JSON.stringify(
              message.id === undefined ? { type: 'pong' } : { id: message.id, type: 'pong' }
            )
          );
        } catch (error) {
          this.#log.warn('Failed to answer a ping from Home Assistant:', error);
        }
        return;

      case 'result': {
        const pending = this.#pending.get(message.id);
        if (!pending || pending.socket !== socket) return;
        this.#clearPending(message.id);
        if (message.success) {
          pending.resolve(message.result);
        } else {
          const details = message.error;
          pending.reject(
            new HomeAssistantError(
              details?.message || 'Home Assistant rejected the request',
              details?.code || 'unknown_error',
              details
            )
          );
        }
        return;
      }

      case 'event': {
        const subscription = this.#subscriptionsById.get(message.id);
        if (!subscription?.active) return;
        try {
          subscription.onEvent(message.event);
        } catch (error) {
          this.#log.error('Error in a subscription event handler:', error);
        }
        return;
      }
    }
  }

  #authenticate(socket: WebSocketLike): void {
    const token = this.#accessToken;
    Promise.resolve()
      .then(() => (typeof token === 'function' ? token() : token))
      .then((accessToken) => {
        if (this.#socket !== socket || socket.readyState !== SOCKET_OPEN) return;
        if (typeof accessToken !== 'string' || !accessToken.trim()) {
          throw new HomeAssistantError('No access token available', 'invalid_token');
        }
        socket.send(JSON.stringify({ type: 'auth', access_token: accessToken.trim() }));
      })
      .catch((error: unknown) => {
        this.#log.warn('Could not authenticate with Home Assistant:', error);
        this.#failConnection(socket, 'token-unavailable', toError(error));
      });
  }

  #onAuthenticated(socket: WebSocketLike, haVersion: string): void {
    this.#authenticated = true;
    this.#scheduleHeartbeat(socket);
    this.#setState({ status: 'syncing', haVersion, reason: null, error: null });
    // A listener closed or replaced the connection in response.
    if (this.#socket !== socket) return;

    // Lets Home Assistant batch messages into one frame, as its own frontend does. Sent first so it
    // applies to the subscriptions below. Servers that predate it answer with an error, ignored.
    this.request({ type: 'supported_features', features: { coalesce_messages: 1 } }).catch(
      () => {}
    );
    for (const subscription of this.#subscriptions) this.#sendSubscription(subscription);

    const startup: Startup = { socket, ran: new Set(), pending: 0 };
    this.#startup = startup;
    for (const task of [...this.#startupTasks]) this.#runStartupTask(startup, task);
    this.#finishStartupIfDone(startup);
  }

  #runStartupTask(startup: Startup, task: StartupTask): void {
    if (startup.ran.has(task)) return;
    startup.ran.add(task);
    startup.pending += 1;
    let result: Promise<void>;
    try {
      result = Promise.resolve(task(this.#socketAbort!.signal));
    } catch (error) {
      result = Promise.reject(error);
    }
    result.then(
      () => {
        if (this.#startup !== startup) return;
        startup.pending -= 1;
        this.#finishStartupIfDone(startup);
      },
      (error: unknown) => {
        if (this.#startup !== startup) return;
        this.#log.warn('A startup task failed; reconnecting:', error);
        this.#failConnection(startup.socket, 'startup-failed', toError(error));
      }
    );
  }

  #finishStartupIfDone(startup: Startup): void {
    if (this.#startup !== startup || startup.pending > 0) return;
    if (this.#socket !== startup.socket || !this.#authenticated) return;
    this.#startup = null;
    // The backoff starts over only once the client has live data. A server that accepts the login
    // but can't deliver the first snapshot would otherwise be retried at the shortest delay every
    // time.
    this.#setState({ status: 'connected', attempt: 0 });
  }

  // --- Requests ---

  /** A null timeout waits as long as the socket lives. */
  #send(payload: CommandPayload, timeoutMs: number | null = this.#requestTimeoutMs) {
    const socket = this.#socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      throw new HomeAssistantError('Not connected to Home Assistant', 'not_connected');
    }
    if (!this.#authenticated) {
      throw new HomeAssistantError(
        'Not yet authenticated with Home Assistant',
        'not_authenticated'
      );
    }

    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              if (!this.#clearPending(id)) return;
              reject(new HomeAssistantError(`No reply to ${payload.type} in time`, 'timeout'));
            }, timeoutMs);
      this.#pending.set(id, { socket, resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ ...payload, id }));
      } catch (error) {
        this.#clearPending(id);
        reject(toError(error));
      }
    });
    return { id, result };
  }

  #clearPending(id: number): PendingRequest | null {
    const pending = this.#pending.get(id);
    if (!pending) return null;
    this.#pending.delete(id);
    if (pending.timer !== null) clearTimeout(pending.timer);
    return pending;
  }

  #rejectPending(socket: WebSocketLike, error: Error): void {
    for (const [id, pending] of this.#pending) {
      if (pending.socket !== socket) continue;
      this.#clearPending(id);
      pending.reject(error);
    }
  }

  // --- Subscriptions ---

  #sendSubscription(subscription: Subscription): void {
    if (!subscription.active) return;
    if (subscription.serverId !== null || subscription.requestId !== null) return;
    if (!this.isConnected()) return;

    let request: { id: number; result: Promise<unknown> };
    try {
      // No timeout: a subscribe request that timed out on a live socket would leave the subscription
      // silent until the next reconnect, and a late confirmation would leave a server subscription
      // nobody tracks. A dead socket is caught by the heartbeat, which rejects this request.
      request = this.#send(subscription.payload, null);
    } catch (error) {
      this.#log.warn('Could not send a subscription request:', error);
      return;
    }
    const { id } = request;
    subscription.requestId = id;
    // Registered before the result arrives: with coalescing, the first event can arrive in the
    // same frame as the result, before the promise below settles.
    this.#subscriptionsById.set(id, subscription);

    request.result.then(
      () => {
        if (subscription.requestId !== id) return;
        subscription.requestId = null;
        if (!subscription.active) {
          this.#subscriptionsById.delete(id);
          this.#sendUnsubscribe(id);
          return;
        }
        subscription.serverId = id;
      },
      (error: unknown) => {
        if (this.#subscriptionsById.get(id) === subscription) this.#subscriptionsById.delete(id);
        if (subscription.requestId !== id) return;
        subscription.requestId = null;
        if (subscription.active && !isConnectionLoss(error)) {
          this.#log.warn(`Subscription ${subscription.payload.type} failed:`, error);
        }
      }
    );
  }

  #sendUnsubscribe(subscriptionId: number): void {
    if (!this.isConnected()) return;
    this.request({ type: 'unsubscribe_events', subscription: subscriptionId }).catch((error) => {
      if (!isConnectionLoss(error)) this.#log.warn('Unsubscribe failed:', error);
    });
  }

  /** Server-side subscriptions die with their socket; they are sent again after authentication. */
  #resetSubscriptionState(): void {
    this.#subscriptionsById.clear();
    for (const subscription of this.#subscriptions) {
      subscription.serverId = null;
      subscription.requestId = null;
    }
  }

  // --- State ---

  #setState(patch: Partial<ConnectionState>): void {
    const next = { ...this.#state, ...patch };
    const current = this.#state;
    if (
      next.status === current.status &&
      next.haVersion === current.haVersion &&
      next.reason === current.reason &&
      next.error === current.error &&
      next.attempt === current.attempt &&
      next.nextRetryAt === current.nextRetryAt
    ) {
      return;
    }
    this.#state = next;
    for (const listener of [...this.#listeners]) {
      // A listener changed the state again, and that change already reached every listener.
      if (this.#state !== next) return;
      try {
        listener(next);
      } catch (error) {
        this.#log.error('Error in a connection state listener:', error);
      }
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isConnectionLoss(error: unknown): boolean {
  return error instanceof HomeAssistantError && error.code === 'connection_lost';
}
