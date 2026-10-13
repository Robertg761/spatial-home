import {
  isSimplePolygon,
  openingCenter,
  polygonArea,
  polygonCentroid,
  roomWalls,
  type HomeLayout,
  type Opening,
  type Point2,
} from '@spatial-home/home-model';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch } from 'react';
import {
  OPENING_DEFAULTS,
  addOpening,
  addRoom,
  findRoom,
  moveCorner,
  moveRoom,
  nearestWall,
  roomsOnFloor,
  snapPoint,
  snapToGrid,
  type OpeningKind,
  type WallHit,
} from '../editor/plan.ts';
import type { EditorAction, EditorState } from '../editor/state.ts';

export type Tool = 'select' | 'room' | OpeningKind;

interface View {
  /** Plan point at the centre of the view, in metres. */
  cx: number;
  cy: number;
  /** Pixels per metre. */
  scale: number;
}

type Drag =
  | { kind: 'pan'; pointerId: number; startClient: Point2; startView: View }
  | { kind: 'room'; pointerId: number; roomId: string; start: Point2; startLayout: HomeLayout }
  | { kind: 'corner'; pointerId: number; roomId: string; index: number; startLayout: HomeLayout };

/** How close, in pixels, the cursor must be to a corner or wall to snap to it. */
const SNAP_PIXELS = 12;
const MIN_SCALE = 5;
const MAX_SCALE = 400;

interface PlanViewProps {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  tool: Tool;
  /** Item ids with validation errors or warnings, to outline on the plan. */
  flagged: Map<string, 'error' | 'warning'>;
  onMessage: (message: string) => void;
  /** Changing this number fits the view to the floor. */
  fitRequest: number;
}

