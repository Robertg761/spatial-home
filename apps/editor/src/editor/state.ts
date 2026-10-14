import { createEmptyLayout, serializeLayout, type HomeLayout } from '@spatial-home/home-model';

export type Selection = { kind: 'room' | 'opening'; id: string } | null;

export interface EditorState {
  layout: HomeLayout;
  /** The floor shown on the plan. */
  floorId: string;
  selection: Selection;
  past: HomeLayout[];
  future: HomeLayout[];
  /** The layout as it was when a drag began, so the whole drag undoes as one step. */
  gestureStart: HomeLayout | null;
}

export type EditorAction =
  | { type: 'edit'; layout: HomeLayout; select?: Selection }
  | { type: 'gesture-start' }
  | { type: 'gesture-update'; layout: HomeLayout }
  | { type: 'gesture-end' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'select'; selection: Selection }
  | { type: 'set-floor'; floorId: string }
  | { type: 'load'; layout: HomeLayout };

const HISTORY_LIMIT = 200;

export function initialState(layout: HomeLayout): EditorState {
  return {
    layout,
    floorId: layout.floors[0]?.id ?? '',
    selection: null,
    past: [],
    future: [],
    gestureStart: null,
  };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'edit': {
      if (action.layout === state.layout) return state;
      return withSelection(
        {
          ...state,
          layout: action.layout,
          past: pushHistory(state.past, state.layout),
          future: [],
          gestureStart: null,
        },
        action.select === undefined ? state.selection : action.select
      );
    }

    case 'gesture-start':
      // A drag already under way keeps where it started, so undo still goes back to before it.
      return state.gestureStart ? state : { ...state, gestureStart: state.layout };

    case 'gesture-update':
      // Shown on the plan as it happens, but not in the history until the drag ends.
      return { ...state, layout: action.layout };

    case 'gesture-end': {
      const start = state.gestureStart;
      if (!start) return state;
      if (start === state.layout) return { ...state, gestureStart: null };
      return { ...state, past: pushHistory(state.past, start), future: [], gestureStart: null };
    }

    case 'undo': {
      const previous = state.past.at(-1);
      if (!previous || state.gestureStart) return state;
      return withSelection(
        {
          ...state,
          layout: previous,
          past: state.past.slice(0, -1),
          future: [state.layout, ...state.future],
        },
        state.selection
      );
    }

    case 'redo': {
      const next = state.future[0];
      if (!next || state.gestureStart) return state;
      return withSelection(
        {
          ...state,
          layout: next,
          past: pushHistory(state.past, state.layout),
          future: state.future.slice(1),
        },
        state.selection
      );
    }

    case 'select': {
      // Show the floor the item is on, as an issue can be about an item on another floor.
      const floorId = selectionFloor(state.layout, action.selection);
      const floorExists = state.layout.floors.some((floor) => floor.id === floorId);
      return withSelection(
        floorId && floorExists ? { ...state, floorId } : state,
        action.selection
      );
    }

    case 'set-floor':
      return { ...state, floorId: action.floorId, selection: null };

    case 'load':
      return initialState(action.layout);
  }
}

/**
 * Whether replacing the layout would lose nothing: it's the same as a new one, with nothing to undo
 * or redo.
 */
export function isPristine(state: EditorState): boolean {
  return (
    state.past.length === 0 &&
    state.future.length === 0 &&
    serializeLayout(state.layout) === serializeLayout(createEmptyLayout())
  );
}

function pushHistory(past: HomeLayout[], layout: HomeLayout): HomeLayout[] {
  const next = [...past, layout];
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/** Keeps the selection only while the selected item exists; undo can remove it. */
function withSelection(state: EditorState, selection: Selection): EditorState {
  const exists =
    selection === null ||
    (selection.kind === 'room'
      ? state.layout.rooms.some((room) => room.id === selection.id)
      : state.layout.openings.some((opening) => opening.id === selection.id));
  const floorExists = state.layout.floors.some((floor) => floor.id === state.floorId);
  return {
    ...state,
    selection: exists ? selection : null,
    floorId: floorExists ? state.floorId : (state.layout.floors[0]?.id ?? ''),
  };
}

function selectionFloor(layout: HomeLayout, selection: Selection): string | undefined {
  if (!selection) return undefined;
  const roomId =
    selection.kind === 'room'
      ? selection.id
      : layout.openings.find((opening) => opening.id === selection.id)?.wall.roomId;
  return layout.rooms.find((room) => room.id === roomId)?.floorId;
}
