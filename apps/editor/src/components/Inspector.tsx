import {
  NAME_MAX_LENGTH,
  OUTSIDE,
  openingFacing,
  polygonArea,
  roomWalls,
  type HomeLayout,
  type Opening,
  type Room,
} from '@spatial-home/home-model';
import { useEffect, useState, type Dispatch, type ReactNode } from 'react';
import {
  addMissingFloor,
  deleteItem,
  missingFloors,
  roomsOnFloor,
  updateOpening,
  updateRoom,
  type OpeningKind,
} from '../editor/plan.ts';
import { NUMBER_LIMITS, numberToCommit, textToCommit } from '../editor/fields.ts';
import type { EditorAction, EditorState } from '../editor/state.ts';
import { formatArea, formatLength } from './PlanView.tsx';

interface InspectorProps {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
}

/** Properties of the selected room or opening, or of the home when nothing is selected. */
export function Inspector({ state, dispatch }: InspectorProps) {
  const { layout, selection } = state;
  const edit = (next: HomeLayout) => dispatch({ type: 'edit', layout: next });

  if (selection?.kind === 'room') {
    const room = layout.rooms.find((candidate) => candidate.id === selection.id);
    if (room) return <RoomInspector layout={layout} room={room} edit={edit} dispatch={dispatch} />;
  }
  if (selection?.kind === 'opening') {
    const opening = layout.openings.find((candidate) => candidate.id === selection.id);
    if (opening)
      return <OpeningInspector state={state} opening={opening} edit={edit} dispatch={dispatch} />;
  }
  return <HomeInspector state={state} edit={edit} dispatch={dispatch} />;
}

function HomeInspector({
  state,
  edit,
  dispatch,
}: {
  state: EditorState;
  edit: (layout: HomeLayout) => void;
  dispatch: Dispatch<EditorAction>;
}) {
  const { layout } = state;
  return (
    <section className="inspector">
      <h2>Home</h2>
      <TextField
        label="Name"
        value={layout.name ?? ''}
        onCommit={(name) => {
          const { name: _old, ...rest } = layout;
          edit(name ? { ...rest, name } : rest);
        }}
      />
      <NumberField
        label="North"
        unit="°"
        hint="The compass bearing the top of the plan faces. 0 means north is up."
        value={layout.site.northBearing}
        {...NUMBER_LIMITS.northBearing}
        onCommit={(northBearing) =>
          edit({ ...layout, site: { ...layout.site, northBearing: northBearing % 360 } })
        }
      />
      <FloorField
        layout={layout}
        value={state.floorId}
        missing={missingFloors(layout)}
        missingHint={`No floor has the id "${state.floorId}", though rooms are on it. Add it, or select a room to move it to another floor.`}
        onChange={(floorId) => dispatch({ type: 'set-floor', floorId })}
        onAdd={() => {
          const { layout: next, id } = addMissingFloor(layout, state.floorId);
          edit(next);
          // The floor keeps its id unless another item has it, when the rooms move onto a new one.
          dispatch({ type: 'set-floor', floorId: id });
        }}
      />
      <p className="muted">
        {layout.rooms.length} {layout.rooms.length === 1 ? 'room' : 'rooms'},{' '}
        {layout.openings.length} {layout.openings.length === 1 ? 'opening' : 'openings'}. Select a
        room or opening to edit it.
      </p>
    </section>
  );
}