export function PlanView({ state, dispatch, tool, flagged, onMessage, fitRequest }: PlanViewProps) {
  const { layout, floorId, selection } = state;
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  const [view, setView] = useState<View>({ cx: 0, cy: 0, scale: 50 });
  const [cursor, setCursor] = useState<Point2 | null>(null);
  const [draft, setDraft] = useState<Point2[]>([]);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const drag = useRef<Drag | null>(null);

  const rooms = roomsOnFloor(layout, floorId);
  const roomIds = new Set(rooms.map((room) => room.id));
  const openings = layout.openings.filter((opening) => roomIds.has(opening.wall.roomId));
  const snapDistance = SNAP_PIXELS / view.scale;

  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  // Fit the view to the floor when asked, and when the floor or the plan's size changes.
  const fitKey = `${fitRequest}:${floorId}`;
  const lastFit = useRef('');
  useEffect(() => {
    if (lastFit.current === fitKey || size.width === 0) return;
    lastFit.current = fitKey;
    setView(
      fitView(
        rooms.flatMap((room) => room.outline),
        size
      )
    );
  }, [fitKey, rooms, size]);

  // Drafts belong to the room tool and the floor they were started on.
  useEffect(() => setDraft([]), [tool, floorId]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (isTyping(event)) return;
      if (event.code === 'Space') setSpaceHeld(true);
      if (tool !== 'room' || draft.length === 0) return;
      if (event.key === 'Escape') setDraft([]);
      if (event.key === 'Backspace') setDraft((points) => points.slice(0, -1));
      if (event.key === 'Enter') finishRoom(draft);
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    return () => {
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
    };
  });

  // React's wheel listener is passive, so it can't stop the page from scrolling.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = toPlan(svg, event.clientX, event.clientY);
      setView((current) => {
        const scale = clamp(current.scale * Math.exp(-event.deltaY * 0.0015), MIN_SCALE, MAX_SCALE);
        const ratio = current.scale / scale;
        return {
          scale,
          cx: point[0] + (current.cx - point[0]) * ratio,
          cy: point[1] + (current.cy - point[1]) * ratio,
        };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);

  const finishRoom = useCallback(
    (points: Point2[]) => {
      if (points.length < 3) {
        onMessage('A room needs at least three corners.');
        return;
      }
      if (!isSimplePolygon(points)) {
        onMessage(
          'Those walls cross each other. Undo the last corner with Backspace, or press Esc to start over.'
        );
        return;
      }
      const { layout: next, id } = addRoom(layout, floorId, points);
      dispatch({ type: 'edit', layout: next, select: { kind: 'room', id } });
      setDraft([]);
    },
    [dispatch, floorId, layout, onMessage]
  );

  const wallHit: WallHit | null =
    cursor && isOpeningTool(tool) ? nearestWall(layout, floorId, cursor, snapDistance) : null;

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const point = toPlan(svg, event.clientX, event.clientY);

    if (event.button === 1 || (event.button === 0 && spaceHeld)) {
      startDrag(event, {
        kind: 'pan',
        pointerId: event.pointerId,
        startClient: [event.clientX, event.clientY],
        startView: view,
      });
      return;
    }
    if (event.button !== 0) return;

    if (tool === 'room') {
      const snapped = snapPoint(layout, floorId, point, snapDistance);
      const first = draft[0];
      if (first && draft.length >= 3 && sameSpot(snapped, first, snapDistance)) {
        finishRoom(draft);
      } else if (!draft.some((corner) => sameSpot(corner, snapped, 1e-6))) {
        setDraft([...draft, snapped]);
      }
      return;
    }

    if (isOpeningTool(tool)) {
      const hit = nearestWall(layout, floorId, point, snapDistance);
      if (!hit) {
        onMessage(`Click on a wall to add a ${tool}.`);
        return;
      }
      const result = addOpening(layout, tool, hit);
      if ('error' in result) {
        onMessage(result.error);
      } else {
        dispatch({
          type: 'edit',
          layout: result.layout,
          select: { kind: 'opening', id: result.id },
        });
      }
      return;
    }

    // Select tool: what's under the pointer decides what the drag does.
    const target = (event.target as Element).closest<SVGElement>('[data-kind]');
    const kind = target?.dataset.kind;
    const id = target?.dataset.id;
    if (kind === 'corner' && id) {
      dispatch({ type: 'gesture-start' });
      startDrag(event, {
        kind: 'corner',
        pointerId: event.pointerId,
        roomId: id,
        index: Number(target.dataset.index),
        startLayout: layout,
      });
    } else if (kind === 'opening' && id) {
      dispatch({ type: 'select', selection: { kind: 'opening', id } });
    } else if (kind === 'room' && id) {
      dispatch({ type: 'select', selection: { kind: 'room', id } });
      dispatch({ type: 'gesture-start' });
      startDrag(event, {
        kind: 'room',
        pointerId: event.pointerId,
        roomId: id,
        start: point,
        startLayout: layout,
      });
    } else {
      dispatch({ type: 'select', selection: null });
      startDrag(event, {
        kind: 'pan',
        pointerId: event.pointerId,
        startClient: [event.clientX, event.clientY],
        startView: view,
      });
    }
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const point = toPlan(svg, event.clientX, event.clientY);
    setCursor(point);

    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (current.kind === 'pan') {
      const { startView, startClient } = current;
      setView({
        ...startView,
        cx: startView.cx - (event.clientX - startClient[0]) / startView.scale,
        cy: startView.cy + (event.clientY - startClient[1]) / startView.scale,
      });
    } else if (current.kind === 'room') {
      const [dx, dy] = snapToGrid([point[0] - current.start[0], point[1] - current.start[1]]);
      dispatch({
        type: 'gesture-update',
        layout: moveRoom(current.startLayout, current.roomId, dx, dy),
      });
    } else {
      // Snap to other rooms' corners, so the corner being dragged doesn't snap back to itself.
      const others = {
        ...current.startLayout,
        rooms: current.startLayout.rooms.filter((room) => room.id !== current.roomId),
      };
      const snapped = snapPoint(others, floorId, point, snapDistance);
      dispatch({
        type: 'gesture-update',
        layout: moveCorner(current.startLayout, current.roomId, current.index, snapped),
      });
    }
  };

  const endDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (current.kind !== 'pan') dispatch({ type: 'gesture-end' });
  };

  const startDrag = (event: React.PointerEvent<SVGSVGElement>, next: Drag) => {
    drag.current = next;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const viewBox = [
    view.cx - size.width / 2 / view.scale,
    -view.cy - size.height / 2 / view.scale,
    size.width / view.scale,
    size.height / view.scale,
  ];
  const px = 1 / view.scale;
  const snappedCursor =
    cursor && tool === 'room' ? snapPoint(layout, floorId, cursor, snapDistance) : null;
  const lastDraft = draft.at(-1);

  return (
    <div className={`plan tool-${tool}${spaceHeld ? ' panning' : ''}`}>
      <svg
        ref={svgRef}
        viewBox={viewBox.join(' ')}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setCursor(null)}
        onDoubleClick={() => tool === 'room' && draft.length >= 3 && finishRoom(draft)}
        role="application"
        aria-label="Floor plan"
      >
        <Grid viewBox={viewBox} scale={view.scale} />

        {rooms.map((room) => {
          const selected = selection?.kind === 'room' && selection.id === room.id;
          const flag = flagged.get(room.id);
          const [lx, ly] = polygonCentroid(room.outline);
          return (
            <g key={room.id}>
              <polygon
                data-kind="room"
                data-id={room.id}
                className={`room${selected ? ' selected' : ''}${flag ? ` flagged-${flag}` : ''}`}
                points={room.outline.map(([x, y]) => `${x},${-y}`).join(' ')}
              />
              <text className="room-label" x={lx} y={-ly} fontSize={13 * px} textAnchor="middle">
                <tspan x={lx} dy={-0.2 * 13 * px}>
                  {room.name}
                </tspan>
                <tspan x={lx} dy={1.3 * 13 * px} className="room-area">
                  {formatArea(polygonArea(room.outline))}
                </tspan>
              </text>
            </g>
          );
        })}

        {openings.map((opening) => (
          <OpeningMark
            key={opening.id}
            layout={layout}
            opening={opening}
            px={px}
            selected={selection?.kind === 'opening' && selection.id === opening.id}
            flag={flagged.get(opening.id)}
          />
        ))}

        {selection?.kind === 'room' &&
          roomIds.has(selection.id) &&
          tool === 'select' &&
          findRoom(layout, selection.id).outline.map(([x, y], index) => (
            <circle
              key={index}
              data-kind="corner"
              data-id={selection.id}
              data-index={index}
              className="corner-handle"
              cx={x}
              cy={-y}
              r={5 * px}
            />
          ))}

        {tool === 'room' && draft.length > 0 && (
          <g className="draft">
            <polyline
              points={[...draft, ...(snappedCursor ? [snappedCursor] : [])]
                .map(([x, y]) => `${x},${-y}`)
                .join(' ')}
            />
            {draft.map(([x, y], index) => (
              <circle
                key={index}
                cx={x}
                cy={-y}
                r={(index === 0 ? 5 : 3) * px}
                className={index === 0 ? 'draft-start' : ''}
              />
            ))}
            {lastDraft && snappedCursor && (
              <text
                x={(lastDraft[0] + snappedCursor[0]) / 2}
                y={-(lastDraft[1] + snappedCursor[1]) / 2 - 6 * px}
                fontSize={12 * px}
                textAnchor="middle"
                className="draft-length"
              >
                {formatLength(
                  Math.hypot(snappedCursor[0] - lastDraft[0], snappedCursor[1] - lastDraft[1])
                )}
              </text>
            )}
          </g>
        )}

        {snappedCursor && (
          <circle className="cursor" cx={snappedCursor[0]} cy={-snappedCursor[1]} r={3 * px} />
        )}

        {wallHit && isOpeningTool(tool) && (
          <OpeningPreview layout={layout} hit={wallHit} kind={tool} px={px} />
        )}
      </svg>

      <div className="plan-hint">{hintFor(tool, draft.length)}</div>
      {cursor && (
        <div className="plan-cursor">
          {formatLength(cursor[0])}, {formatLength(cursor[1])}
        </div>
      )}
    </div>
  );
}

