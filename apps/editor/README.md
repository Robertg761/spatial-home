# Spatial Home editor

The web editor for `home-layout.json`: draw a home's rooms on a floor plan, then add doors, windows and open passages. A 3D view and Home Assistant device placement come next.

```sh
npm run editor   # from the repository root; opens http://localhost:5173
```

## Using it

| Tool | Key | What it does |
| --- | --- | --- |
| Select | V | Click a room or opening to edit it in the side panel. Drag a room to move it, or a corner of the selected room to reshape it. Drag the background to pan, and scroll to zoom. |
| Room | R | Click to place corners. Click the first corner, double-click or press Enter to finish. Backspace removes the last corner and Esc cancels. Corners snap to a 10 cm grid and to other rooms' corners, so neighbouring rooms share walls. |
| Door, Window, Passage | D, W, P | Click a wall. The opening is centred where you click, moved along the wall if it wouldn't fit, and leads to the room on the other side of the wall, or outside. |

Undo and redo with Ctrl+Z and Ctrl+Shift+Z (⌘ on a Mac), and delete the selection with Delete or Backspace. **Checks** lists what the layout's validation found; click an item to select the room or opening it's about.

**Floors.** Switch floors with **Floor** in the side panel when nothing is selected, and move a room to another floor from its own **Floor**. A file can put rooms on a floor it doesn't have: the editor still shows them, on that floor marked *missing*, so you can move them to another floor or add the missing floor with one click.

**Saving.** The layout is kept in this browser as you work, so it survives a reload. It never leaves the device. **Save** downloads it as `home-layout.json`, and **Open…** loads one, even if it has problems to fix. **Sample** loads a five-room flat.

## Code

- [`src/editor/plan.ts`](src/editor/plan.ts): edits to the layout (adding rooms and openings, moving, deleting, snapping, finding the wall under the cursor), as pure functions.
- [`src/editor/state.ts`](src/editor/state.ts): editor state with undo history. A drag is recorded as one step.
- [`src/components/PlanView.tsx`](src/components/PlanView.tsx): the SVG floor plan and its pointer handling. Plan coordinates are metres with y pointing up; the SVG flips y once when drawing.
- [`src/components/Inspector.tsx`](src/components/Inspector.tsx) and [`IssuesPanel.tsx`](src/components/IssuesPanel.tsx): the side panel.

The logic in `src/editor` has unit tests in [`test`](test).