function RoomInspector({
  layout,
  room,
  edit,
  dispatch,
}: {
  layout: HomeLayout;
  room: Room;
  edit: (layout: HomeLayout) => void;
  dispatch: Dispatch<EditorAction>;
}) {
  const walls = roomWalls(room);
  return (
    <section className="inspector">
      <h2>Room</h2>
      <TextField
        label="Name"
        value={room.name}
        required
        onCommit={(name) => edit(updateRoom(layout, room.id, { name }))}
      />
      <FloorField
        layout={layout}
        value={room.floorId}
        missing={layout.floors.some((floor) => floor.id === room.floorId) ? [] : [room.floorId]}
        missingHint={`No floor has the id "${room.floorId}". Move the room to another floor, or add this one.`}
        onChange={(floorId) => edit(updateRoom(layout, room.id, { floorId }))}
        onAdd={() => edit(addMissingFloor(layout, room.floorId).layout)}
      />
      <NumberField
        label="Ceiling height"
        unit="m"
        value={room.ceilingHeight}
        {...NUMBER_LIMITS.ceilingHeight}
        step={0.05}
        onCommit={(ceilingHeight) => edit(updateRoom(layout, room.id, { ceilingHeight }))}
      />
      <TextField
        label="Home Assistant area"
        hint="The area's id in Home Assistant, such as living_room."
        value={room.ha?.areaId ?? ''}
        onCommit={(areaId) => {
          const { ha: _old, ...rest } = room;
          edit({
            ...layout,
            rooms: layout.rooms.map((r) =>
              r.id === room.id ? (areaId ? { ...rest, ha: { areaId } } : rest) : r
            ),
          });
        }}
      />
      <dl className="facts">
        <dt>Floor area</dt>
        <dd>{formatArea(polygonArea(room.outline))}</dd>
        <dt>Walls</dt>
        <dd>{walls.map((wall) => formatLength(wall.length)).join(', ')}</dd>
        <dt>Id</dt>
        <dd>
          <code>{room.id}</code>
        </dd>
      </dl>
      <DeleteButton
        label="Delete room"
        onClick={() =>
          dispatch({
            type: 'edit',
            layout: deleteItem(layout, { kind: 'room', id: room.id }),
            select: null,
          })
        }
      />
    </section>
  );
}

function OpeningInspector({
  state,
  opening,
  edit,
  dispatch,
}: {
  state: EditorState;
  opening: Opening;
  edit: (layout: HomeLayout) => void;
  dispatch: Dispatch<EditorAction>;
}) {
  const { layout } = state;
  const room = layout.rooms.find((candidate) => candidate.id === opening.wall.roomId);
  const wall = room ? roomWalls(room)[opening.wall.index] : undefined;
  const others = room
    ? roomsOnFloor(layout, room.floorId).filter((other) => other.id !== room.id)
    : [];
  const destination = layout.rooms.find((candidate) => candidate.id === opening.connects);
  const facing = wall ? openingFacing(layout, opening) : null;
  const change = (patch: Parameters<typeof updateOpening>[2]) =>
    edit(updateOpening(layout, opening.id, patch));

  return (
    <section className="inspector">
      <h2>{capitalize(opening.kind)}</h2>
      <Field label="Kind">
        <select
          value={opening.kind}
          onChange={(event) => change({ kind: event.target.value as OpeningKind })}
        >
          <option value="door">Door</option>
          <option value="window">Window</option>
          <option value="passage">Passage (no door)</option>
        </select>
      </Field>
      <TextField label="Name" value={opening.name ?? ''} onCommit={(name) => change({ name })} />
      <Field label="Leads to">
        <select
          value={opening.connects}
          onChange={(event) => change({ connects: event.target.value })}
        >
          <option value={OUTSIDE}>Outside</option>
          {others.map((other) => (
            <option key={other.id} value={other.id}>
              {other.name}
            </option>
          ))}
          {opening.connects !== OUTSIDE &&
            !others.some((other) => other.id === opening.connects) && (
              <option value={opening.connects}>
                {destination
                  ? `${destination.name} (on another floor)`
                  : `${opening.connects} (missing)`}
              </option>
            )}
        </select>
      </Field>
      <NumberField
        label="Width"
        unit="m"
        value={opening.width}
        {...NUMBER_LIMITS.width}
        step={0.05}
        onCommit={(width) => change({ width })}
      />
      <NumberField
        label="Height"
        unit="m"
        value={opening.height}
        {...NUMBER_LIMITS.height}
        step={0.05}
        onCommit={(height) => change({ height })}
      />
      {opening.kind === 'window' && (
        <NumberField
          label="Sill height"
          unit="m"
          value={opening.sillHeight}
          {...NUMBER_LIMITS.sillHeight}
          step={0.05}
          onCommit={(sillHeight) => change({ sillHeight })}
        />
      )}
      <NumberField
        label="Position along wall"
        unit="m"
        hint={
          wall
            ? `From the wall's start to the centre of the ${opening.kind}. The wall is ${formatLength(wall.length)} long.`
            : undefined
        }
        value={opening.offset}
        min={0}
        max={wall?.length ?? 100}
        step={0.05}
        onCommit={(offset) => change({ offset })}
      />
      <dl className="facts">
        <dt>In</dt>
        <dd>{room?.name ?? opening.wall.roomId}</dd>
        {facing && (
          <>
            <dt>Faces</dt>
            <dd>
              {facing.compass} ({Math.round(facing.bearing)}°)
            </dd>
          </>
        )}
        <dt>Id</dt>
        <dd>
          <code>{opening.id}</code>
        </dd>
      </dl>
      <DeleteButton
        label={`Delete ${opening.kind}`}
        onClick={() =>
          dispatch({
            type: 'edit',
            layout: deleteItem(layout, { kind: 'opening', id: opening.id }),
            select: null,
          })
        }
      />
    </section>
  );
}

