// Random edits, made the way the editor's UI makes them, checking after every step that the
// editor never breaks a layout in a way it can't repair. Seeded, so a failure always reproduces.

import {
  OUTSIDE,
  createEmptyLayout,
  isSimplePolygon,
  roomWalls,
  validateLayout,
  type HomeLayout,
  type Opening,
  type Point2,
} from '@spatial-home/home-model';
import sample from '@spatial-home/home-model/examples/sample-flat.json';
import { describe, expect, test } from 'vitest';
import {
  addOpening,
  addRoom,
  deleteItem,
  moveCorner,
  moveRoom,
  nearestWall,
  roomAcross,
  roomsOnFloor,
  snapPoint,
  snapToGrid,
  updateOpening,
  updateRoom,
  type OpeningKind,
} from '../src/editor/plan.ts';
import { editorReducer, initialState, type EditorState } from '../src/editor/state.ts';

/** Errors the editor has no way to repair, so no edit may introduce them. */
const UNREPAIRABLE = new Set([
  'unknown-floor',
  'unknown-room',
  'unknown-wall',
  'duplicate-id',
  'reserved-id',
]);

/** The snapping distance on the plan at its default zoom, in metres. */
const SNAP = 0.24;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Run {
  state: EditorState;
  /** Openings whose destination was chosen in the inspector rather than found from the walls. */
  readonly handSet = new Set<string>();
  readonly log: string[] = [];
  private readonly random: () => number;

  constructor(layout: HomeLayout, seed: number) {
    this.state = initialState(layout);
    this.random = mulberry32(seed);
  }

  int(n: number): number {
    return Math.floor(this.random() * n);
  }
  pick<T>(items: readonly T[]): T | undefined {
    return items.length === 0 ? undefined : items[this.int(items.length)];
  }
  point(): Point2 {
    return [-2 + this.random() * 16, -2 + this.random() * 12];
  }

  dispatch(action: Parameters<typeof editorReducer>[1]) {
    this.log.push(JSON.stringify(action, (key, value) => (key === 'layout' ? '…' : value)));
    this.state = editorReducer(this.state, action);
  }

  get layout() {
    return this.state.layout;
  }
  roomsHere() {
    return roomsOnFloor(this.layout, this.state.floorId);
  }
  openingsHere() {
    const ids = new Set(this.roomsHere().map((room) => room.id));
    return this.layout.openings.filter((opening) => ids.has(opening.wall.roomId));
  }

  drawRoom() {
    const corners: Point2[] = [];
    const count = 3 + this.int(3);
    const rect = this.random() < 0.6;
    if (rect) {
      const [x, y] = this.point();
      const [w, h] = [0.5 + this.random() * 5, 0.5 + this.random() * 5];
      for (const p of [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ] as Point2[]) {
        corners.push(snapPoint(this.layout, this.state.floorId, p, SNAP));
      }
    } else {
      for (let i = 0; i < count; i++) {
        corners.push(snapPoint(this.layout, this.state.floorId, this.point(), SNAP));
      }
    }
    // The room tool skips a click on a corner it already has and refuses walls that cross.
    const unique = corners.filter(
      (c, i) => corners.findIndex((d) => d[0] === c[0] && d[1] === c[1]) === i
    );
    if (unique.length < 3 || !isSimplePolygon(unique)) return;
    const { layout, id } = addRoom(this.layout, this.state.floorId, unique);
    this.dispatch({ type: 'edit', layout, select: { kind: 'room', id } });
  }

  dragRoom() {
    const room = this.pick(this.roomsHere());
    if (!room) return;
    this.dispatch({ type: 'select', selection: { kind: 'room', id: room.id } });
    this.dispatch({ type: 'gesture-start' });
    const start = this.layout;
    for (let i = 0, steps = 1 + this.int(4); i < steps; i++) {
      const [dx, dy] = snapToGrid([this.random() * 6 - 3, this.random() * 6 - 3]);
      this.dispatch({ type: 'gesture-update', layout: moveRoom(start, room.id, dx, dy) });
      this.keyDuringDrag();
    }
    this.dispatch({ type: 'gesture-end' });
  }

  dragCorner() {
    const room = this.pick(this.roomsHere());
    if (!room) return;
    const index = this.int(room.outline.length);
    this.dispatch({ type: 'gesture-start' });
    const start = this.layout;
    const others = { ...start, rooms: start.rooms.filter((other) => other.id !== room.id) };
    for (let i = 0, steps = 1 + this.int(4); i < steps; i++) {
      const [x, y] = room.outline[index]!;
      const target: Point2 = [x + this.random() * 4 - 2, y + this.random() * 4 - 2];
      const snapped = snapPoint(others, this.state.floorId, target, SNAP);
      this.dispatch({ type: 'gesture-update', layout: moveCorner(start, room.id, index, snapped) });
      this.keyDuringDrag();
    }
    this.dispatch({ type: 'gesture-end' });
  }

  /** The pointer is busy during a drag, but the keyboard isn't. */
  keyDuringDrag() {
    if (this.random() > 0.15) return;
    const { selection } = this.state;
    const roll = this.int(3);
    if (roll === 0) this.dispatch({ type: 'undo' });
    else if (roll === 1) this.dispatch({ type: 'redo' });
    else if (selection) {
      this.dispatch({ type: 'edit', layout: deleteItem(this.layout, selection), select: null });
    }
  }

  addOpening() {
    const room = this.pick(this.roomsHere());
    if (!room) return;
    const wall = this.pick(roomWalls(room));
    if (!wall) return;
    const t = this.random();
    const point: Point2 = [
      wall.start[0] + (wall.end[0] - wall.start[0]) * t,
      wall.start[1] + (wall.end[1] - wall.start[1]) * t,
    ];
    const hit = nearestWall(this.layout, this.state.floorId, point, SNAP);
    if (!hit) return;
    const kind = this.pick<OpeningKind>(['door', 'window', 'passage'])!;
    const result = addOpening(this.layout, kind, hit);
    if ('error' in result) return;
    this.dispatch({
      type: 'edit',
      layout: result.layout,
      select: { kind: 'opening', id: result.id },
    });
  }

  /** The changes the opening inspector can make, within its fields' limits. */
  updateOpening() {
    const opening = this.pick(this.openingsHere());
    if (!opening) return;
    const room = this.layout.rooms.find((r) => r.id === opening.wall.roomId)!;
    const wall = roomWalls(room)[opening.wall.index];
    this.dispatch({ type: 'select', selection: { kind: 'opening', id: opening.id } });
    let layout: HomeLayout;
    switch (this.int(5)) {
      case 0: {
        const others = this.roomsHere().filter((other) => other.id !== room.id);
        const connects = this.pick([OUTSIDE, ...others.map((other) => other.id)])!;
        if (connects !== opening.connects) this.handSet.add(opening.id);
        layout = updateOpening(this.layout, opening.id, { connects });
        break;
      }
      case 1:
        layout = updateOpening(this.layout, opening.id, {
          offset: Math.round(this.random() * (wall?.length ?? 100) * 20) / 20,
        });
        break;
      case 2:
        layout = updateOpening(this.layout, opening.id, {
          width: Math.max(0.1, Math.round(this.random() * 3 * 20) / 20),
        });
        break;
      case 3:
        layout = updateOpening(this.layout, opening.id, {
          kind: this.pick<OpeningKind>(['door', 'window', 'passage'])!,
        });
        break;
      default:
        layout = updateOpening(this.layout, opening.id, { name: this.pick(['', 'Front']) ?? '' });
    }
    this.dispatch({ type: 'edit', layout });
  }

  updateRoom() {
    const room = this.pick(this.roomsHere());
    if (!room) return;
    this.dispatch({ type: 'select', selection: { kind: 'room', id: room.id } });
    const patch =
      this.random() < 0.5 ? { name: `Room ${this.int(9)}` } : { ceilingHeight: 2 + this.int(3) };
    this.dispatch({ type: 'edit', layout: updateRoom(this.layout, room.id, patch) });
  }

  deleteSomething() {
    const item =
      this.random() < 0.5
        ? this.pick(this.roomsHere().map((room) => ({ kind: 'room' as const, id: room.id })))
        : this.pick(this.openingsHere().map((o) => ({ kind: 'opening' as const, id: o.id })));
    if (!item) return;
    this.dispatch({ type: 'edit', layout: deleteItem(this.layout, item), select: null });
  }

  step() {
    const roll = this.int(100);
    if (roll < 15) this.drawRoom();
    else if (roll < 27) this.dragRoom();
    else if (roll < 37) this.dragCorner();
    else if (roll < 52) this.addOpening();
    else if (roll < 64) this.updateOpening();
    else if (roll < 70) this.updateRoom();
    else if (roll < 77) this.deleteSomething();
    else if (roll < 84) this.dispatch({ type: 'undo' });
    else if (roll < 89) this.dispatch({ type: 'redo' });
    else if (roll < 94) {
      const floor = this.pick(this.layout.floors);
      if (floor) this.dispatch({ type: 'set-floor', floorId: floor.id });
    } else {
      const room = this.pick(this.layout.rooms);
      this.dispatch({ type: 'select', selection: room ? { kind: 'room', id: room.id } : null });
    }
  }
}

