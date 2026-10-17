import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { EntityStore, HomeAssistantConnection, HomeAssistantError } from '../src/index.ts';
import { fetchHomeRegistries } from '../src/index.ts';
import {
  DEMO_HOME_FIXTURE,
  SimulatedHomeAssistant,
  createDemoSimulator,
} from '../src/simulator/index.ts';
import { parseFixture } from '../src/simulator/index.ts';

const open: Array<() => void> = [];
afterEach(() => {
  for (const close of open.splice(0)) close();
});

/** A real client connected to a simulator, waiting until the first snapshot has arrived. */
async function connect(sim: SimulatedHomeAssistant, accessToken?: string) {
  const connection = new HomeAssistantConnection({
    ...sim.connectionOptions,
    ...(accessToken ? { accessToken } : {}),
    reconnect: { baseDelayMs: 1, maxDelayMs: 1, jitterMs: 0 },
  });
  const store = new EntityStore(connection);
  open.push(() => {
    store.dispose();
    connection.close();
  });
  const ready = new Promise<void>((resolve, reject) => {
    connection.onStateChange((state) => {
      if (state.status === 'connected') resolve();
      if (state.status === 'auth-failed') reject(state.error);
    });
  });
  connection.connect();
  await ready;
  return { connection, store };
}

/** Lets queued socket messages reach the client. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

const START = Date.UTC(2026, 9, 16, 12);

describe('the demo home', () => {
  it('is a valid fixture covering the device types contributors need', () => {
    const fixture = parseFixture(DEMO_HOME_FIXTURE);
    const domains = new Set(fixture.entities.map((entity) => entity.entity_id.split('.')[0]));
    expect([...domains].sort()).toEqual([
      'binary_sensor',
      'climate',
      'cover',
      'light',
      'sensor',
      'switch',
    ]);
  });

  it('has every entity the sample flat places', () => {
    const sample = JSON.parse(
      readFileSync(new URL('../../home-model/examples/sample-flat.json', import.meta.url), 'utf8')
    ) as { devices: Array<{ ha?: { entityIds: string[] } }> };
    const ids = new Set(
      createDemoSimulator()
        .getStates()
        .map((entity) => entity.entity_id)
    );
    for (const device of sample.devices) {
      for (const entityId of device.ha?.entityIds ?? []) expect(ids.has(entityId)).toBe(true);
    }
  });
});

describe('connecting a real client', () => {
  it('delivers the snapshot and the registries', async () => {
    const sim = createDemoSimulator({ startTime: START });
    const { connection, store } = await connect(sim);

    expect(connection.state.haVersion).toBe(sim.haVersion);
    expect(store.size).toBe(sim.getStates().length);
    expect(store.get('light.living_room_ceiling')?.state).toBe('on');

    const registries = await fetchHomeRegistries(connection);
    expect(registries.floors.map((floor) => floor.name)).toEqual(['Ground floor']);
    expect(registries.areas.map((area) => area.area_id)).toContain('living_room');
    expect(registries.devices.length).toBeGreaterThan(10);
    expect(registries.entities).toHaveLength(store.size);
  });

  it('rejects the wrong token when one is required', async () => {
    const sim = createDemoSimulator({ accessToken: 'right' });
    await expect(connect(sim, 'wrong')).rejects.toMatchObject({ code: 'auth_invalid' });
    const { store } = await connect(sim, 'right');
    expect(store.size).toBeGreaterThan(0);
  });

  it('reconnects with a fresh snapshot after the server drops', async () => {
    const sim = createDemoSimulator({ startTime: START });
    const { store } = await connect(sim);
    const changes: boolean[] = [];
    store.onChange((change) => changes.push(change.snapshot));

    sim.dropConnections();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(changes).toContain(true);
    expect(store.size).toBe(sim.getStates().length);
  });
});

describe('commands', () => {
  it('sets a light’s brightness and colour, then clears them when it turns off', async () => {
    const sim = createDemoSimulator({ startTime: START });
    const { connection, store } = await connect(sim);

    await connection.callService(
      'light',
      'turn_on',
      { brightness_pct: 50, rgb_color: [255, 0, 0] },
      { target: { entity_id: 'light.reading_lamp' } }
    );
    await settle();
    expect(store.get('light.reading_lamp')).toMatchObject({
      state: 'on',
      attributes: {
        brightness: 128,
        color_mode: 'hs',
        rgb_color: [255, 0, 0],
        hs_color: [0, 100],
      },
    });

    await connection.callService(
      'light',
      'turn_on',
      { color_temp_kelvin: 2700 },
      {
        target: { entity_id: 'light.reading_lamp' },
      }
    );
    await settle();
    expect(store.get('light.reading_lamp')?.attributes).toMatchObject({
      color_mode: 'color_temp',
      color_temp_kelvin: 2700,
      brightness: 128,
    });

    await connection.callService('light', 'turn_off', undefined, {
      target: { entity_id: 'light.reading_lamp' },
    });
    await settle();
    expect(store.get('light.reading_lamp')).toMatchObject({
      state: 'off',
      attributes: { brightness: null, rgb_color: null },
    });
  });

  it('ignores colour on a brightness-only light', () => {
    const sim = createDemoSimulator({ startTime: START });
    sim.callService(
      'light',
      'turn_on',
      { rgb_color: [0, 255, 0], brightness: 10 },
      {
        entity_id: 'light.hallway',
      }
    );
    expect(sim.getState('light.hallway')?.attributes).toMatchObject({
      brightness: 10,
      color_mode: 'brightness',
      rgb_color: null,
    });
  });

  it('switches a plug and toggles it', () => {
    const sim = createDemoSimulator({ startTime: START });
    sim.callService('switch', 'turn_on', {}, { entity_id: 'switch.tv_plug' });
    expect(sim.getState('switch.tv_plug')?.state).toBe('on');
    sim.callService('switch', 'toggle', {}, { entity_id: 'switch.tv_plug' });
    expect(sim.getState('switch.tv_plug')?.state).toBe('off');
  });

  it('targets a whole area, and only the entities of the service’s domain', () => {
    const sim = createDemoSimulator({ startTime: START });
    sim.callService('light', 'turn_off', {}, { area_id: 'living_room' });
    expect(sim.getState('light.living_room_ceiling')?.state).toBe('off');
    expect(sim.getState('light.bedside_lamp')?.state).toBe('on');
    sim.callService('homeassistant', 'turn_on', {}, { area_id: 'living_room' });
    expect(sim.getState('light.living_room_ceiling')?.state).toBe('on');
    expect(sim.getState('switch.tv_plug')?.state).toBe('on');
  });

  it('reports errors the way Home Assistant does', async () => {
    const sim = createDemoSimulator({ startTime: START });
    const { connection } = await connect(sim);
    const failure = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: unknown) => error as HomeAssistantError
      );

    expect(await failure(connection.callService('light', 'explode'))).toMatchObject({
      code: 'service_not_found',
    });
    expect(
      await failure(
        connection.callService('light', 'turn_on', {}, { target: { entity_id: 'light.nope' } })
      )
    ).toMatchObject({ code: 'service_validation_error' });
    expect(
      await failure(
        connection.callService(
          'climate',
          'set_temperature',
          { temperature: 99 },
          {
            target: { entity_id: 'climate.living_room' },
          }
        )
      )
    ).toMatchObject({ code: 'service_validation_error' });
    expect(await failure(connection.request({ type: 'made_up' }))).toMatchObject({
      code: 'unknown_command',
    });
  });
});

describe('time passing', () => {
  it('heats the room to the target and holds it there', async () => {
    const sim = createDemoSimulator({ startTime: START });
    const { store } = await connect(sim);
    const climate = () => store.get('climate.living_room')!.attributes;

    expect(climate()).toMatchObject({ current_temperature: 19.8, hvac_action: 'heating' });
    sim.tick(60);
    await settle();
    expect(climate().current_temperature as number).toBeGreaterThan(20.2);

    sim.tick(30 * 60);
    await settle();
    // It holds the room within a band around the target rather than overshooting.
    expect(climate().current_temperature as number).toBeGreaterThanOrEqual(21.1);
    expect(climate().current_temperature as number).toBeLessThan(21.8);

    sim.callService(
      'climate',
      'set_hvac_mode',
      { hvac_mode: 'off' },
      {
        entity_id: 'climate.living_room',
      }
    );
    await settle();
    expect(store.get('climate.living_room')?.state).toBe('off');
    expect(climate().hvac_action).toBe('off');
  });

  it('moves a cover gradually and reports opening and closing', async () => {
    const sim = createDemoSimulator({ startTime: START });
    const { connection, store } = await connect(sim);
    const blinds = () => store.get('cover.bedroom_blinds')!;

    expect(blinds()).toMatchObject({ state: 'closed', attributes: { current_position: 0 } });
    await connection.callService('cover', 'open_cover', undefined, {
      target: { entity_id: 'cover.bedroom_blinds' },
    });
    await settle();
    expect(blinds().state).toBe('opening');

    sim.tick(9);
    await settle();
    expect(blinds().state).toBe('opening');
    expect(blinds().attributes.current_position).toBe(50);

    await connection.callService('cover', 'stop_cover', undefined, {
      target: { entity_id: 'cover.bedroom_blinds' },
    });
    await settle();
    expect(blinds()).toMatchObject({ state: 'open', attributes: { current_position: 50 } });

    sim.callService(
      'cover',
      'set_cover_position',
      { position: 0 },
      {
        entity_id: 'cover.bedroom_blinds',
      }
    );
    sim.tick(60);
    await settle();
    expect(blinds()).toMatchObject({ state: 'closed', attributes: { current_position: 0 } });
  });

  it('flips door and motion sensors on its own, and sets last_changed when it does', async () => {
    const sim = createDemoSimulator({ startTime: START });
    const { store } = await connect(sim);
    const seen = new Set<string>();
    store.onChange(({ changed }) => {
      for (const id of changed) seen.add(`${id}=${store.get(id)?.state}`);
    });

    sim.tick(6 * 3600);
    await settle();

    expect(seen.has('binary_sensor.hallway_motion=on')).toBe(true);
    expect(seen.has('binary_sensor.hallway_motion=off')).toBe(true);
    const motion = store.get('binary_sensor.hallway_motion')!;
    expect(Date.parse(motion.last_changed)).toBeGreaterThan(START);
  });

  it('keeps sensor readings inside their limits and moving', () => {
    const sim = createDemoSimulator({ startTime: START });
    const readings = new Set<string>();
    for (let minute = 0; minute < 600; minute++) {
      sim.tick(60);
      const value = Number(sim.getState('sensor.bathroom_humidity')!.state);
      expect(value).toBeGreaterThanOrEqual(40);
      expect(value).toBeLessThanOrEqual(95);
      readings.add(String(value));
    }
    expect(readings.size).toBeGreaterThan(5);
  });

  it('replays the same way for the same seed', () => {
    const run = (seed: number) => {
      const sim = createDemoSimulator({ startTime: START, seed });
      sim.tick(4 * 3600);
      return sim.getStates().map((entity) => `${entity.entity_id}=${entity.state}`);
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7)).not.toEqual(run(8));
  });

  it('can be played by hand with setState', async () => {
    const sim = createDemoSimulator({ startTime: START });
    const { store } = await connect(sim);
    sim.setState('binary_sensor.front_door', 'on');
    await settle();
    expect(store.get('binary_sensor.front_door')?.state).toBe('on');
    expect(() => sim.setState('climate.living_room', 'cool')).toThrow(/callService/);
  });

  it('runs on a timer under start() and stops with stop()', async () => {
    const sim = createDemoSimulator({ startTime: START, tickMs: 5, speed: 600 });
    sim.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    sim.stop();
    const after = sim.now;
    expect(after).toBeGreaterThan(START + 10_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sim.now).toBe(after);
  });
});

describe('fixtures', () => {
  it('rejects mistakes with a message naming the problem', () => {
    const entity = { entity_id: 'light.a', state: 'on' };
    expect(() => parseFixture({})).toThrow(/entities/);
    expect(() => parseFixture({ entities: [entity, entity] })).toThrow(/duplicate entity light.a/);
    expect(() => parseFixture({ entities: [{ ...entity, device_id: 'x' }] })).toThrow(
      /unknown device/
    );
    expect(() => parseFixture({ entities: [{ ...entity, area_id: 'x' }] })).toThrow(/unknown area/);
    expect(() =>
      parseFixture({
        entities: [{ ...entity, simulate: { kind: 'flip', meanOnSeconds: 1, meanOffSeconds: 1 } }],
      })
    ).toThrow(/belongs on binary_sensor/);
    expect(
      () => new SimulatedHomeAssistant({ entities: [{ entity_id: 'Bad', state: 'on' }] })
    ).toThrow(/bad entity_id/);
  });

  it('runs a minimal custom home', () => {
    const sim = new SimulatedHomeAssistant({
      entities: [{ entity_id: 'switch.lamp', state: 'off' }],
    });
    sim.callService('switch', 'turn_on', {}, { entity_id: 'switch.lamp' });
    expect(sim.getState('switch.lamp')?.state).toBe('on');
  });
});
