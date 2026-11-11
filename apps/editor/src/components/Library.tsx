import type { HomeLayout } from '@spatial-home/home-model';
import { useMemo, useState, type DragEvent, type FormEvent } from 'react';
import { FIXTURE_PRESETS, matchRoomsToAreas, type Placement } from '../editor/things.ts';
import {
  describeItem,
  filterCatalog,
  placedId,
  type CatalogGroup,
  type CatalogItem,
} from '../ha/catalog.ts';
import {
  SIMULATOR_AVAILABLE,
  loadSavedLink,
  type HomeAssistantLink,
  type LinkSnapshot,
} from '../ha/link.ts';

interface LibraryProps {
  layout: HomeLayout;
  link: HomeAssistantLink;
  snapshot: LinkSnapshot;
  catalog: CatalogGroup[];
  placing: Placement | null;
  /** The device selected on the plan, to show which one it is in the list. */
  selectedDeviceId: string | undefined;
  /** Picks something to place with the next click on the plan, or cancels with null. */
  onPick: (placement: Placement | null) => void;
  /** Called when a drag towards the plan ends, whether or not it was dropped there. */
  onDragEnd: () => void;
  onSelectDevice: (id: string) => void;
  onEdit: (layout: HomeLayout, message: string) => void;
}

/** What can be put on the plan: devices from Home Assistant, and furniture. */
export function Library(props: LibraryProps) {
  return (
    <aside className="library" aria-label="Things to place">
      <HomeAssistantSection {...props} />
      <FurnitureSection {...props} />
    </aside>
  );
}