function OpeningMark({
  layout,
  opening,
  px,
  selected,
  flag,
}: {
  layout: HomeLayout;
  opening: Opening;
  px: number;
  selected: boolean;
  flag: 'error' | 'warning' | undefined;
}) {
  const room = layout.rooms.find((candidate) => candidate.id === opening.wall.roomId);
  const wall = room ? roomWalls(room)[opening.wall.index] : undefined;
  if (!room || !wall || wall.length === 0) return null;
  const [cx, cy] = openingCenter(room, opening);
  const ux = (wall.end[0] - wall.start[0]) / wall.length;
  const uy = (wall.end[1] - wall.start[1]) / wall.length;
  const half = opening.width / 2;
  const a: Point2 = [cx - ux * half, cy - uy * half];
  const b: Point2 = [cx + ux * half, cy + uy * half];
  return (
    <g
      data-kind="opening"
      data-id={opening.id}
      className={`opening opening-${opening.kind}${selected ? ' selected' : ''}${flag ? ` flagged-${flag}` : ''}`}
    >
      {/* A wide invisible line, so a thin opening is easy to click. */}
      <line
        className="opening-hit"
        x1={a[0]}
        y1={-a[1]}
        x2={b[0]}
        y2={-b[1]}
        strokeWidth={14 * px}
      />
      <line className="opening-gap" x1={a[0]} y1={-a[1]} x2={b[0]} y2={-b[1]} />
      <line className="opening-line" x1={a[0]} y1={-a[1]} x2={b[0]} y2={-b[1]} />
    </g>
  );
}

