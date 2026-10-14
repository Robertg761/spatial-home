# @spatial-home/scan-import

Turns a phone's room scan into a `home-layout.json`. The iPhone scanner (Apple RoomPlan) and the Android scanner (ARCore) each write the same simple **room scan** file, and this package does everything after that once, for both:

- joins scanned walls into closed room outlines, with corners where the walls' lines meet;
- turns the plan so the walls run along its axes, and moves it next to the origin;
- puts each door, window and doorway on the wall the scanner says it is in, or else the nearest wall of its room, and works out the room behind it;
- drops the second sighting of a door seen from both of the rooms it joins: one nearby of about the same width and height (and, for windows, a sill within 20 cm), where a door and a doorway can match (one side may not see the door itself) but a window only matches a window, and each sighting matches one from the other side at most. When a door and a doorway match, it's a door;
- places furniture in the room its centre is in, on its own floor, turned with the plan;
- splits rooms onto storeys by floor height, starting a new storey once a floor is more than 1.5 m above the lowest one on the current storey;
- validates the result. A scan it accepts always becomes a layout without errors: an outline that crosses itself becomes the shape around it, and anything under a centimetre in size, which the layout would write as 0, is left out.

It also reports what it had to guess or leave out, such as walls that don't close, a door with no scanned room behind it, or a missing north, for the app to show before the user opens the layout in the editor.

## The room scan format

A scanner writes JSON in the AR session's own world coordinates: metres, right-handed, **y up**, x and z horizontal. ARKit and ARCore both use this frame, so neither scanner converts anything. All rooms in one file must come from one AR session, so their positions relate. [`schema/room-scan.v1.schema.json`](schema/room-scan.v1.schema.json) is the JSON Schema, for writing it from Swift or Kotlin.

```json
{
  "format": "spatial-home/room-scan",
  "version": 1,
  "source": { "platform": "android-arcore", "method": "guided" },
  "rooms": [
    {
      "name": "Bedroom",
      "walls": [{ "start": [0, 0, 0], "end": [4, 0, 0], "height": 2.45 }],
      "openings": [{ "kind": "window", "center": [0, 1.5, -1.5], "width": 1.2, "height": 1.2 }],
      "objects": [{ "category": "bed", "center": [2.8, 0.3, -1.5], "size": [1.6, 0.6, 2], "yaw": 1.571 }]
    }
  ]
}
```

That example is cut down to one wall; a real room has one per side.

| Field | Meaning |
| --- | --- |
| `rooms[].outline` | Floor corners in order, if the scanner has them, as from a **guided capture** where the user taps each corner. Takes priority over `walls`. Corners 2 cm apart or less become one, and a room whose corners are then all in a line is refused. |
| `rooms[].walls` | Each wall's two bottom corners and its height. Ends don't need to meet exactly: ends within 30 cm join, and the corner is where the two walls' lines cross. If the walls make more than one loop, such as round a column, the one around the most floor is the room. Walls that aren't part of it, such as a short freestanding one or one with no length, are left out. |
| `rooms[].ceilingHeight` | When measured or typed in. Otherwise the tallest wall, or 2.5 m when there are no walls. |
| `rooms[].openings` | `door`, `window` or `opening` (a doorway with no door): the centre of the opening, with its width and height. A window's sill comes from its centre height. `wallId`, if the scanner knows it, is the `id` of the room's wall it is in; otherwise it goes on the nearest wall. |
| `rooms[].objects` | Furniture as boxes: `category` (RoomPlan's names work as they are), centre, `size` as `[width, height, depth]` before turning, and `yaw` in radians, anticlockwise seen from above. Stairs are left out for now. |
| `rooms[].name`, `category` | The room's name, or the kind of room the scanner thinks it is, such as `bedroom`. Names are trimmed and cut to the layout's 200 characters. |
| `worldNorth` | The compass bearing of the world's −z axis, if the session knows it (ARKit's `.gravityAndHeading`). Without it the user sets north in the editor. |

## Writing a scan from RoomPlan

RoomPlan's `CapturedRoom` gives each wall, door, window and opening as a `Surface`, and each piece of furniture as an `Object`. Each has a `transform` (a 4×4 matrix in the session's world frame) and `dimensions`.

| Room scan | From a RoomPlan surface or object |
| --- | --- |
| Centre | `transform.columns.3` (x, y, z): the middle of the surface or box |
| Wall `start`, `end` | centre ± `transform.columns.0` (x, y, z) × `dimensions.x / 2`, with y lowered by `dimensions.y / 2` to the floor |
| Wall `height`; opening `width`, `height` | `dimensions.y`; `dimensions.x`, `dimensions.y` |
| Object `size` | `[dimensions.x, dimensions.y, dimensions.z]` |
| Object `yaw` | `atan2(-transform.columns.0.z, transform.columns.0.x)` |
| Wall `id`; opening `wallId` | `identifier.uuidString`; `parentIdentifier?.uuidString` (iOS 17 and later) |
| Object `category` | the category's name, such as `bed`, `sofa`, `table`, `television`, `storage` |

Several rooms captured in one `CapturedStructure` can go into one scan file as separate `rooms`. This mapping follows RoomPlan's documented types, but hasn't been checked against a real capture yet: the first real scan should confirm that wall ends and the bed's turn come out right in the editor.

## Writing a scan on Android

ARCore poses are in the same y-up world frame, so a hit-test result's translation is a point as the format expects. A guided capture writes the floor corners the user tapped as `outline`, plus `ceilingHeight` if it's measured. Automatic wall detection writes `walls`, like RoomPlan.

## Usage

```ts
import { importScan } from '@spatial-home/scan-import';
import { serializeLayout } from '@spatial-home/home-model';

const result = importScan(JSON.parse(scanText));
if (!result.ok) {
  console.error(result.errors);
} else {
  for (const note of result.notes) console.log(note.severity, note.message);
  save(serializeLayout(result.layout)); // result.validation holds the layout's own checks
}
```

Options: `alignToWalls: false` keeps the scan's orientation, `joinTolerance` changes how far apart wall ends can be and still join (default 0.3 m), and `name` names the home.

## Changing the format

Edit [`src/scan.ts`](src/scan.ts), then run `npm run schema -w @spatial-home/scan-import`. A test fails if the JSON Schema is out of date.
