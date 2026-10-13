import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { HomeAssistantConnection } from '../src/connection.ts';
import { fetchHomeRegistries, resolveEntityAreaId } from '../src/registries.ts';
import { FakeSocket, flush } from './fake-socket.ts';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

async function connected() {
  const connection = new HomeAssistantConnection({
    url: 'http://homeassistant.local:8123',
    accessToken: 'secret-token',
    WebSocket: FakeSocket,
    logger: silentLogger,
  });
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

describe('fetchHomeRegistries', () => {
  test('fetches the four registries together', async () => {
    const { connection, socket } = await connected();
    const registries = fetchHomeRegistries(connection);
    socket.reply('config/floor_registry/list', [{ floor_id: 'ground', name: 'Ground', level: 0 }]);
    socket.reply('config/area_registry/list', [{ area_id: 'hallway', floor_id: 'ground' }]);
    socket.reply('config/device_registry/list', [{ id: 'dev1', area_id: 'hallway' }]);
    socket.reply('config/entity_registry/list', [
      { entity_id: 'light.hallway', device_id: 'dev1' },
    ]);

    await expect(registries).resolves.toMatchObject({
      floors: [{ floor_id: 'ground' }],
      areas: [{ area_id: 'hallway' }],
      devices: [{ id: 'dev1' }],
      entities: [{ entity_id: 'light.hallway' }],
    });
    connection.close();
  });

  test('treats a server without floors as having none', async () => {
    const { connection, socket } = await connected();
    const registries = fetchHomeRegistries(connection);
    socket.receive({
      id: socket.lastSent('config/floor_registry/list').id,
      type: 'result',
      success: false,
      error: { code: 'unknown_command', message: 'Unknown command.' },
    });
    socket.reply('config/area_registry/list', []);
    socket.reply('config/device_registry/list', []);
    socket.reply('config/entity_registry/list', []);
    await expect(registries).resolves.toMatchObject({ floors: [] });
    connection.close();
  });
});

describe('resolveEntityAreaId', () => {
  const devices = new Map([['dev1', { area_id: 'kitchen' }]]);

  test("prefers the entity's own area", () => {
    expect(resolveEntityAreaId({ area_id: 'hallway', device_id: 'dev1' }, devices)).toBe('hallway');
  });

  test("falls back to the device's area", () => {
    expect(resolveEntityAreaId({ area_id: null, device_id: 'dev1' }, devices)).toBe('kitchen');
  });

  test('is null without either', () => {
    expect(resolveEntityAreaId({ area_id: null, device_id: null }, devices)).toBeNull();
    expect(resolveEntityAreaId({ area_id: null, device_id: 'missing' }, devices)).toBeNull();
  });
});
