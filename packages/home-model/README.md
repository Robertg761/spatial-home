# @spatial-home/home-model

The `home-layout.json` format: one file describing a home's floors, rooms, the doors and windows between them, the furniture people refer to, and where each Home Assistant device sits. The web editor writes it, the phone scanner will produce it, and the spatial server reads it. It's plain JSON of labelled things, not a mesh, so it stays readable and lasts longer than any one app.

It runs in browsers, React Native and Node. Its one dependency is [Zod](https://zod.dev).

## The format

```json
{
  "format": "spatial-home/home-layout",
  "version": 1,
  "site": { "northBearing": 0 },
  "floors": [{ "id": "ground-floor", "name": "Ground floor", "level": 0, "elevation": 0 }],
  "rooms": [
    {
      "id": "living-room",
      "name": "Living room",
      "floorId": "ground-floor",
      "outline": [[0, 0], [5, 0], [5, 4], [0, 4]],
      "ceilingHeight": 2.6,
      "ha": { "areaId": "living_room" }
    }
  ],
  "openings": [
    {
      "kind": "window",
      "id": "living-room-window",
      "wall": { "roomId": "living-room", "index": 3 },
      "offset": 2,
      "width": 1.8,
      "height": 1.4,
      "sillHeight": 0.8,
      "connects": "outside"
    }
  ],
  "fixtures": [],
  "devices": []
}
```

[`examples/sample-flat.json`](examples/sample-flat.json) is a complete five-room example, and [`schema/home-layout.v1.schema.json`](schema/home-layout.v1.schema.json) is the JSON Schema for tools outside TypeScript.

| Item | What it holds | Linked to in Home Assistant |
| --- | --- | --- |
| Floor | Name, storey level, height above the ground floor | Floor (`ha.floorId`) |
| Room | Outline on the plan, floor, ceiling height | Area (`ha.areaId`) |
| Opening | Door, window or open passage: which wall it's in, where along it, its size, and the room (or `"outside"`) on the other side | — |
| Fixture | Bed, sofa, desk, TV: kind, footprint and rotation | — |
| Device | Position and height, which way it faces, and what it covers (motion, presence, camera or light, as a cone or circle) | Device and entities (`ha.deviceId`, `ha.entityIds`) |

**Conventions.** Everything is in metres on one flat plan shared by all floors, so floors stack: x grows to the right, y towards the top of the plan. Heights are measured from the item's own floor. Angles are degrees clockwise, with 0 pointing to the top of the plan. Wall `i` of a room runs from corner `i` to the next corner. Ids are unique across the whole file.

**Compass directions are worked out, not stored.** `site.northBearing` says which way the top of the plan faces, and a window's direction comes from its wall. So turning the plan, or moving a wall, can't leave a stored direction out of date.

**No location.** The file doesn't hold the home's latitude and longitude, which sun calculations need. Home Assistant already knows them, and a layout file shared for help or a bug report shouldn't reveal where the home is.

## Usage

```ts
import {
  openingFacing,
  parseLayoutJson,
  roomConnections,
  serializeLayout,
} from '@spatial-home/home-model';

const result = parseLayoutJson(text);
if (!result.ok) {
  for (const issue of result.errors) console.error(issue.path.join('.'), issue.message);
} else {
  const { layout, warnings } = result;
  const window = layout.openings.find((opening) => opening.id === 'living-room-window')!;
  openingFacing(layout, window); // { bearing: 270, compass: 'W' }
  roomConnections(layout).get('hallway'); // [{ to: 'outside', openingId: 'front-door', kind: 'door' }, ...]
  const text = serializeLayout(layout); // coordinates stay on one line, so diffs show what moved
}
```

Validation checks the structure, that every reference points at something that exists, and that the geometry holds together: outlines that don't cross themselves, and openings that fit their walls. It returns **errors**, which make a layout unusable, and **warnings** for likely mistakes, such as a fixture outside its room or one entity linked to two devices. Each issue has a `code` and a `path` into the file, such as `["openings", 3, "offset"]`, for the editor to point at. When a file has errors but the right structure, the failed result still carries its `layout`, so an editor can open it and show what to fix.

The geometry helpers cover what the editor and the spatial server both need: area, centroid, point in polygon, walls and their outward normals, where an opening sits, which way it faces, and which rooms connect.

## Changing the format

Edit [`src/schema.ts`](src/schema.ts), then regenerate the JSON Schema with `npm run schema -w @spatial-home/home-model`. A test fails if the two disagree. A change that older files can't satisfy needs a new `version` and a migration. A file with a newer version than this package knows is refused with a message saying so.
