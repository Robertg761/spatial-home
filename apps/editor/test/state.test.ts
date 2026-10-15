import { createEmptyLayout, validateLayout, type HomeLayout } from '@spatial-home/home-model';
import { describe, expect, test } from 'vitest';
import {
  addMissingFloor,
  addOpening,
  addRoom,
  deleteItem,
  moveRoom,
  nearestWall,
  updateRoom,
} from '../src/editor/plan.ts';
import { editorReducer, initialState, isPristine, type EditorState } from '../src/editor/state.ts';

const square = [
  [0, 0],
  [3, 0],
  [3, 3],
  [0, 3],
] as [number, number][];

function withRoom(): { state: EditorState; id: string } {
  const empty = initialState(createEmptyLayout());
  const { layout, id } = addRoom(empty.layout, empty.floorId, square);
  return {
    state: editorReducer(empty, { type: 'edit', layout, select: { kind: 'room', id } }),
    id,
  };
}

describe('editorReducer', () => {
  test('undoes and redoes edits', () => {
    const { state, id } = withRoom();
    expect(state.selection).toEqual({ kind: 'room', id });
    const undone = editorReducer(state, { type: 'undo' });
    expect(undone.layout.rooms).toHaveLength(0);
    // The room it had selected is gone, so the selection goes too.
    expect(undone.selection).toBeNull();
    const redone = editorReducer(undone, { type: 'redo' });
    expect(redone.layout.rooms).toHaveLength(1);
  });

  test('a new edit clears what could be redone', () => {
    const { state } = withRoom();
    const undone = editorReducer(state, { type: 'undo' });
    const edited = editorReducer(undone, {
      type: 'edit',
      layout: { ...undone.layout, name: 'Home' },
    });
    expect(edited.future).toEqual([]);
  });

  test('a whole drag undoes as one step', () => {
    const { state, id } = withRoom();
    let dragging = editorReducer(state, { type: 'gesture-start' });
    for (const dx of [0.1, 0.2, 0.3]) {
      dragging = editorReducer(dragging, {
        type: 'gesture-update',
        layout: moveRoom(state.layout, id, dx, 0),
      });
    }
    const done = editorReducer(dragging, { type: 'gesture-end' });
    expect(done.layout.rooms[0]!.outline[0]).toEqual([0.3, 0]);
    expect(done.past).toHaveLength(state.past.length + 1);
    expect(editorReducer(done, { type: 'undo' }).layout).toBe(state.layout);
  });

  test("a drag that didn't move anything adds no history", () => {
    const { state } = withRoom();
    const started = editorReducer(state, { type: 'gesture-start' });
    expect(editorReducer(started, { type: 'gesture-end' }).past).toHaveLength(state.past.length);
  });

  test('a second drag starting during one keeps the first starting point', () => {
    const { state, id } = withRoom();
    const started = editorReducer(state, { type: 'gesture-start' });
    const moved = editorReducer(started, {
      type: 'gesture-update',
      layout: moveRoom(state.layout, id, 1, 0),
    });
    const again = editorReducer(moved, { type: 'gesture-start' });
    const done = editorReducer(again, { type: 'gesture-end' });
    expect(editorReducer(done, { type: 'undo' }).layout).toBe(state.layout);
  });

  test('the first room drawn in a layout without floors makes a floor for it', () => {
    const empty = initialState({ ...createEmptyLayout(), floors: [] });
    expect(empty.floorId).toBe('');
    const { layout, id } = addRoom(empty.layout, empty.floorId, square);
    const drawn = editorReducer(empty, { type: 'edit', layout, select: { kind: 'room', id } });
    expect(drawn.layout.floors).toEqual(createEmptyLayout().floors);
    expect(drawn.layout.rooms[0]!.floorId).toBe('ground-floor');
    expect(drawn.floorId).toBe('ground-floor');
    expect(validateLayout(drawn.layout).ok).toBe(true);
    // One step: undo goes back to the layout without floors.
    expect(editorReducer(drawn, { type: 'undo' }).layout).toBe(empty.layout);
  });

  test('an edit during a drag ends the drag, keeping both in the history', () => {
    const { state, id } = withRoom();
    const started = editorReducer(state, { type: 'gesture-start' });
    const moved = editorReducer(started, {
      type: 'gesture-update',
      layout: moveRoom(state.layout, id, 1, 0),
    });
    // Delete pressed while the pointer is still dragging the room.
    const deleted = editorReducer(moved, {
      type: 'edit',
      layout: deleteItem(moved.layout, { kind: 'room', id }),
      select: null,
    });
    expect(deleted.layout.rooms).toHaveLength(0);
    // The rest of the drag no longer applies.
    const after = editorReducer(
      editorReducer(deleted, { type: 'gesture-update', layout: moveRoom(state.layout, id, 2, 0) }),
      { type: 'gesture-end' }
    );
    expect(after.layout).toBe(deleted.layout);
    const undone = editorReducer(after, { type: 'undo' });
    expect(undone.layout).toBe(moved.layout);
    expect(editorReducer(undone, { type: 'undo' }).layout).toBe(state.layout);
  });

  test('undo waits until a drag ends', () => {
    const { state } = withRoom();
    const started = editorReducer(state, { type: 'gesture-start' });
    expect(editorReducer(started, { type: 'undo' })).toBe(started);
  });

  test('deleting the selected room clears the selection', () => {
    const { state, id } = withRoom();
    const next = editorReducer(state, {
      type: 'edit',
      layout: deleteItem(state.layout, { kind: 'room', id }),
      select: null,
    });
    expect(next.selection).toBeNull();
  });

  test('loading a layout gives every item its own id', () => {
    const { state } = withRoom();
    const twice = { ...state.layout, rooms: [...state.layout.rooms, ...state.layout.rooms] };
    const loaded = editorReducer(state, { type: 'load', layout: twice });
    expect(loaded.layout.rooms.map((room) => room.id)).toEqual(['room-1', 'room-1-2']);
    expect(validateLayout(loaded.layout).ok).toBe(true);
  });

  test('loading a layout starts a fresh history', () => {
    const { state } = withRoom();
    const loaded = editorReducer(state, { type: 'load', layout: createEmptyLayout('Other') });
    expect(loaded.past).toEqual([]);
    expect(loaded.layout.name).toBe('Other');
  });

  test('selecting an item on another floor shows that floor', () => {
    const empty = createEmptyLayout();
    const twoFloors = {
      ...empty,
      floors: [...empty.floors, { id: 'first-floor', name: 'First floor', level: 1, elevation: 3 }],
    };
    const { layout: withRoom, id: roomId } = addRoom(twoFloors, 'first-floor', square);
    const hit = nearestWall(withRoom, 'first-floor', [1.5, 0], 0.1)!;
    const added = addOpening(withRoom, 'door', hit);
    if ('error' in added) throw new Error(added.error);
    const state = initialState(added.layout);
    expect(state.floorId).toBe('ground-floor');

    const room = editorReducer(state, { type: 'select', selection: { kind: 'room', id: roomId } });
    expect(room.floorId).toBe('first-floor');
    expect(room.selection).toEqual({ kind: 'room', id: roomId });

    const opening = editorReducer(state, {
      type: 'select',
      selection: { kind: 'opening', id: added.id },
    });
    expect(opening.floorId).toBe('first-floor');
    expect(opening.selection).toEqual({ kind: 'opening', id: added.id });
  });
});