/**
 * A choice of floor, shown when there is one to make or the chosen floor is missing. Floors that
 * rooms are on but the layout doesn't have are listed after its own, with a button to add the
 * chosen one.
 */
function FloorField({
  layout,
  value,
  missing,
  missingHint,
  onChange,
  onAdd,
}: {
  layout: HomeLayout;
  value: string;
  missing: string[];
  /** Shown when the chosen floor is missing. */
  missingHint: string;
  onChange: (floorId: string) => void;
  onAdd: () => void;
}) {
  const isMissing = missing.includes(value);
  if (layout.floors.length + missing.length < 2 && !isMissing) return null;
  return (
    <>
      <Field label="Floor" hint={isMissing ? missingHint : undefined}>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {layout.floors.map((floor) => (
            <option key={floor.id} value={floor.id}>
              {floor.name}
            </option>
          ))}
          {missing.map((id) => (
            <option key={id} value={id}>
              {id} (missing)
            </option>
          ))}
        </select>
      </Field>
      {isMissing && (
        <button type="button" className="fix" onClick={onAdd}>
          Add the missing floor
        </button>
      )}
    </>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** A text input that changes the layout when it loses focus or Enter is pressed, not on every key. */
function TextField({
  label,
  hint,
  value,
  required = false,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: string;
  required?: boolean;
  onCommit: (value: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    const committed = textToCommit(text, value, { required });
    if (committed === null) setText(value);
    else onCommit(committed);
  };
  return (
    <Field label={label} hint={hint}>
      <input
        type="text"
        value={text}
        maxLength={NAME_MAX_LENGTH}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
      />
    </Field>
  );
}

function NumberField({
  label,
  unit,
  hint,
  value,
  min,
  max,
  step = 1,
  onCommit,
}: {
  label: string;
  unit: string;
  hint?: string | undefined;
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const committed = numberToCommit(text, value, { min, max });
    if (committed === null) setText(String(value));
    else onCommit(committed);
  };
  return (
    <Field label={label} hint={hint}>
      <span className="number-input">
        <input
          type="number"
          value={text}
          min={min}
          max={max}
          step={step}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === 'Enter' && event.currentTarget.blur()}
        />
        <span className="unit">{unit}</span>
      </span>
    </Field>
  );
}

function DeleteButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="danger" onClick={onClick}>
      {label}
    </button>
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