const validated = new WeakMap<HomeLayout, ReturnType<typeof validateLayout>>();
function validate(layout: HomeLayout): ReturnType<typeof validateLayout> {
  let result = validated.get(layout);
  if (!result) validated.set(layout, (result = validateLayout(layout)));
  return result;
}

function errorCodes(layout: HomeLayout): Set<string> {
  const result = validate(layout);
  return new Set(result.ok ? [] : result.errors.map((issue) => issue.code));
}

/** What a step broke that the editor couldn't put right, or null. */
function brokenBy(before: HomeLayout, after: HomeLayout): string | null {
  const was = errorCodes(before);
  for (const code of errorCodes(after)) {
    if (was.has(code)) continue;
    // A structural error, such as NaN in a coordinate, means the file can't be opened again.
    if (UNREPAIRABLE.has(code) || code.startsWith('invalid-') || code === 'not-a-layout') {
      return code;
    }
  }
  return null;
}

/** An opening an edit left running off its wall although it is narrow enough to fit, or null. */
function offItsWall(before: HomeLayout, after: HomeLayout): string | null {
  const wasOff = new Set(openingsOffTheirWalls(before).map((opening) => opening.id));
  const wall = (opening: Opening) =>
    roomWalls(after.rooms.find((room) => room.id === opening.wall.roomId)!)[opening.wall.index]!;
  const off = openingsOffTheirWalls(after).find(
    (opening) => !wasOff.has(opening.id) && opening.width <= wall(opening).length
  );
  return off ? `${off.id} runs off its wall` : null;
}