describe('rooms on missing floors', () => {
  /** A ground-floor room, and one on a first floor the layout doesn't have. */
  function withMissingFloor(): { layout: HomeLayout; lost: string } {
    const { layout: one } = addRoom(createEmptyLayout(), 'ground-floor', square);
    const { layout, id: lost } = addRoom(one, 'first-floor', square);
    return { layout, lost };
  }

  test('selecting a room on a missing floor shows that floor', () => {
    const { layout, lost } = withMissingFloor();
    const state = initialState(layout);
    expect(state.floorId).toBe('ground-floor');
    const selected = editorReducer(state, {
      type: 'select',
      selection: { kind: 'room', id: lost },
    });
    expect(selected.floorId).toBe('first-floor');
    expect(selected.selection).toEqual({ kind: 'room', id: lost });
    // It stays shown after an edit that leaves the floor missing.
    const renamed = editorReducer(editorReducer(selected, { type: 'select', selection: null }), {
      type: 'edit',
      layout: updateRoom(layout, lost, { name: 'Loft' }),
    });
    expect(renamed.floorId).toBe('first-floor');
  });

  test('a layout whose rooms are all on missing floors opens on one of them', () => {
    const { layout } = withMissingFloor();
    expect(initialState({ ...layout, floors: [] }).floorId).toBe('ground-floor');
  });

  test('moving the selected room to another floor shows it there, and undo shows it back', () => {
    const { layout, lost } = withMissingFloor();
    const state = editorReducer(initialState(layout), {
      type: 'select',
      selection: { kind: 'room', id: lost },
    });
    const moved = editorReducer(state, {
      type: 'edit',
      layout: updateRoom(state.layout, lost, { floorId: 'ground-floor' }),
    });
    expect(moved.floorId).toBe('ground-floor');
    expect(validateLayout(moved.layout).ok).toBe(true);
    // One step.
    const undone = editorReducer(moved, { type: 'undo' });
    expect(undone.layout).toBe(state.layout);
    expect(undone.floorId).toBe('first-floor');
    expect(editorReducer(undone, { type: 'redo' }).floorId).toBe('ground-floor');
  });

  test('adding the missing floor keeps it shown, as one step', () => {
    const { layout, lost } = withMissingFloor();
    const state = editorReducer(initialState(layout), {
      type: 'select',
      selection: { kind: 'room', id: lost },
    });
    const added = editorReducer(state, {
      type: 'edit',
      layout: addMissingFloor(state.layout, 'first-floor').layout,
    });
    expect(added.floorId).toBe('first-floor');
    expect(added.layout.floors.map((floor) => floor.id)).toEqual(['ground-floor', 'first-floor']);
    expect(validateLayout(added.layout).ok).toBe(true);
    expect(editorReducer(added, { type: 'undo' }).layout).toBe(state.layout);
  });

  test('when the floor shown goes, the plan shows the first floor', () => {
    const { layout, lost } = withMissingFloor();
    const state = editorReducer(initialState(layout), {
      type: 'set-floor',
      floorId: 'first-floor',
    });
    const deleted = editorReducer(state, {
      type: 'edit',
      layout: deleteItem(state.layout, { kind: 'room', id: lost }),
    });
    expect(deleted.floorId).toBe('ground-floor');
  });
});

describe('isPristine', () => {
  test('a new layout is pristine', () => {
    expect(isPristine(initialState(createEmptyLayout()))).toBe(true);
  });

  test('a roomless layout with other changes is not', () => {
    const empty = initialState(createEmptyLayout());
    const named = editorReducer(empty, {
      type: 'edit',
      layout: { ...empty.layout, name: 'Home' },
    });
    expect(isPristine(named)).toBe(false);
    // Even restored from a draft, with nothing to undo.
    expect(isPristine(initialState(named.layout))).toBe(false);
    expect(
      isPristine(
        initialState({ ...empty.layout, site: { ...empty.layout.site, northBearing: 90 } })
      )
    ).toBe(false);
  });

  test('an emptied layout is not, while there is work to undo', () => {
    const { state, id } = withRoom();
    const deleted = editorReducer(state, {
      type: 'edit',
      layout: deleteItem(state.layout, { kind: 'room', id }),
    });
    expect(deleted.layout.rooms).toHaveLength(0);
    expect(isPristine(deleted)).toBe(false);
  });
});
