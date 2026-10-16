# @spatial-home/ha-client

The Home Assistant WebSocket client that the editor and the spatial server share. It runs in browsers and in Node 22 or later, and has no runtime dependencies.

It is ported from the connection layer of [HA Desktop Widget](https://github.com/Robertg761/HA-Desktop-Widget), so it carries over that app's fixes for real-world failures: a socket that stays "open" after the machine sleeps, a server that accepts the login but never sends states, subscriptions lost across reconnects, and requests sent before authentication finishes.

## What it does

- **Connection.** `HomeAssistantConnection` authenticates, numbers requests, and pings Home Assistant every 30 seconds so it notices a dead connection that never closed. It reconnects with exponential backoff (1 s doubling to 30 s, plus jitter). A rejected token stops it, since retrying would only be rejected again.
- **Subscriptions.** `subscribe()` and `subscribeEvents()` survive reconnects. Events that arrive after you unsubscribe are dropped, and so is a subscription the server confirms after you cancelled it.
- **Live states.** `EntityStore` keeps every entity's state current using `subscribe_entities`, which delivers the first snapshot and every later change in order. The connection only reports `connected` once that snapshot has arrived.
- **Registries.** `fetchHomeRegistries()` returns floors, areas, devices and entities. `resolveEntityAreaId()` finds an entity's area, falling back to its device's area as Home Assistant does.

Home Assistant 2022.4 or later is required for `subscribe_entities`. Floors need 2024.4; on older servers the list is empty.

## Usage

```ts
import {
  EntityStore,
  HomeAssistantConnection,
  fetchHomeRegistries,
} from '@spatial-home/ha-client';

const connection = new HomeAssistantConnection({
  url: 'http://homeassistant.local:8123',
  accessToken: 'long-lived-access-token', // or () => getFreshOAuthToken()
});
const entities = new EntityStore(connection);

connection.onStateChange((state) => console.log(state.status, state.error?.message));
entities.onChange(({ snapshot, changed, removed }) => {
  // On snapshot, re-read everything: entities removed while offline are simply gone.
});

connection.connect();

// Once connected:
const { floors, areas, devices } = await fetchHomeRegistries(connection);
await connection.callService('light', 'turn_on', { brightness_pct: 10 }, {
  target: { area_id: 'hallway' },
});
```

Connection statuses run `connecting` → `syncing` (authenticated, loading the first snapshot) → `connected`. A dropped connection goes to `reconnecting`, a rejected token to `auth-failed`, and `close()` to `closed`. Call `reconnect()` to retry at once, for example when the browser comes back online or the user clicks Retry.

## Try it against your Home Assistant

From the repository root:

```sh
cp .env.example .env   # then fill in HA_URL and HA_TOKEN
npm run ha:check       # lists floors and areas, with device and entity counts
npm run ha:check -- --watch   # then prints state changes as they happen
```

## Develop without any devices: the simulated home

No Home Assistant, no smart devices? Use the simulator, a Home Assistant that lives in memory. A `HomeAssistantConnection` talks to it exactly as it would to a real server (authentication, registries, `subscribe_entities`, `call_service`), so the code you write against it also works against a real one.

```sh
npm run ha:sim   # connects to the simulated home and prints state changes as they happen
```

`ha:sim` runs the simulation 60 times faster than real time, so sensors drift, doors open and a thermostat warms a room within a minute or two. Tune it with `HA_SIM_SPEED`, `HA_SIM_SEED` (repeat a run) and `HA_SIM_FIXTURE` (your own home); see `.env.example`. `npm run ha:check -- --simulate` prints the floors and areas once and exits.

To use it in code, import from the `simulator` subpath. The package's main entry point does not include it, so it stays out of production bundles. Use it only behind a dev check:

```ts
import { EntityStore, HomeAssistantConnection } from '@spatial-home/ha-client';
import { createDemoSimulator } from '@spatial-home/ha-client/simulator';

// In the editor, gate on Vite's flags so release builds drop the simulator:
// if (import.meta.env.DEV && import.meta.env.VITE_HA_SIMULATE) { ... }
const simulator = createDemoSimulator({ speed: 60 });
simulator.start();
const connection = new HomeAssistantConnection(simulator.connectionOptions);
const entities = new EntityStore(connection);
connection.connect();
```

Other real servers need `url` and `accessToken`; `connectionOptions` supplies those plus the in-memory `WebSocket`. Nothing opens a network connection.

### The demo home

`fixtures/demo-home.json` has a ground floor with five areas (living room, kitchen, hallway, bathroom, bedroom) and 25 entities. The entity ids match the devices placed in `packages/home-model/examples/sample-flat.json` (`light.reading_lamp`, `binary_sensor.hallway_motion`, and so on), and a test keeps it that way.

| Domain          | What it does                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `light`         | On/off and brightness; some also take `rgb_color`, `hs_color` and `color_temp_kelvin`. Colour is ignored by lights that can't show it. |
| `switch`        | On/off plugs.                                                                                                                          |
| `binary_sensor` | Doors, windows, motion and presence that switch on and off at random, with realistic dwell times.                                      |
| `sensor`        | Temperature and humidity that drift within limits; a battery level that stays put.                                                     |
| `climate`       | Heats or cools the room toward its target and holds it, with hysteresis. `hvac_action` reports what it is doing.                       |
| `cover`         | Blinds and a garage door that travel gradually: `opening`, `closing`, then `open` or `closed`, with `current_position`.                |

Commands: `turn_on`, `turn_off` and `toggle` for lights and switches (and `homeassistant.*` for any of them); `climate.set_temperature`, `set_hvac_mode`; `cover.open_cover`, `close_cover`, `stop_cover`, `set_cover_position`. Targets can be `entity_id`, `area_id` or `device_id`. Bad input fails with the error code Home Assistant uses (`service_not_found`, `service_validation_error`), including for unknown entities.

### Playing scenes and writing tests

```ts
simulator.setState('binary_sensor.front_door', 'on'); // open the front door
simulator.callService('light', 'turn_on', { brightness_pct: 30 }, { area_id: 'bedroom' });
simulator.tick(3600); // fast-forward an hour without waiting
simulator.getState('climate.living_room');
simulator.dropConnections(); // as if the server restarted, to test reconnection
```

Without `start()` nothing changes by itself, so tests drive time with `tick(seconds)` and get the same result every run for the same `seed`. See `test/simulator.test.ts`.

### Your own home

Copy `fixtures/demo-home.json` and point `HA_SIM_FIXTURE` at it, or pass the parsed JSON to `new SimulatedHomeAssistant(fixture, options)`. A fixture lists `floors`, `areas`, `devices` and `entities`; mistakes such as a duplicate entity or an unknown area are reported by name when it loads. An entity's optional `simulate` block sets how it behaves over time:

| `simulate.kind` | Entities        | Settings                                            |
| --------------- | --------------- | --------------------------------------------------- |
| `random-walk`   | `sensor`        | `min`, `max`, `step` per minute; `base`, `decimals` |
| `flip`          | `binary_sensor` | `meanOnSeconds`, `meanOffSeconds`                   |
| `thermostat`    | `climate`       | `ambient`, `ratePerMinute`                          |
| `cover`         | `cover`         | `secondsToTravel`                                   |

An entity without `simulate` keeps its state until a command changes it. Other domains are served as static states. The simulator is for development and tests: it only mimics the parts of Home Assistant that Spatial Home uses.
