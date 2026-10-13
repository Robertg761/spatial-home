import { createEmptyLayout } from '@spatial-home/home-model';
import { describe, expect, test } from 'vitest';
import { addRoom, deleteItem, moveRoom } from '../src/editor/plan.ts';
import { editorReducer, initialState, type EditorState } from '../src/editor/state.ts';

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

  test('loading a layout starts a fresh history', () => {
    const { state } = withRoom();
    const loaded = editorReducer(state, { type: 'load', layout: createEmptyLayout('Other') });
    expect(loaded.past).toEqual([]);
    expect(loaded.layout.name).toBe('Other');
  });
});