function HomeAssistantSection(props: LibraryProps) {
  const { snapshot, link } = props;
  return (
    <section className="library-section">
      <h2>
        Home Assistant
        {snapshot.status !== 'off' && (
          <span className={`status status-${statusTone(snapshot.status)}`}>
            {statusLabel(snapshot)}
          </span>
        )}
      </h2>
      {snapshot.status === 'off' ? (
        <ConnectForm link={link} />
      ) : (
        <>
          {snapshot.error && <p className="error-text">{snapshot.error}</p>}
          {snapshot.registries ? (
            <DeviceList {...props} />
          ) : (
            snapshot.status !== 'auth-failed' && <p className="muted">Loading devices…</p>
          )}
          <div className="library-actions">
            {snapshot.registries && (
              <button
                type="button"
                onClick={() => link.refresh()}
                title="Fetch the device list again"
              >
                Refresh
              </button>
            )}
            <button type="button" onClick={() => link.disconnect()}>
              {snapshot.status === 'auth-failed' ? 'Change token' : 'Disconnect'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function ConnectForm({ link }: { link: HomeAssistantLink }) {
  const [saved] = useState(loadSavedLink);
  const [url, setUrl] = useState(saved?.url ?? '');
  const [token, setToken] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(link.connect(url, token, remember) ?? '');
  };
  return (
    <form className="connect" onSubmit={submit}>
      <p className="muted">
        Connect to place your devices and link rooms to areas. The address and token go straight
        from this browser to Home Assistant.
      </p>
      <label className="field">
        <span className="field-label">Address</span>
        <input
          type="text"
          value={url}
          placeholder="http://homeassistant.local:8123"
          autoComplete="url"
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">Long-lived access token</span>
        <input
          type="password"
          value={token}
          autoComplete="off"
          onChange={(event) => setToken(event.target.value)}
        />
        <span className="field-hint">
          Make one in Home Assistant: your profile, then Security, then Long-lived access tokens.
        </span>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={remember}
          onChange={(event) => setRemember(event.target.checked)}
        />
        Stay connected on this browser
      </label>
      {error && <p className="error-text">{error}</p>}
      <div className="library-actions">
        <button type="submit" className="primary">
          Connect
        </button>
        {SIMULATOR_AVAILABLE && (
          <button
            type="button"
            onClick={() => void link.connectSimulator()}
            title="A pretend Home Assistant with five rooms of devices, for trying things out"
          >
            Use the demo home
          </button>
        )}
      </div>
    </form>
  );
}

function DeviceList({
  layout,
  catalog,
  placing,
  selectedDeviceId,
  onPick,
  onDragEnd,
  onSelectDevice,
  onEdit,
  snapshot,
}: LibraryProps) {
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterCatalog(catalog, query), [catalog, query]);
  const areas = snapshot.registries?.areas ?? [];
  const roomsByArea = new Map(
    layout.rooms.flatMap((room) => (room.ha ? [[room.ha.areaId, room] as const] : []))
  );
  const total = catalog.reduce((sum, group) => sum + group.items.length, 0);
  const placed = catalog.reduce(
    (sum, group) => sum + group.items.filter((item) => placedId(layout, item)).length,
    0
  );
  const linkedAreas = areas.filter((area) => roomsByArea.has(area.area_id)).length;
  const matches = matchRoomsToAreas(layout, areas);

  if (total === 0) {
    return <p className="muted">Home Assistant has no devices that can be placed.</p>;
  }
  return (
    <>
      <p className="summary">
        {placed} of {total} devices placed. {linkedAreas} of {areas.length} areas linked to rooms.
      </p>
      {matches.linked > 0 && (
        <button
          type="button"
          className="fix"
          onClick={() =>
            onEdit(
              matches.layout,
              `Linked ${matches.linked} ${matches.linked === 1 ? 'room' : 'rooms'} to the area with the same name.`
            )
          }
        >
          Link {matches.linked} {matches.linked === 1 ? 'room' : 'rooms'} to areas by name
        </button>
      )}
      <input
        type="search"
        className="search"
        placeholder="Find a device"
        aria-label="Find a device"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {shown.length === 0 && <p className="muted">No devices match.</p>}
      {shown.map((group) => {
        const room = group.areaId ? roomsByArea.get(group.areaId) : undefined;
        return (
          <div key={group.areaId ?? ''} className="device-group">
            <h3>
              {group.name}
              {group.areaId && (
                <span className={room ? 'muted' : 'unlinked'}>
                  {room ? `→ ${room.name}` : 'no room'}
                </span>
              )}
            </h3>
            <ul>
              {group.items.map((item) => {
                const placedAs = placedId(layout, item);
                return (
                  <DeviceRow
                    key={item.key}
                    item={item}
                    placedAs={placedAs}
                    selected={placedAs !== undefined && placedAs === selectedDeviceId}
                    roomName={(id) => {
                      const device = layout.devices.find((candidate) => candidate.id === id);
                      return layout.rooms.find((candidate) => candidate.id === device?.roomId)
                        ?.name;
                    }}
                    active={placing?.kind === 'device' && placing.key === item.key}
                    onPick={onPick}
                    onDragEnd={onDragEnd}
                    onSelectDevice={onSelectDevice}
                  />
                );
              })}
            </ul>
          </div>
        );
      })}
    </>
  );
}

function DeviceRow({
  item,
  placedAs,
  selected,
  roomName,
  active,
  onPick,
  onDragEnd,
  onSelectDevice,
}: {
  item: CatalogItem;
  placedAs: string | undefined;
  selected: boolean;
  roomName: (deviceId: string) => string | undefined;
  active: boolean;
  onPick: (placement: Placement | null) => void;
  onDragEnd: () => void;
  onSelectDevice: (id: string) => void;
}) {
  const placement: Placement = { kind: 'device', key: item.key, name: item.name };
  const where = placedAs ? roomName(placedAs) : undefined;
  return (
    <li>
      <button
        type="button"
        draggable
        className={`device-row${placedAs ? ' placed' : ''}${active ? ' active' : ''}${selected ? ' selected' : ''}`}
        aria-current={selected || undefined}
        title={
          placedAs
            ? 'Click to select it on the plan, or drag it somewhere else'
            : 'Drag onto the plan, or click and then click the plan'
        }
        onClick={() => {
          if (placedAs) onSelectDevice(placedAs);
          else onPick(active ? null : placement);
        }}
        onDragStart={(event) => startDrag(event, placement, item.name, onPick)}
        onDragEnd={onDragEnd}
      >
        <span className="device-row-name">{item.name}</span>
        <span className="device-row-detail">
          {placedAs ? `✓ ${where ? `In ${where}` : 'Placed'}` : describeItem(item)}
        </span>
      </button>
    </li>
  );
}

function FurnitureSection({ placing, onPick, onDragEnd }: LibraryProps) {
  return (
    <section className="library-section">
      <h2>Furniture</h2>
      <p className="muted">
        The things people mention, so “the lamp by the sofa” means something. Drag one into a room.
      </p>
      <div className="furniture">
        {FIXTURE_PRESETS.map((preset) => {
          const placement: Placement = { kind: 'fixture', preset };
          const active = placing?.kind === 'fixture' && placing.preset.kind === preset.kind;
          return (
            <button
              key={preset.kind}
              type="button"
              draggable
              className={active ? 'active' : ''}
              title={`${preset.size.width} × ${preset.size.depth} m`}
              onClick={() => onPick(active ? null : placement)}
              onDragStart={(event) => startDrag(event, placement, preset.label, onPick)}
              onDragEnd={onDragEnd}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function startDrag(
  event: DragEvent,
  placement: Placement,
  label: string,
  onPick: (placement: Placement) => void
): void {
  // Firefox only starts a drag that carries some data.
  event.dataTransfer.setData('text/plain', label);
  event.dataTransfer.effectAllowed = 'copy';
  onPick(placement);
}

function statusTone(status: LinkSnapshot['status']): 'good' | 'busy' | 'bad' {
  if (status === 'connected') return 'good';
  if (status === 'auth-failed' || status === 'disconnected') return 'bad';
  return 'busy';
}

function statusLabel(snapshot: LinkSnapshot): string {
  const where = snapshot.source === 'simulator' ? 'Demo home' : 'Connected';
  switch (snapshot.status) {
    case 'connected':
      return snapshot.source === 'simulator'
        ? where
        : `${where}${snapshot.haVersion ? ` · ${snapshot.haVersion}` : ''}`;
    case 'auth-failed':
      return 'Token refused';
    case 'reconnecting':
    case 'disconnected':
      return 'Offline';
    default:
      return 'Connecting…';
  }
}
