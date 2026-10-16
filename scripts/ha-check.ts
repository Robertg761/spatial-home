// Connects to a real Home Assistant and prints what Spatial Home can see: the version, floors,
// areas and how many devices and entities sit in each. Pass --watch to keep printing state changes.
//
//   HA_URL=http://homeassistant.local:8123 HA_TOKEN=... npm run ha:check
//
// The values can also live in a .env file at the repository root (see .env.example).
//
// With no Home Assistant of your own, pass --simulate (or set HA_SIMULATE=1) to use the built-in
// simulated home instead; `npm run ha:sim` does that and watches the devices change. HA_SIM_SPEED
// sets how many simulated seconds pass per real second (default 60), HA_SIM_SEED fixes the
// randomness, and HA_SIM_FIXTURE points at a JSON file of your own (see the ha-client README).

import { readFileSync } from 'node:fs';

import type { HassEntity } from '../packages/ha-client/src/index.ts';
import {
  EntityStore,
  HomeAssistantConnection,
  fetchHomeRegistries,
  resolveEntityAreaId,
} from '../packages/ha-client/src/index.ts';

const watch = process.argv.includes('--watch');
const simulate =
  process.argv.includes('--simulate') || ['1', 'true'].includes(process.env.HA_SIMULATE ?? '');

let connection: HomeAssistantConnection;
if (simulate) {
  const { SimulatedHomeAssistant, createDemoSimulator } =
    await import('../packages/ha-client/src/simulator/index.ts');
  const options = {
    speed: Number(process.env.HA_SIM_SPEED ?? 60),
    ...(process.env.HA_SIM_SEED ? { seed: Number(process.env.HA_SIM_SEED) } : {}),
  };
  const fixturePath = process.env.HA_SIM_FIXTURE;
  const simulator = fixturePath
    ? new SimulatedHomeAssistant(JSON.parse(readFileSync(fixturePath, 'utf8')), options)
    : createDemoSimulator(options);
  console.log(`Using the simulated home (${simulator.url}), not a real Home Assistant.`);
  if (watch) simulator.start();
  connection = new HomeAssistantConnection(simulator.connectionOptions);
} else {
  const url = process.env.HA_URL;
  const token = process.env.HA_TOKEN;
  if (!url || !token) {
    console.error(
      'Set HA_URL and HA_TOKEN (a long-lived access token from your Home Assistant profile),\n' +
        'or run with --simulate to use the built-in simulated home.'
    );
    process.exit(1);
  }
  connection = new HomeAssistantConnection({ url, accessToken: token });
}
const entities = new EntityStore(connection);

connection.onStateChange((state) => {
  const detail = state.error ? ` (${state.error.message})` : '';
  console.log(`[${state.status}]${detail}`);
  if (state.status === 'auth-failed') process.exit(1);
  if (state.status === 'reconnecting' && !watch) {
    console.error(`Could not connect to ${connection.websocketUrl}`);
    process.exit(1);
  }
});

const ready = new Promise<void>((resolve) => {
  const stop = connection.onStateChange((state) => {
    if (state.status !== 'connected') return;
    stop();
    resolve();
  });
});

connection.connect();
await ready;

const { floors, areas, devices, entities: entityEntries } = await fetchHomeRegistries(connection);
const devicesById = new Map(devices.map((device) => [device.id, device]));

console.log(`\nHome Assistant ${connection.state.haVersion} at ${connection.baseUrl}`);
console.log(
  `${entities.size} entities, ${devices.length} devices, ${areas.length} areas, ${floors.length} floors\n`
);

const entitiesByArea = new Map<string | null, number>();
for (const entry of entityEntries) {
  const areaId = resolveEntityAreaId(entry, devicesById);
  entitiesByArea.set(areaId, (entitiesByArea.get(areaId) ?? 0) + 1);
}
const devicesByArea = new Map<string | null, number>();
for (const device of devices) {
  devicesByArea.set(device.area_id, (devicesByArea.get(device.area_id) ?? 0) + 1);
}

const floorGroups = [
  ...[...floors].sort((a, b) => (a.level ?? 0) - (b.level ?? 0)),
  { floor_id: null, name: 'No floor', level: null },
];
for (const floor of floorGroups) {
  const floorAreas = areas.filter((area) => (area.floor_id ?? null) === floor.floor_id);
  if (floorAreas.length === 0) continue;
  console.log(floor.level === null ? floor.name : `${floor.name} (level ${floor.level})`);
  for (const area of floorAreas) {
    const deviceCount = devicesByArea.get(area.area_id) ?? 0;
    const entityCount = entitiesByArea.get(area.area_id) ?? 0;
    console.log(`  ${area.name}: ${deviceCount} devices, ${entityCount} entities`);
  }
}
console.log(`  (no area): ${entitiesByArea.get(null) ?? 0} entities`);

if (!watch) {
  connection.close();
  entities.dispose();
} else {
  console.log('\nWatching state changes; Ctrl+C to stop.');
  entities.onChange(({ snapshot, changed, removed }) => {
    if (snapshot) {
      console.log(`Snapshot: ${entities.size} entities`);
      return;
    }
    for (const id of changed) console.log(`${id}: ${describe(entities.get(id))}`);
    for (const id of removed) console.log(`${id}: removed`);
  });
}

/** The state, plus the attribute that moves most for thermostats, covers and lights. */
function describe(entity: HassEntity | undefined): string {
  if (!entity) return 'unknown';
  const { current_temperature, current_position, brightness } = entity.attributes;
  const detail = current_temperature ?? current_position ?? brightness;
  return detail === undefined || detail === null ? entity.state : `${entity.state} (${detail})`;
}