function openingsOffTheirWalls(layout: HomeLayout): Opening[] {
  const result = validate(layout);
  if (result.ok) return [];
  return result.errors
    .filter((issue) => issue.code === 'opening-outside-wall')
    .map((issue) => layout.openings[issue.path[1] as number]!);
}

function wrongDestination(run: Run): string | null {
  const { layout } = run;
  for (const opening of layout.openings) {
    if (run.handSet.has(opening.id)) continue;
    if (!layout.rooms.some((room) => room.id === opening.wall.roomId)) continue;
    const behind = roomAcross(layout, opening.wall.roomId, opening.wall.index, opening.offset);
    if (behind !== opening.connects) {
      return `${opening.id} leads to ${opening.connects} but ${behind} is behind it`;
    }
  }
  return null;
}

function sampleFlat(): HomeLayout {
  return validateLayout(structuredClone(sample)).layout!;
}

/** The sample with ids used twice: by a floor and a room, two rooms, and two openings. */
function withDuplicateIds(): HomeLayout {
  const flat = sampleFlat();
  const kitchen = flat.rooms.find((room) => room.id === 'kitchen')!;
  return {
    ...flat,
    floors: [...flat.floors, { id: 'hallway', name: 'Loft', level: 1, elevation: 3 }],
    rooms: [
      ...flat.rooms,
      { ...kitchen, outline: kitchen.outline.map(([x, y]) => [x - 5, y] as Point2) },
    ],
    openings: [...flat.openings, { ...flat.openings[0]! }],
  };
}

/** Where to start, and how many runs from there. */
const STARTS: [string, () => HomeLayout, number][] = [
  ['the sample flat', sampleFlat, 50],
  ['a new layout', () => createEmptyLayout(), 80],
  ['a layout without floors', () => ({ ...createEmptyLayout(), floors: [] }), 80],
  ['a layout with duplicate ids', withDuplicateIds, 30],
];

describe('random edits', () => {
  for (const [name, start, runs] of STARTS) {
    test(`keep ${name} repairable`, () => {
      for (let seed = 1; seed <= runs; seed++) {
        const run = new Run(start(), seed * 7919 + name.length);
        const initial = run.layout;
        const where = () => `seed ${seed}, after:\n${run.log.slice(-8).join('\n')}`;
        // Edits find items by id, so every id must be unique from the start.
        expect(errorCodes(initial)).not.toContain('duplicate-id');
        expect(errorCodes(initial)).not.toContain('reserved-id');
        for (let i = 0; i < 25; i++) {
          const before = run.layout;
          try {
            run.step();
          } catch (error) {
            throw new Error(`${String(error)} (${where()})`, { cause: error });
          }
          expect(brokenBy(before, run.layout), where()).toBeNull();
          expect(offItsWall(before, run.layout), where()).toBeNull();
          expect(wrongDestination(run), where()).toBeNull();
        }

        // Undoing every step gets back to the start, and redoing them all to the end.
        const end = run.layout;
        const steps = run.state.past.length;
        for (let i = 0; i < steps; i++) run.dispatch({ type: 'undo' });
        expect(run.layout, where()).toEqual(initial);
        for (let i = 0; i < steps; i++) run.dispatch({ type: 'redo' });
        expect(run.layout, where()).toEqual(end);
      }
    });
  }
});
