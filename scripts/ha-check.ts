// Connects to a real Home Assistant and prints what Spatial Home can see: the version, floors,
// areas and how many devices and entities sit in each. Pass --watch to keep printing state changes.
//
//   HA_URL=http://homeassistant.local:8123 HA_TOKEN=... npm run ha:check
//
// The values can also live in a .env file at the repository root (see .env.example).

import {
  EntityStore,
  HomeAssistantConnection,
  fetchHomeRegistries,
  resolveEntityAreaId,
} from '../packages/ha-client/src/index.ts';

const url = process.env.HA_URL;
const token = process.env.HA_TOKEN;
const watch = process.argv.includes('--watch');

if (!url || !token) {
  console.error(
    'Set HA_URL and HA_TOKEN (a long-lived access token from your Home Assistant profile).'
  );
  process.exit(1);
}

const connection = new HomeAssistantConnection({ url, accessToken: token });
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
    for (const id of changed) console.log(`${id}: ${entities.get(id)?.state}`);
    for (const id of removed) console.log(`${id}: removed`);
  });
}
