import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { HomeAssistantConnection } from '../src/connection.ts';
import { EntityStore, applyDiff, decodeState, type EntitiesChange } from '../src/entities.ts';
import { FakeSocket, flush } from './fake-socket.ts';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

// 2026-10-13T00:00:00Z
const T0 = 1791849600;

function createConnection() {
  return new HomeAssistantConnection({
    url: 'http://homeassistant.local:8123',
    accessToken: 'secret-token',
    WebSocket: FakeSocket,
    reconnect: { baseDelayMs: 1000, maxDelayMs: 30000, jitterMs: 0 },
    logger: silentLogger,
  });
}

function sendEntities(socket: FakeSocket, event: unknown) {
  socket.receive({ id: socket.lastSent('subscribe_entities').id, type: 'event', event });
}

const snapshot = {
  a: {
    'light.hallway': { s: 'off', a: { friendly_name: 'Hallway' }, c: 'ctx1', lc: T0 },
    'sensor.temperature': {
      s: '21.5',
      a: { unit_of_measurement: '°C' },
      c: 'ctx2',
      lc: T0,
      lu: T0 + 60,
    },
  },
};

beforeEach(() => {
  FakeSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('decoding', () => {
  test('expands a compressed state into the get_states shape', () => {
    expect(decodeState('sensor.temperature', snapshot.a['sensor.temperature'])).toEqual({
      entity_id: 'sensor.temperature',
      state: '21.5',
      attributes: { unit_of_measurement: '°C' },
      last_changed: '2026-10-13T00:00:00.000Z',
      last_updated: '2026-10-13T00:01:00.000Z',
      context: { id: 'ctx2', parent_id: null, user_id: null },
    });
  });

  test('uses last_changed for last_updated when Home Assistant omits it', () => {
    const entity = decodeState('light.hallway', snapshot.a['light.hallway']);
    expect(entity.last_updated).toBe(entity.last_changed);
  });

  test('applies a state change as a new object', () => {
    const before = decodeState('light.hallway', snapshot.a['light.hallway']);
    const after = applyDiff(before, {
      '+': { s: 'on', a: { brightness: 26 }, c: 'ctx3', lc: T0 + 120 },
    });
    expect(after).not.toBe(before);
    expect(before.state).toBe('off');
    expect(after).toMatchObject({
      state: 'on',
      attributes: { friendly_name: 'Hallway', brightness: 26 },
      last_changed: '2026-10-13T00:02:00.000Z',
      last_updated: '2026-10-13T00:02:00.000Z',
      context: { id: 'ctx3' },
    });
  });

  test('applies an attribute-only change and removes attributes', () => {
    const before = decodeState('light.hallway', {
      s: 'on',
      a: { friendly_name: 'Hallway', brightness: 26 },
      lc: T0,
    });
    const after = applyDiff(before, { '+': { lu: T0 + 5 }, '-': { a: ['brightness'] } });
    expect(after.attributes).toEqual({ friendly_name: 'Hallway' });
    expect(before.attributes).toHaveProperty('brightness');
    expect(after.last_changed).toBe(before.last_changed);
    expect(after.last_updated).toBe('2026-10-13T00:00:05.000Z');
  });
});

describe('EntityStore', () => {
  test('holds the connection at syncing until the snapshot arrives', async () => {
    const connection = createConnection();
    const store = new EntityStore(connection);
    connection.connect();
    const socket = FakeSocket.latest;
    await socket.acceptAuth();
    await flush();
    expect(connection.status).toBe('syncing');
    expect(store.hasSnapshot).toBe(false);

    socket.reply('subscribe_entities');
    sendEntities(socket, snapshot);
    await flush();
    expect(connection.status).toBe('connected');
    expect(store.size).toBe(2);
    expect(store.get('light.hallway')?.state).toBe('off');
    connection.close();
  });

  test('follows only the requested entities', async () => {
    const connection = createConnection();
    new EntityStore(connection, { entityIds: ['light.hallway'] });
    connection.connect();
    await FakeSocket.latest.acceptAuth();
    expect(FakeSocket.latest.lastSent('subscribe_entities').entity_ids).toEqual(['light.hallway']);
    connection.close();
  });

  test('applies additions, changes and removals and reports them', async () => {
    const connection = createConnection();
    const store = new EntityStore(connection);
    const changes: EntitiesChange[] = [];
    store.onChange((change) => changes.push(change));
    connection.connect();
    const socket = FakeSocket.latest;
    await socket.acceptAuth();
    sendEntities(socket, snapshot);

    sendEntities(socket, {
      a: { 'switch.fan': { s: 'on', lc: T0 } },
      c: { 'light.hallway': { '+': { s: 'on', lc: T0 + 1 } } },
      r: ['sensor.temperature'],
    });

    expect(store.all().map((entity) => entity.entity_id)).toEqual(['light.hallway', 'switch.fan']);
    expect(store.get('light.hallway')?.state).toBe('on');
    expect(changes).toEqual([
      { snapshot: true, changed: ['light.hallway', 'sensor.temperature'], removed: [] },
      {
        snapshot: false,
        changed: ['switch.fan', 'light.hallway'],
        removed: ['sensor.temperature'],
      },
    ]);
    connection.close();
  });

  test('replaces everything with the fresh snapshot after a reconnect', async () => {
    const connection = createConnection();
    const store = new EntityStore(connection);
    connection.connect();
    await FakeSocket.latest.acceptAuth();
    sendEntities(FakeSocket.latest, snapshot);
    FakeSocket.latest.drop();

    await vi.advanceTimersByTimeAsync(1000);
    const socket = FakeSocket.latest;
    await socket.acceptAuth();
    await flush();
    expect(connection.status).toBe('syncing');
    // Still showing the last known states while the new snapshot loads.
    expect(store.size).toBe(2);

    sendEntities(socket, { a: { 'light.hallway': { s: 'on', lc: T0 + 300 } } });
    await flush();
    expect(connection.status).toBe('connected');
    expect(store.all().map((entity) => entity.entity_id)).toEqual(['light.hallway']);
    connection.close();
  });

  test('reconnects with a longer wait when the snapshot does not arrive in time', async () => {
    const connection = createConnection();
    new EntityStore(connection, { snapshotTimeoutMs: 10_000 });
    connection.connect();
    await FakeSocket.latest.acceptAuth();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(connection.state).toMatchObject({ status: 'reconnecting', reason: 'startup-failed' });

    await vi.advanceTimersByTimeAsync(1000);
    await FakeSocket.latest.acceptAuth();
    await vi.advanceTimersByTimeAsync(10_000);
    // The second attempt waits twice as long.
    expect(connection.status).toBe('syncing');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connection.status).toBe('reconnecting');
    connection.close();
  });

  test('can be created on a connection that is already connected', async () => {
    const connection = createConnection();
    connection.connect();
    await FakeSocket.latest.acceptAuth();
    await flush();
    expect(connection.status).toBe('connected');

    const store = new EntityStore(connection);
    sendEntities(FakeSocket.latest, snapshot);
    expect(store.hasSnapshot).toBe(true);
    expect(store.size).toBe(2);
    connection.close();
  });

  test('dispose() unsubscribes and stops gating the connection', async () => {
    const connection = createConnection();
    const store = new EntityStore(connection);
    connection.connect();
    const socket = FakeSocket.latest;
    await socket.acceptAuth();
    socket.reply('subscribe_entities');
    sendEntities(socket, snapshot);
    await flush();

    store.dispose();
    expect(socket.lastSent('unsubscribe_events').subscription).toBe(
      socket.lastSent('subscribe_entities').id
    );

    socket.drop();
    await vi.advanceTimersByTimeAsync(1000);
    await FakeSocket.latest.acceptAuth();
    await flush();
    expect(connection.status).toBe('connected');
    expect(FakeSocket.latest.sentOfType('subscribe_entities')).toHaveLength(0);
    connection.close();
  });
});
