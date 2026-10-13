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
