# Spatial Home editor

The web editor for `home-layout.json`: draw a home's rooms on a floor plan, add doors, windows and open passages, place furniture and your Home Assistant devices in them, and see the home in 3D.

```sh
npm run editor   # from the repository root; opens http://localhost:5173
```

## Using it

| Tool | Key | What it does |
| --- | --- | --- |
| Select | V | Click anything to edit it in the side panel. Drag a room to move it, or a corner of the selected room to reshape it. Drag furniture and devices to move them, and the round handle of the selected one to turn it. Drag the background to pan, and scroll to zoom. |
| Room | R | Click to place corners. Click the first corner, double-click or press Enter to finish. Backspace removes the last corner and Esc cancels. Corners snap to a 10 cm grid and to other rooms' corners, so neighbouring rooms share walls. |
| Door, Window, Passage | D, W, P | Click a wall. The opening is centred where you click, moved along the wall if it wouldn't fit, and leads to the room on the other side of the wall, or outside. |

Undo and redo with Ctrl+Z and Ctrl+Shift+Z (⌘ on a Mac), and delete the selection with Delete or Backspace. **Checks** lists what the layout's validation found; click an item to select the room or opening it's about.

**Home Assistant devices.** Connect in the left panel with your Home Assistant's address and a long-lived access token (your profile in Home Assistant, then Security). The browser talks to Home Assistant directly; nothing goes through a server of ours. The address is remembered, and the token only if you tick *Stay connected*. The panel then lists your devices by area. Drag one onto the plan, or click it and then click the plan. Each device starts with a guess at how it's mounted and what it covers: motion and presence sensors and cameras high up, looking across the room in a cone; ceiling lights on the ceiling; other lights as lamps. Change any of it in the side panel: height, which way it faces, tilt, and each kind of coverage with its reach and angle. Coverage stops at the room's walls on the plan. A device that's already placed shows where it is; click it to select it, or drag it to move it. The side panel shows the live state of each of its entities, and warns when a device sits in a different room from its area in Home Assistant.

**Rooms and areas.** Link a room to its Home Assistant area from the room's own panel. *Link rooms to areas by name* links every unlinked room to the area with the same name in one go.

**Furniture.** Drag a bed, sofa, desk and so on into a room, or click and then click the plan. These are the things people mention ("the lamp by the sofa"), so the model can answer questions about them. Each has a name, a size and a front, the thick edge, that the round handle turns.

**Working without Home Assistant.** `npm run editor` also offers *Use the demo home*, the [simulated Home Assistant](../../packages/ha-client/README.md#develop-without-any-devices-the-simulated-home), whose devices match the sample flat. It's for development, so release builds (`npm run build`) leave it out.

**3D.** Switch between **Plan** and **3D** at the top, or press 3. The 3D view shows the floor you're on and the floors below it, without ceilings, so you look down into the rooms: walls with their doors, windows and passages cut out, furniture as blocks and devices as dots. Drag to turn it, right-drag to pan and scroll to zoom. Click a room or window to select it and edit it in the side panel; the view updates as you do.

**Floors.** Switch floors with **Floor** in the side panel when nothing is selected, and move a room to another floor from its own **Floor**. A file can put rooms on a floor it doesn't have: the editor still shows them, on that floor marked *missing*, so you can move them to another floor or add the missing floor with one click.

**Saving.** The layout is kept in this browser as you work, so it survives a reload. It never leaves the device. **Save** downloads it as `home-layout.json`, and **Open…** loads one, even if it has problems to fix. **Sample** loads a five-room flat.

## Code

- [`src/editor/plan.ts`](src/editor/plan.ts): edits to the layout (adding rooms and openings, moving, deleting, snapping, finding the wall under the cursor), as pure functions.
- [`src/editor/things.ts`](src/editor/things.ts): placing, moving and turning furniture and devices, and linking rooms to areas, as pure functions.
- [`src/editor/state.ts`](src/editor/state.ts): editor state with undo history. A drag is recorded as one step.
- [`src/ha/link.ts`](src/ha/link.ts): the connection to Home Assistant (or the demo home), with its registries and live states. [`src/ha/catalog.ts`](src/ha/catalog.ts) turns the registries into the list of devices to place, and guesses each one's coverage.
- [`src/components/PlanView.tsx`](src/components/PlanView.tsx): the SVG floor plan and its pointer handling. Plan coordinates are metres with y pointing up; the SVG flips y once when drawing.
- [`src/editor/model3d.ts`](src/editor/model3d.ts): what the 3D view draws, worked out from the layout as plain numbers: wall pieces around each opening (in both rooms a door joins), window panes, furniture and devices.
- [`src/components/ModelView.tsx`](src/components/ModelView.tsx): the 3D view, drawn with three.js and loaded the first time it's opened.
- [`src/components/Library.tsx`](src/components/Library.tsx): the left panel, with Home Assistant's devices and the furniture to place.
- [`src/components/Inspector.tsx`](src/components/Inspector.tsx) and [`IssuesPanel.tsx`](src/components/IssuesPanel.tsx): the side panel.

The logic in `src/editor` and `src/ha` has unit tests in [`test`](test), including a run against the demo home.
