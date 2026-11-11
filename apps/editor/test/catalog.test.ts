import type { HassEntity, HomeRegistries } from '@spatial-home/ha-client';
import { SIMULATED_TOKEN, createDemoSimulator } from '@spatial-home/ha-client/simulator';
import { validateLayout, type HomeLayout } from '@spatial-home/home-model';
import sample from '@spatial-home/home-model/examples/sample-flat.json';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { placeDevice } from '../src/editor/things.ts';
import {
  buildCatalog,
  describeItem,
  deviceSpecFor,
  filterCatalog,
  placedId,
  type CatalogItem,
} from '../src/ha/catalog.ts';
import { HomeAssistantLink, type LinkSnapshot } from '../src/ha/link.ts';

function sampleFlat(): HomeLayout {
  const result = validateLayout(structuredClone(sample));
  if (!result.ok) throw new Error('sample flat is invalid');
  return result.layout;
}

const registries: HomeRegistries = {
  floors: [
    { floor_id: 'upstairs', name: 'Upstairs', level: 1, icon: null, aliases: [] },
    { floor_id: 'ground', name: 'Ground', level: 0, icon: null, aliases: [] },
  ],
  areas: [
    area('bedroom', 'Bedroom', 'upstairs'),
    area('lounge', 'Lounge', 'ground'),
    area('empty', 'Empty room', 'ground'),
  ],
  devices: [
    device('hue', 'Hue bulb', 'lounge', { name_by_user: 'Reading lamp' }),
    device('pir', 'Motion sensor', 'bedroom'),
    device('weather', 'Forecast', null, { entry_type: 'service' }),
    device('old', 'Old plug', 'lounge', { disabled_by: 'user' }),
    device('bare', 'No entities', 'lounge'),
  ],
  entities: [
    entity('light.hue', 'hue'),
    entity('sensor.pir_battery', 'pir', { entity_category: 'diagnostic' }),
    entity('binary_sensor.pir_motion', 'pir'),
    entity('binary_sensor.pir_tamper', 'pir', { hidden_by: 'user' }),
    entity('weather.home', 'weather'),
    entity('switch.old', 'old'),
    entity('switch.loose_plug', null, { area_id: 'lounge', name: 'Loose plug' }),
    entity('scene.movie', null, { area_id: 'lounge' }),
    entity('sensor.orphan', 'gone'),
    entity('light.disabled', null, { disabled_by: 'user' }),
  ],
};

const states: Record<string, Partial<HassEntity>> = {
  'binary_sensor.pir_motion': { attributes: { device_class: 'motion' } },
  'sensor.orphan': { attributes: { friendly_name: 'Orphan temperature' } },
};
const state = (id: string) => states[id] as HassEntity | undefined;

describe('the catalog', () => {
  test('groups physical devices by area, in floor order, with loose ones last', () => {
    const groups = buildCatalog(registries, state);
    expect(groups.map((group) => [group.areaId, group.items.map((item) => item.key)])).toEqual([
      ['lounge', ['entity:switch.loose_plug', 'device:hue']],
      ['bedroom', ['device:pir']],
      [null, ['entity:sensor.orphan']],
    ]);
  });

  test('names devices as the user did, and lists their main entities first', () => {
    const items = buildCatalog(registries, state).flatMap((group) => group.items);
    const byKey = new Map(items.map((item) => [item.key, item]));
    expect(byKey.get('device:hue')?.name).toBe('Reading lamp');
    expect(byKey.get('entity:sensor.orphan')?.name).toBe('Orphan temperature');
    expect(byKey.get('device:pir')).toMatchObject({
      name: 'Motion sensor',
      entityIds: ['binary_sensor.pir_motion', 'sensor.pir_battery'],
    });
    expect(describeItem(byKey.get('device:pir')!)).toBe('binary sensor, sensor');
  });

  test('filters by name, model or entity', () => {
    const groups = buildCatalog(registries, state);
    expect(
      filterCatalog(groups, 'PIR_motion').flatMap((group) => group.items.map((item) => item.key))
    ).toEqual(['device:pir']);
    expect(filterCatalog(groups, '  ')).toBe(groups);
    expect(filterCatalog(groups, 'nothing like it')).toEqual([]);
  });
});

