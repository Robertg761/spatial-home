import type { HassEntity, HomeRegistries } from '@spatial-home/ha-client';
import {
  KIND_MAX_LENGTH,
  NAME_MAX_LENGTH,
  OUTSIDE,
  compassBearing,
  compassPoint,
  openingFacing,
  polygonArea,
  roomWalls,
  type Coverage,
  type Device,
  type Fixture,
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
import {
  FIXTURE_PRESETS,
  isCone,
  setRoomArea,
  updateDevice,
  updateFixture,
  type DevicePatch,
} from '../editor/things.ts';
import { entityName } from '../ha/catalog.ts';
import { formatArea, formatLength } from './PlanView.tsx';

/** What the inspector shows from Home Assistant, while connected. */
export interface HomeAssistantView {
  registries: HomeRegistries;
  entity: (entityId: string) => HassEntity | undefined;
}

interface InspectorProps {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  homeAssistant: HomeAssistantView | null;
}

/** Properties of the selected item, or of the home when nothing is selected. */
export function Inspector({ state, dispatch, homeAssistant }: InspectorProps) {
  const { layout, selection } = state;
  const edit = (next: HomeLayout) => dispatch({ type: 'edit', layout: next });

  if (selection?.kind === 'room') {
    const room = layout.rooms.find((candidate) => candidate.id === selection.id);
    if (room)
      return (
        <RoomInspector
          layout={layout}
          room={room}
          edit={edit}
          dispatch={dispatch}
          homeAssistant={homeAssistant}
        />
      );
  }
  if (selection?.kind === 'fixture') {
    const fixture = layout.fixtures.find((candidate) => candidate.id === selection.id);
    if (fixture)
      return <FixtureInspector layout={layout} fixture={fixture} edit={edit} dispatch={dispatch} />;
  }
  if (selection?.kind === 'device') {
    const device = layout.devices.find((candidate) => candidate.id === selection.id);
    if (device)
      return (
        <DeviceInspector
          layout={layout}
          device={device}
          edit={edit}
          dispatch={dispatch}
          homeAssistant={homeAssistant}
        />
      );
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
        {[
          count(layout.rooms.length, 'room'),
          count(layout.openings.length, 'opening'),
          count(layout.fixtures.length, 'piece of furniture', 'pieces of furniture'),
          count(layout.devices.length, 'device'),
        ].join(', ')}
        . Select anything on the plan to edit it.
      </p>
    </section>
  );
}

function RoomInspector({
  layout,
  room,
  edit,
  dispatch,
  homeAssistant,
}: {
  layout: HomeLayout;
  room: Room;
  edit: (layout: HomeLayout) => void;
  dispatch: Dispatch<EditorAction>;
  homeAssistant: HomeAssistantView | null;
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
      {homeAssistant ? (
        <AreaField
          layout={layout}
          room={room}
          registries={homeAssistant.registries}
          onChange={(areaId) => edit(setRoomArea(layout, room.id, areaId))}
        />
      ) : (
        <TextField
          label="Home Assistant area"
          hint="The area's id in Home Assistant, such as living_room. Connect to Home Assistant to pick from a list."
          value={room.ha?.areaId ?? ''}
          onCommit={(areaId) => edit(setRoomArea(layout, room.id, areaId || null))}
        />
      )}
      <dl className="facts">
        <dt>Floor area</dt>
        <dd>{formatArea(polygonArea(room.outline))}</dd>
        <dt>Walls</dt>
        <dd>{walls.map((wall) => formatLength(wall.length)).join(', ')}</dd>
        <dt>In it</dt>
        <dd>
          {[
            count(
              layout.fixtures.filter((fixture) => fixture.roomId === room.id).length,
              'piece of furniture',
              'pieces of furniture'
            ),
            count(layout.devices.filter((device) => device.roomId === room.id).length, 'device'),
          ].join(', ')}
        </dd>
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

/** The Home Assistant area a room is linked to, picked from the areas Home Assistant has. */
function AreaField({
  layout,
  room,
  registries,
  onChange,
}: {
  layout: HomeLayout;
  room: Room;
  registries: HomeRegistries;
  onChange: (areaId: string | null) => void;
}) {
  const current = room.ha?.areaId ?? '';
  const known = registries.areas.some((area) => area.area_id === current);
  const linkedTo = (areaId: string) =>
    layout.rooms.find((other) => other.id !== room.id && other.ha?.areaId === areaId);
  const floors = new Map(registries.floors.map((floor) => [floor.floor_id, floor.name]));
  return (
    <Field
      label="Home Assistant area"
      hint={
        current && !known
          ? `Home Assistant has no area with the id "${current}".`
          : 'Devices placed here can be matched to this area.'
      }
    >
      <select value={current} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">Not linked</option>
        {registries.areas.map((area) => {
          const other = linkedTo(area.area_id);
          const floor = area.floor_id ? floors.get(area.floor_id) : undefined;
          return (
            <option key={area.area_id} value={area.area_id}>
              {area.name}
              {floor && registries.floors.length > 1 ? ` (${floor})` : ''}
              {other ? ` · also ${other.name}` : ''}
            </option>
          );
        })}
        {current && !known && <option value={current}>{current} (not in Home Assistant)</option>}
      </select>
    </Field>
  );
}

function FixtureInspector({
  layout,
  fixture,
  edit,
  dispatch,
}: {
  layout: HomeLayout;
  fixture: Fixture;
  edit: (layout: HomeLayout) => void;
  dispatch: Dispatch<EditorAction>;
}) {
  const room = layout.rooms.find((candidate) => candidate.id === fixture.roomId);
  const change = (patch: Parameters<typeof updateFixture>[2]) =>
    edit(updateFixture(layout, fixture.id, patch));
  const known = FIXTURE_PRESETS.some((preset) => preset.kind === fixture.kind);
  return (
    <section className="inspector">
      <h2>Furniture</h2>
      <TextField
        label="Name"
        value={fixture.name}
        required
        hint="What people call it, such as “the reading chair”."
        onCommit={(name) => change({ name })}
      />
      <Field label="Kind">
        <select value={fixture.kind} onChange={(event) => change({ kind: event.target.value })}>
          {FIXTURE_PRESETS.map((preset) => (
            <option key={preset.kind} value={preset.kind}>
              {preset.label}
            </option>
          ))}
          {!known && <option value={fixture.kind}>{fixture.kind.slice(0, KIND_MAX_LENGTH)}</option>}
        </select>
      </Field>
      <div className="field-row">
        <NumberField
          label="Width"
          unit="m"
          value={fixture.size.width}
          {...NUMBER_LIMITS.fixtureSize}
          step={0.05}
          onCommit={(width) => change({ size: { ...fixture.size, width } })}
        />
        <NumberField
          label="Depth"
          unit="m"
          value={fixture.size.depth}
          {...NUMBER_LIMITS.fixtureSize}
          step={0.05}
          onCommit={(depth) => change({ size: { ...fixture.size, depth } })}
        />
      </div>
      <div className="field-row">
        <NumberField
          label="Height"
          unit="m"
          value={fixture.size.height}
          {...NUMBER_LIMITS.fixtureSize}
          step={0.05}
          onCommit={(height) => change({ size: { ...fixture.size, height } })}
        />
        <NumberField
          label="Turned"
          unit="°"
          value={fixture.rotation}
          {...NUMBER_LIMITS.rotation}
          step={5}
          onCommit={(rotation) => change({ rotation })}
        />
      </div>
      <p className="field-hint">
        The thick edge is its front. Drag the round handle on the plan to turn it.
      </p>
      <dl className="facts">
        <dt>In</dt>
        <dd>{room?.name ?? fixture.roomId}</dd>
        <dt>Id</dt>
        <dd>
          <code>{fixture.id}</code>
        </dd>
      </dl>
      <DeleteButton
        label="Delete furniture"
        onClick={() =>
          dispatch({
            type: 'edit',
            layout: deleteItem(layout, { kind: 'fixture', id: fixture.id }),
            select: null,
          })
        }
      />
    </section>
  );
}

const COVERAGE_KINDS: { kind: Coverage['kind']; label: string }[] = [
  { kind: 'motion', label: 'Motion' },
  { kind: 'presence', label: 'Presence' },
  { kind: 'camera', label: 'Camera view' },
  { kind: 'light', label: 'Light' },
];

function DeviceInspector({
  layout,
  device,
  edit,
  dispatch,
  homeAssistant,
}: {
  layout: HomeLayout;
  device: Device;
  edit: (layout: HomeLayout) => void;
  dispatch: Dispatch<EditorAction>;
  homeAssistant: HomeAssistantView | null;
}) {
  const room = layout.rooms.find((candidate) => candidate.id === device.roomId);
  const change = (patch: DevicePatch) => edit(updateDevice(layout, device.id, patch));
  const coverage = device.coverage ?? [];
  const changeCoverage = (index: number, next: Coverage | null) =>
    change({
      coverage: next
        ? coverage.map((item, i) => (i === index ? next : item))
        : coverage.filter((_, i) => i !== index),
    });
  const bearing = device.heading !== undefined ? compassBearing(layout, device.heading) : undefined;
  const [, , z] = device.position;

  return (
    <section className="inspector">
      <h2>Device</h2>
      <TextField label="Name" value={device.name} required onCommit={(name) => change({ name })} />
      <div className="field-row">
        <NumberField
          label="Height"
          unit="m"
          hint="Above the floor."
          value={z}
          {...NUMBER_LIMITS.deviceHeight}
          step={0.05}
          onCommit={(height) =>
            change({ position: [device.position[0], device.position[1], height] })
          }
        />
        {device.heading !== undefined && bearing !== undefined ? (
          <NumberField
            label="Faces"
            unit="°"
            hint={`${compassPoint(bearing)} on the compass.`}
            value={device.heading}
            {...NUMBER_LIMITS.rotation}
            step={5}
            onCommit={(heading) => change({ heading })}
          />
        ) : (
          <Field label="Faces" hint="Any way, like a bulb.">
            <button type="button" onClick={() => change({ heading: 0 })}>
              Pick a direction
            </button>
          </Field>
        )}
      </div>
      {device.heading !== undefined && !coverage.some(isCone) && (
        <button
          type="button"
          className="link"
          onClick={() => change({ heading: undefined, tilt: undefined })}
        >
          It doesn’t face any particular way
        </button>
      )}
      {device.heading !== undefined && (
        <NumberField
          label="Tilt"
          unit="°"
          hint="Degrees below level, for a sensor in a corner looking down."
          value={device.tilt ?? 0}
          {...NUMBER_LIMITS.tilt}
          step={5}
          onCommit={(tilt) => change({ tilt: tilt === 0 ? undefined : tilt })}
        />
      )}

      <h3>Covers</h3>
      {coverage.length === 0 && (
        <p className="muted">Nothing yet. Add what it senses, films or lights.</p>
      )}
      {coverage.map((item, index) => (
        <div className="coverage-row" key={index}>
          <Field label="Kind">
            <select
              value={item.kind}
              onChange={(event) =>
                changeCoverage(index, { ...item, kind: event.target.value as Coverage['kind'] })
              }
            >
              {COVERAGE_KINDS.map(({ kind, label }) => (
                <option key={kind} value={kind}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <NumberField
            label="Reach"
            unit="m"
            value={item.range}
            {...NUMBER_LIMITS.range}
            step={0.5}
            onCommit={(range) => changeCoverage(index, { ...item, range })}
          />
          <NumberField
            label="Angle"
            unit="°"
            value={item.fieldOfView ?? 360}
            {...NUMBER_LIMITS.fieldOfView}
            step={5}
            onCommit={(fieldOfView) => {
              const { fieldOfView: _old, ...rest } = item;
              changeCoverage(index, fieldOfView >= 360 ? rest : { ...rest, fieldOfView });
            }}
          />
          <button
            type="button"
            className="remove"
            title="Remove"
            aria-label={`Remove ${item.kind} coverage`}
            onClick={() => changeCoverage(index, null)}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="add"
        onClick={() =>
          change({ coverage: [...coverage, { kind: 'motion', range: 5, fieldOfView: 110 }] })
        }
      >
        Add coverage
      </button>
      {coverage.some(isCone) && (
        <p className="field-hint">An angle under 360° is a cone, centred on where it faces.</p>
      )}

      <h3>Home Assistant</h3>
      <HomeAssistantLinks
        device={device}
        room={room}
        homeAssistant={homeAssistant}
        change={change}
      />

      <dl className="facts">
        <dt>In</dt>
        <dd>{room?.name ?? device.roomId}</dd>
        <dt>Id</dt>
        <dd>
          <code>{device.id}</code>
        </dd>
      </dl>
      <DeleteButton
        label="Delete device"
        onClick={() =>
          dispatch({
            type: 'edit',
            layout: deleteItem(layout, { kind: 'device', id: device.id }),
            select: null,
          })
        }
      />
    </section>
  );
}

/** The entities a device is linked to, with their live states while connected. */
function HomeAssistantLinks({
  device,
  room,
  homeAssistant,
  change,
}: {
  device: Device;
  room: Room | undefined;
  homeAssistant: HomeAssistantView | null;
  change: (patch: DevicePatch) => void;
}) {
  if (!device.ha) {
    return <p className="muted">Not linked. Drag a device from Home Assistant onto the plan.</p>;
  }
  const { ha } = device;
  const registries = homeAssistant?.registries;
  const entries = new Map(registries?.entities.map((entity) => [entity.entity_id, entity]));
  const haDevice = ha.deviceId
    ? registries?.devices.find((candidate) => candidate.id === ha.deviceId)
    : undefined;
  const area = haDevice?.area_id
    ? registries?.areas.find((candidate) => candidate.area_id === haDevice.area_id)
    : undefined;
  const mismatch = area && room?.ha && room.ha.areaId !== area.area_id;
  return (
    <>
      <ul className="entities">
        {ha.entityIds.map((entityId) => {
          const entry = entries.get(entityId);
          const live = homeAssistant?.entity(entityId);
          return (
            <li key={entityId}>
              <span className="entity-name">
                {entry && homeAssistant ? entityName(entry, homeAssistant.entity) : entityId}
                <code>{entityId}</code>
              </span>
              {homeAssistant && (
                <span className={`entity-state${live ? '' : ' missing'}`}>
                  {live ? formatState(live) : 'not found'}
                </span>
              )}
              <button
                type="button"
                className="remove"
                title="Unlink this entity"
                aria-label={`Unlink ${entityId}`}
                onClick={() => {
                  const entityIds = ha.entityIds.filter((id) => id !== entityId);
                  change({ ha: entityIds.length ? { ...ha, entityIds } : undefined });
                }}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
      {mismatch && (
        <p className="field-hint warning-text">
          Home Assistant has this device in {area.name}, but it’s placed in {room.name}.
        </p>
      )}
      {!homeAssistant && (
        <p className="field-hint">Connect to Home Assistant to see live states.</p>
      )}
    </>
  );
}

function formatState(entity: HassEntity): string {
  const unit = entity.attributes.unit_of_measurement;
  return typeof unit === 'string' && unit ? `${entity.state} ${unit}` : entity.state;
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
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