function OpeningPreview({
  layout,
  hit,
  kind,
  px,
}: {
  layout: HomeLayout;
  hit: WallHit;
  kind: OpeningKind;
  px: number;
}) {
  const room = findRoom(layout, hit.roomId);
  const wall = roomWalls(room)[hit.wallIndex];
  const width = OPENING_DEFAULTS[kind].width;
  if (!wall || wall.length < width) return null;
  const offset = clamp(hit.offset, width / 2, wall.length - width / 2);
  const [cx, cy] = openingCenter(room, { wall: { roomId: room.id, index: hit.wallIndex }, offset });
  const ux = (wall.end[0] - wall.start[0]) / wall.length;
  const uy = (wall.end[1] - wall.start[1]) / wall.length;
  return (
    <line
      className={`opening-preview opening-${kind}`}
      x1={cx - (ux * width) / 2}
      y1={-(cy - (uy * width) / 2)}
      x2={cx + (ux * width) / 2}
      y2={-(cy + (uy * width) / 2)}
      strokeWidth={6 * px}
    />
  );
}

function Grid({ viewBox, scale }: { viewBox: number[]; scale: number }) {
  const [x0 = 0, y0 = 0, width = 0, height = 0] = viewBox;
  const step = scale < 12 ? 5 : scale < 40 ? 1 : 0.5;
  const lines = [];
  for (let x = Math.ceil(x0 / step) * step; x <= x0 + width; x += step) {
    const major = Math.abs(x - Math.round(x)) < 1e-9;
    lines.push(
      <line
        key={`x${x}`}
        className={major ? 'grid-major' : 'grid-minor'}
        x1={x}
        y1={y0}
        x2={x}
        y2={y0 + height}
      />
    );
  }
  for (let y = Math.ceil(y0 / step) * step; y <= y0 + height; y += step) {
    const major = Math.abs(y - Math.round(y)) < 1e-9;
    lines.push(
      <line
        key={`y${y}`}
        className={major ? 'grid-major' : 'grid-minor'}
        x1={x0}
        y1={y}
        x2={x0 + width}
        y2={y}
      />
    );
  }
  return (
    <g className="grid">
      {lines}
      <line className="grid-axis" x1={0} y1={y0} x2={0} y2={y0 + height} />
      <line className="grid-axis" x1={x0} y1={0} x2={x0 + width} y2={0} />
    </g>
  );
}

function hintFor(tool: Tool, draftLength: number): string {
  switch (tool) {
    case 'select':
      return 'Click a room or opening to edit it. Drag to move a room or its corners. Drag the background to pan, scroll to zoom.';
    case 'room':
      return draftLength === 0
        ? 'Click to place the first corner. Corners snap to a 10 cm grid and to other rooms.'
        : 'Click to add corners. Click the first corner, double-click or press Enter to finish. Backspace undoes a corner, Esc cancels.';
    default:
      return `Click a wall to add a ${tool}. What is on the other side of the wall is filled in for you.`;
  }
}

function fitView(points: Point2[], size: { width: number; height: number }): View {
  if (points.length === 0) return { cx: 5, cy: 4, scale: 50 };
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const margin = 80;
  const scale = clamp(
    Math.min(
      (size.width - margin * 2) / Math.max(maxX - minX, 1),
      (size.height - margin * 2) / Math.max(maxY - minY, 1)
    ),
    MIN_SCALE,
    MAX_SCALE
  );
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale };
}

function toPlan(svg: SVGSVGElement, clientX: number, clientY: number): Point2 {
  const matrix = svg.getScreenCTM();
  if (!matrix) return [0, 0];
  const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
  // The SVG's y runs down the screen; the plan's runs up.
  return [point.x, -point.y];
}

function isOpeningTool(tool: Tool): tool is OpeningKind {
  return tool === 'door' || tool === 'window' || tool === 'passage';
}

function isTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return (
    !!target &&
    (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')
  );
}

function sameSpot(a: Point2, b: Point2, tolerance: number): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function formatLength(metres: number): string {
  return `${(Math.round(metres * 100) / 100).toFixed(2)} m`;
}

export function formatArea(squareMetres: number): string {
  return `${(Math.round(squareMetres * 10) / 10).toFixed(1)} m²`;
}