describe('a first guess at each device', () => {
  const item = (entityIds: string[], name = 'Thing'): CatalogItem => ({
    key: 'x',
    name,
    areaId: null,
    entityIds,
  });

  test('looks across the room for motion, presence and cameras', () => {
    expect(deviceSpecFor(item(['binary_sensor.pir_motion']), state)).toMatchObject({
      coverage: [{ kind: 'motion', range: 7, fieldOfView: 110 }],
      height: 2.2,
      heading: 0,
    });
    expect(deviceSpecFor(item(['camera.porch'])).coverage).toEqual([
      { kind: 'camera', range: 8, fieldOfView: 90 },
    ]);
    // Without its state, a binary sensor could be anything.
    expect(deviceSpecFor(item(['binary_sensor.pir_motion'])).coverage).toBeUndefined();
  });

  test('puts ceiling lights on the ceiling and lamps at table height', () => {
    expect(deviceSpecFor(item(['light.lounge_ceiling']))).toMatchObject({
      height: 'ceiling',
      coverage: [{ kind: 'light', range: 4 }],
    });
    expect(deviceSpecFor(item(['light.hue'], 'Reading lamp'))).toMatchObject({
      height: 1.5,
      coverage: [{ kind: 'light', range: 2.5 }],
    });
    expect(deviceSpecFor(item(['switch.plug']))).toEqual({
      name: 'Thing',
      ha: { entityIds: ['switch.plug'] },
      height: 1,
    });
  });
});

describe('the demo home', () => {
  const links: HomeAssistantLink[] = [];
  afterEach(() => {
    for (const link of links.splice(0)) link.dispose();
    vi.unstubAllGlobals();
  });

  test('connects, lists its devices, and matches the ones the sample flat has placed', async () => {
    const simulator = createDemoSimulator();
    vi.stubGlobal('WebSocket', simulator.WebSocket);
    const link = new HomeAssistantLink();
    links.push(link);
    const connected = new Promise<LinkSnapshot>((resolve) => {
      link.subscribe(() => {
        const snapshot = link.getSnapshot();
        if (snapshot.status === 'connected') resolve(snapshot);
      });
    });
    expect(link.connect(simulator.url, SIMULATED_TOKEN, false)).toBeNull();
    const snapshot = await connected;
    expect(snapshot.source).toBe('server');
    expect(snapshot.registries?.areas).toHaveLength(5);
    expect(link.entity('light.reading_lamp')?.state).toBeDefined();

    const groups = buildCatalog(snapshot.registries!, (id) => link.entity(id));
    const items = groups.flatMap((group) => group.items);
    const layout = sampleFlat();
    const placed = items.filter((item) => placedId(layout, item)).map((item) => item.name);
    expect(placed.sort()).toEqual([
      'Bedroom presence sensor',
      'Hallway motion sensor',
      'Living room ceiling light',
      'Reading lamp',
    ]);

    // Every device in the demo home can be placed, and makes a valid layout.
    let next = layout;
    for (const item of items) {
      const result = placeDevice(
        next,
        'ground-floor',
        deviceSpecFor(item, (id) => link.entity(id)),
        [6, 4]
      );
      if ('error' in result) throw new Error(result.error);
      next = result.layout;
    }
    expect(next.devices).toHaveLength(items.length);
    const result = validateLayout(next);
    expect(result.ok).toBe(true);
    expect(result.warnings.filter((issue) => issue.code === 'entity-placed-twice')).toEqual([]);
  });

  test('turns down an address that is not one, or a missing token', () => {
    const link = new HomeAssistantLink();
    links.push(link);
    expect(link.connect('not a url', 'token', false)).toMatch(/isn’t a web address/);
    expect(link.connect('http://ha.local:8123', ' ', false)).toMatch(/token/);
    expect(link.getSnapshot().status).toBe('off');
  });

  test('says when the token is turned down', async () => {
    const simulator = createDemoSimulator({ accessToken: 'right' });
    vi.stubGlobal('WebSocket', simulator.WebSocket);
    const link = new HomeAssistantLink();
    links.push(link);
    const refused = new Promise<LinkSnapshot>((resolve) => {
      link.subscribe(() => {
        if (link.getSnapshot().status === 'auth-failed') resolve(link.getSnapshot());
      });
    });
    link.connect(simulator.url, 'wrong', false);
    expect((await refused).error).toMatch(/turned the access token down/);
    link.disconnect();
    expect(link.getSnapshot().status).toBe('off');
  });
});

function area(area_id: string, name: string, floor_id: string | null) {
  return { area_id, name, floor_id, icon: null, aliases: [], labels: [] };
}

function device(
  id: string,
  name: string,
  area_id: string | null,
  extra: Partial<HomeRegistries['devices'][number]> = {}
): HomeRegistries['devices'][number] {
  return {
    id,
    name,
    name_by_user: null,
    area_id,
    manufacturer: null,
    model: null,
    disabled_by: null,
    entry_type: null,
    via_device_id: null,
    ...extra,
  };
}

function entity(
  entity_id: string,
  device_id: string | null,
  extra: Partial<HomeRegistries['entities'][number]> = {}
): HomeRegistries['entities'][number] {
  return {
    entity_id,
    name: null,
    device_id,
    area_id: null,
    platform: 'test',
    disabled_by: null,
    hidden_by: null,
    entity_category: null,
    icon: null,
    ...extra,
  };
}
