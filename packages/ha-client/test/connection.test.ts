import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { HomeAssistantConnection, type ConnectionOptions } from '../src/connection.ts';
import { HomeAssistantError } from '../src/errors.ts';
import { FakeSocket, flush } from './fake-socket.ts';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function createConnection(options: Partial<ConnectionOptions> = {}) {
  return new HomeAssistantConnection({
    url: 'http://homeassistant.local:8123',
    accessToken: 'secret-token',
    WebSocket: FakeSocket,
    reconnect: { baseDelayMs: 1000, maxDelayMs: 30000, jitterMs: 0 },
    logger: silentLogger,
    ...options,
  });
}

async function connected(options: Partial<ConnectionOptions> = {}) {
  const connection = createConnection(options);
  connection.connect();
  await FakeSocket.latest.acceptAuth();
  await flush();
  return { connection, socket: FakeSocket.latest };
}

beforeEach(() => {
  FakeSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('construction', () => {
  test('rejects an address that is not one', () => {
    expect(() => createConnection({ url: 'ftp://example.com' })).toThrow(HomeAssistantError);
    expect(() => createConnection({ url: '' })).toThrow(/Not a Home Assistant address/);
  });

  test('rejects an empty token', () => {
    expect(() => createConnection({ accessToken: '  ' })).toThrow(/access token/);
  });

  test('connects to the WebSocket API at the server root', () => {
    const connection = createConnection({ url: 'https://ha.example.com/lovelace/0/' });
    connection.connect();
    expect(FakeSocket.latest.url).toBe('wss://ha.example.com/api/websocket');
    expect(connection.status).toBe('connecting');
  });
});

describe('authentication', () => {
  test('sends the token when Home Assistant asks for it', async () => {
    const connection = createConnection();
    connection.connect();
    FakeSocket.latest.open();
    await flush();
    expect(FakeSocket.latest.sent).toEqual([{ type: 'auth', access_token: 'secret-token' }]);
    expect(connection.isConnected()).toBe(false);
  });

  test('asks a token provider for a current token on every connection', async () => {
    let calls = 0;
    const connection = createConnection({ accessToken: async () => `token-${++calls}` });
    connection.connect();
    await FakeSocket.latest.acceptAuth();
    expect(FakeSocket.latest.lastSent('auth').access_token).toBe('token-1');

    FakeSocket.latest.drop();
    await vi.advanceTimersByTimeAsync(1000);
    FakeSocket.latest.open();
    await flush();
    expect(FakeSocket.latest.lastSent('auth').access_token).toBe('token-2');
    connection.close();
  });

  test('reaches connected after auth_ok and reports the version', async () => {
    const { connection } = await connected();
    expect(connection.status).toBe('connected');
    expect(connection.state.haVersion).toBe('2026.10.0');
    expect(connection.isConnected()).toBe(true);
    connection.close();
  });

  test('stops, without retrying, when the token is rejected', async () => {
    const connection = createConnection();
    connection.connect();
    const socket = FakeSocket.latest;
    socket.open();
    await flush();
    socket.receive({ type: 'auth_invalid', message: 'Invalid access token' });

    expect(connection.status).toBe('auth-failed');
    expect(connection.state.error).toMatchObject({ code: 'auth_invalid' });
    expect(socket.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test('times out a server that opens the socket but never authenticates', async () => {
    const connection = createConnection();
    connection.connect();
    FakeSocket.latest.open();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(connection.state).toMatchObject({ status: 'reconnecting', reason: 'timeout' });
    connection.close();
  });

  test('retries when the token provider fails', async () => {
    const connection = createConnection({
      accessToken: () => Promise.reject(new Error('refresh failed')),
    });
    connection.connect();
    FakeSocket.latest.open();
    await flush();
    expect(connection.state).toMatchObject({ status: 'reconnecting', reason: 'token-unavailable' });
    connection.close();
  });
});

describe('requests', () => {
  test('rejects between open and auth_ok without sending anything', async () => {
    const connection = createConnection();
    connection.connect();
    FakeSocket.latest.open();
    await flush();
    await expect(connection.request({ type: 'get_config' })).rejects.toMatchObject({
      code: 'not_authenticated',
    });
    expect(FakeSocket.latest.sentOfType('get_config')).toHaveLength(0);
  });

  test('rejects when not connected', async () => {
    const connection = createConnection();
    await expect(connection.request({ type: 'get_config' })).rejects.toMatchObject({
      code: 'not_connected',
    });
  });

  test('numbers requests and resolves with the result', async () => {
    const { connection, socket } = await connected();
    const first = connection.request({ type: 'get_config' });
    const second = connection.request({ type: 'get_services' });
    const ids = [socket.lastSent('get_config').id, socket.lastSent('get_services').id];
    expect(ids[1]).toBeGreaterThan(ids[0]!);

    socket.reply('get_services', { light: {} });
    socket.reply('get_config', { location_name: 'Home' });
    await expect(first).resolves.toEqual({ location_name: 'Home' });
    await expect(second).resolves.toEqual({ light: {} });
    connection.close();
  });

  test("rejects with Home Assistant's error code", async () => {
    const { connection, socket } = await connected();
    const request = connection.request({ type: 'config/floor_registry/list' });
    socket.receive({
      id: socket.lastSent('config/floor_registry/list').id,
      type: 'result',
      success: false,
      error: { code: 'unknown_command', message: 'Unknown command.' },
    });
    await expect(request).rejects.toMatchObject({
      name: 'HomeAssistantError',
      code: 'unknown_command',
      message: 'Unknown command.',
    });
    connection.close();
  });

  test('times out', async () => {
    const { connection } = await connected();
    const request = connection.request({ type: 'get_config' }, { timeoutMs: 500 });
    const assertion = expect(request).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    connection.close();
  });

  test('rejects pending requests as soon as the socket drops', async () => {
    const { connection, socket } = await connected();
    const request = connection.request({ type: 'get_config' });
    socket.drop();
    await expect(request).rejects.toMatchObject({ code: 'connection_lost' });
    connection.close();
  });

  test('ignores results delivered by a replaced socket', async () => {
    const { connection, socket: oldSocket } = await connected();
    const request = connection.request({ type: 'get_config' });
    const settled = request.catch((error: unknown) => error);
    connection.connect();
    oldSocket.readyState = 1;
    oldSocket.reply('get_config', { stale: true });
    expect(await settled).toMatchObject({ code: 'connection_lost' });
    connection.close();
  });

  test('handles messages coalesced into one frame', async () => {
    const { connection, socket } = await connected();
    const first = connection.request({ type: 'get_config' });
    const second = connection.request({ type: 'get_services' });
    socket.onmessage?.({
      data: JSON.stringify([
        { id: socket.lastSent('get_config').id, type: 'result', success: true, result: 1 },
        { id: socket.lastSent('get_services').id, type: 'result', success: true, result: 2 },
      ]),
    });
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    connection.close();
  });

  test('asks Home Assistant to coalesce messages after authenticating', async () => {
    const { connection, socket } = await connected();
    expect(socket.lastSent('supported_features').features).toEqual({ coalesce_messages: 1 });
    connection.close();
  });

  test('ignores frames that are not JSON', async () => {
    const { connection, socket } = await connected();
    socket.onmessage?.({ data: 'not json' });
    expect(connection.status).toBe('connected');
    connection.close();
  });
});

describe('service calls', () => {
  test('sends target and service data', async () => {
    const { connection, socket } = await connected();
    const call = connection.callService(
      'light',
      'turn_on',
      { brightness_pct: 10 },
      { target: { area_id: 'hallway' } }
    );
    expect(socket.lastSent('call_service')).toMatchObject({
      domain: 'light',
      service: 'turn_on',
      service_data: { brightness_pct: 10 },
      target: { area_id: 'hallway' },
    });
    expect(socket.lastSent('call_service')).not.toHaveProperty('return_response');
    socket.reply('call_service', { context: { id: 'abc', parent_id: null, user_id: null } });
    await expect(call).resolves.toMatchObject({ context: { id: 'abc' } });
    connection.close();
  });

  test('asks for the response when requested', async () => {
    const { connection, socket } = await connected();
    const call = connection.callService('weather', 'get_forecasts', undefined, {
      target: { entity_id: 'weather.home' },
      returnResponse: true,
    });
    expect(socket.lastSent('call_service').return_response).toBe(true);
    socket.reply('call_service', { context: { id: 'x' }, response: { forecast: [] } });
    await expect(call).resolves.toMatchObject({ response: { forecast: [] } });
    connection.close();
  });
});

describe('subscriptions', () => {
  test('subscribes after authentication and routes events', async () => {
    const connection = createConnection();
    const events: unknown[] = [];
    connection.subscribeEvents('state_changed', (event) => events.push(event));
    connection.connect();
    const socket = FakeSocket.latest;
    await socket.acceptAuth();

    const subscribe = socket.lastSent('subscribe_events');
    expect(subscribe.event_type).toBe('state_changed');
    socket.reply('subscribe_events');
    socket.receive({ id: subscribe.id, type: 'event', event: { n: 1 } });
    socket.receive({ id: 9999, type: 'event', event: { n: 'other' } });
    expect(events).toEqual([{ n: 1 }]);
    connection.close();
  });

  test('delivers an event that arrives in the same frame as the subscribe result', async () => {
    const { connection, socket } = await connected();
    const events: unknown[] = [];
    connection.subscribe({ type: 'subscribe_entities' }, (event) => events.push(event));
    const { id } = socket.lastSent('subscribe_entities');
    socket.onmessage?.({
      data: JSON.stringify([
        { id, type: 'result', success: true, result: null },
        { id, type: 'event', event: { a: {} } },
      ]),
    });
    expect(events).toEqual([{ a: {} }]);
    connection.close();
  });

  test('unsubscribes on the server', async () => {
    const { connection, socket } = await connected();
    const events: unknown[] = [];
    const unsubscribe = connection.subscribeEvents(undefined, (event) => events.push(event));
    const { id } = socket.lastSent('subscribe_events');
    expect(socket.lastSent('subscribe_events')).not.toHaveProperty('event_type');
    socket.reply('subscribe_events');
    await flush();

    unsubscribe();
    expect(socket.lastSent('unsubscribe_events').subscription).toBe(id);
    socket.receive({ id, type: 'event', event: {} });
    expect(events).toEqual([]);
    connection.close();
  });

  test('unsubscribes a server subscription that is confirmed after it was cancelled', async () => {
    const { connection, socket } = await connected();
    const unsubscribe = connection.subscribeEvents('state_changed', () => {});
    const { id } = socket.lastSent('subscribe_events');
    unsubscribe();
    expect(socket.sentOfType('unsubscribe_events')).toHaveLength(0);

    socket.reply('subscribe_events');
    await flush();
    expect(socket.lastSent('unsubscribe_events').subscription).toBe(id);
    connection.close();
  });

  test('subscribes again on the new socket after a reconnect', async () => {
    const { connection, socket } = await connected();
    const events: unknown[] = [];
    connection.subscribeEvents('state_changed', (event) => events.push(event));
    socket.reply('subscribe_events');
    socket.drop();

    await vi.advanceTimersByTimeAsync(1000);
    const replacement = FakeSocket.latest;
    expect(replacement).not.toBe(socket);
    await replacement.acceptAuth();
    const { id } = replacement.lastSent('subscribe_events');
    replacement.reply('subscribe_events');
    replacement.receive({ id, type: 'event', event: { n: 2 } });
    expect(events).toEqual([{ n: 2 }]);
    connection.close();
  });

  test('keeps a throwing handler from breaking the connection', async () => {
    const { connection, socket } = await connected();
    connection.subscribeEvents('state_changed', () => {
      throw new Error('handler bug');
    });
    const { id } = socket.lastSent('subscribe_events');
    socket.reply('subscribe_events');
    socket.receive({ id, type: 'event', event: {} });
    expect(connection.status).toBe('connected');
    connection.close();
  });
});

describe('heartbeat', () => {
  test('pings after the interval and keeps going on a matching pong', async () => {
    const { connection, socket } = await connected();
    await vi.advanceTimersByTimeAsync(30_000);
    const ping = socket.lastSent('ping');
    socket.receive({ id: ping.id + 1000, type: 'pong' });
    await vi.advanceTimersByTimeAsync(1000);
    socket.receive({ id: ping.id, type: 'pong' });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.sentOfType('ping')).toHaveLength(2);
    expect(connection.status).toBe('connected');
    connection.close();
  });

  test('drops a connection whose server stops answering, without waiting for a close event', async () => {
    const { connection, socket } = await connected();
    const request = connection.request({ type: 'get_config' }, { timeoutMs: 120_000 });
    const settled = request.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000 + 15_000);

    expect(connection.state).toMatchObject({ status: 'reconnecting', reason: 'timeout' });
    expect(socket.closed).toBe(true);
    expect(await settled).toMatchObject({ code: 'connection_lost' });
    connection.close();
  });

  test('answers a ping from the server', async () => {
    const { connection, socket } = await connected();
    socket.receive({ id: 5, type: 'ping' });
    expect(socket.lastSent('pong')).toEqual({ id: 5, type: 'pong' });
    connection.close();
  });
});

describe('reconnection', () => {
  test('backs off exponentially up to the maximum', async () => {
    const connection = createConnection();
    connection.connect();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      FakeSocket.latest.drop();
      const { nextRetryAt } = connection.state;
      delays.push(nextRetryAt! - Date.now());
      await vi.advanceTimersByTimeAsync(nextRetryAt! - Date.now());
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    connection.close();
  });

  test('starts the backoff over once connected', async () => {
    const { connection, socket } = await connected();
    socket.drop();
    await vi.advanceTimersByTimeAsync(1000);
    FakeSocket.latest.drop();
    expect(connection.state.attempt).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    await FakeSocket.latest.acceptAuth();
    await flush();
    expect(connection.state).toMatchObject({ status: 'connected', attempt: 0 });
    connection.close();
  });

  test('retries on a socket error without waiting for a close event', async () => {
    const connection = createConnection();
    connection.connect();
    const socket = FakeSocket.latest;
    // Node's WebSocket reports a failed connection with an error and no close.
    socket.onerror?.({});
    expect(connection.state).toMatchObject({
      status: 'reconnecting',
      reason: 'socket-error',
      attempt: 1,
      error: { message: 'Could not reach Home Assistant' },
    });
    expect(socket.closed).toBe(true);
    // A browser's close event after the error changes nothing.
    socket.drop();
    expect(connection.state.attempt).toBe(1);
    connection.close();
  });

  test('reconnect() skips the wait and resets the backoff', async () => {
    const connection = createConnection();
    connection.connect();
    FakeSocket.latest.drop();
    FakeSocket.latest.drop();
    connection.reconnect();
    expect(FakeSocket.instances).toHaveLength(2);
    expect(connection.state).toMatchObject({ status: 'connecting', attempt: 0 });
    FakeSocket.latest.drop();
    expect(connection.state.nextRetryAt! - Date.now()).toBe(1000);
    connection.close();
  });

  test('does not reconnect when turned off', async () => {
    const { connection, socket } = await connected({ reconnect: false });
    socket.drop();
    expect(connection.state).toMatchObject({ status: 'disconnected', reason: 'socket-closed' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  test('close() stops reconnecting and ignores the old socket', async () => {
    const { connection, socket } = await connected();
    connection.close();
    expect(connection.status).toBe('closed');
    socket.drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(connection.status).toBe('closed');
  });

  test('ignores a replaced socket closing after its replacement authenticates', async () => {
    const { connection, socket: oldSocket } = await connected();
    connection.connect();
    await FakeSocket.latest.acceptAuth();
    await flush();
    oldSocket.drop();
    expect(connection.status).toBe('connected');
    connection.close();
  });
});

describe('startup tasks', () => {
  test('hold the connection at syncing until they finish', async () => {
    const connection = createConnection();
    let finish!: () => void;
    connection.addStartupTask(() => new Promise<void>((resolve) => (finish = resolve)));
    connection.connect();
    await FakeSocket.latest.acceptAuth();
    await flush();
    expect(connection.status).toBe('syncing');
    expect(connection.isConnected()).toBe(true);
    finish();
    await flush();
    expect(connection.status).toBe('connected');
    connection.close();
  });

  test('a failed task reconnects without resetting the backoff', async () => {
    const connection = createConnection();
    connection.addStartupTask(() => Promise.reject(new Error('snapshot failed')));
    connection.connect();
    await FakeSocket.latest.acceptAuth();
    await flush();
    expect(connection.state).toMatchObject({
      status: 'reconnecting',
      reason: 'startup-failed',
      attempt: 1,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await FakeSocket.latest.acceptAuth();
    await flush();
    expect(connection.state).toMatchObject({ status: 'reconnecting', attempt: 2 });
    expect(connection.state.nextRetryAt! - Date.now()).toBe(2000);
    connection.close();
  });

  test('receive a signal that aborts when the socket goes away', async () => {
    const connection = createConnection();
    let signal!: AbortSignal;
    connection.addStartupTask((s) => {
      signal = s;
      return new Promise(() => {});
    });
    connection.connect();
    await FakeSocket.latest.acceptAuth();
    expect(signal.aborted).toBe(false);
    FakeSocket.latest.drop();
    expect(signal.aborted).toBe(true);
    connection.close();
  });
});

describe('state changes', () => {
  test('a listener that closes on connecting stops the socket from opening', async () => {
    const connection = createConnection();
    connection.onStateChange((state) => {
      if (state.status === 'connecting') connection.close();
    });
    connection.connect();
    expect(connection.status).toBe('closed');
    expect(FakeSocket.instances).toHaveLength(0);
  });

  test('a listener that reconnects on connecting leaves one socket', async () => {
    const connection = createConnection();
    let reconnected = false;
    connection.onStateChange((state) => {
      if (state.status === 'connecting' && !reconnected) {
        reconnected = true;
        connection.connect();
      }
    });
    connection.connect();
    expect(FakeSocket.instances).toHaveLength(1);
    await FakeSocket.latest.acceptAuth();
    await flush();
    expect(connection.status).toBe('connected');
    connection.close();
  });

  test('a listener that closes on syncing stops startup cleanly', async () => {
    const errors: unknown[] = [];
    const connection = createConnection({
      logger: { ...silentLogger, error: (...args: unknown[]) => errors.push(args) },
    });
    let taskRuns = 0;
    connection.addStartupTask(async () => {
      taskRuns += 1;
    });
    connection.onStateChange((state) => {
      if (state.status === 'syncing') connection.close();
    });
    connection.connect();
    await FakeSocket.latest.acceptAuth();
    await flush();
    expect(connection.status).toBe('closed');
    expect(taskRuns).toBe(0);
    expect(errors).toEqual([]);
  });

  test('are reported in order', async () => {
    const connection = createConnection();
    const statuses: string[] = [];
    connection.onStateChange((state) => statuses.push(state.status));
    connection.connect();
    await FakeSocket.latest.acceptAuth();
    await flush();
    FakeSocket.latest.drop();
    connection.close();
    expect(statuses).toEqual(['connecting', 'syncing', 'connected', 'reconnecting', 'closed']);
  });
});
