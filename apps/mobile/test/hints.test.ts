import { describe, expect, test } from 'vitest';
import type { TrackingEvent, Vector3 } from '../modules/arcore-scanner/index.ts';
import { formatDistance, openingHint, parseCeilingHeight, scanHint } from '../src/scan/hints.ts';

const tracking: TrackingEvent = { state: 'tracking', reason: 'none', floorFound: true };
const three: Vector3[] = [
  [0, -1.3, 0],
  [4, -1.3, 0],
  [4, -1.3, -3],
];

describe('scanHint', () => {
  test('explains why tracking paused', () => {
    expect(
      scanHint({ ...tracking, state: 'paused', reason: 'insufficient-light' }, null, [])
    ).toMatch(/dark/);
    expect(
      scanHint({ ...tracking, state: 'paused', reason: 'excessive-motion' }, null, [])
    ).toMatch(/slowly/);
  });

  test('asks for the floor before the first corner', () => {
    expect(scanHint({ ...tracking, floorFound: false }, null, [])).toMatch(/find it/);
    expect(scanHint(tracking, { onFloor: false }, [])).toMatch(/crosshair at the floor/);
    expect(scanHint(tracking, { onFloor: true, point: [0, -1.3, 0] }, [])).toMatch(
      /corner of the room/
    );
  });

  test('warns when the corners turn out to be on furniture', () => {
    expect(scanHint(tracking, { onFloor: true, cornersRaised: true }, three)).toMatch(
      /table or bed/
    );
    expect(scanHint(tracking, { onFloor: true, cornersRaised: true }, [])).toMatch(
      /corner of the room/
    );
  });

  test('says when tapping will close the room', () => {
    expect(scanHint(tracking, { onFloor: true, toFirst: 0.1 }, three)).toMatch(/close the room/);
    expect(scanHint(tracking, { onFloor: true, toFirst: 1 }, three)).toMatch(/next corner/);
    expect(scanHint(tracking, { onFloor: true, toFirst: 0.1 }, three.slice(0, 2))).toMatch(
      /next corner/
    );
  });
});

test('formatDistance switches to centimetres under a metre', () => {
  expect(formatDistance(0.854)).toBe('85 cm');
  expect(formatDistance(2.345)).toBe('2.35 m');
});

test('parseCeilingHeight accepts believable heights, with a comma or a point', () => {
  expect(parseCeilingHeight('2.4')).toBe(2.4);
  expect(parseCeilingHeight(' 2,7 ')).toBe(2.7);
  expect(parseCeilingHeight('24')).toBeNull();
  expect(parseCeilingHeight('')).toBeNull();
  expect(parseCeilingHeight('tall')).toBeNull();
});

describe('openingHint', () => {
  const onWall = (wall: number) => ({
    onFloor: false,
    wall: { room: 0, wall, along: 1, height: 2, wallLength: 4 },
  });
  const pending = { room: 0, wall: 1, along: 1, height: 2 };

  test('asks for a wall, then each corner in turn', () => {
    expect(openingHint(tracking, { onFloor: false }, 'door', null)).toMatch(/at a wall/);
    expect(openingHint(tracking, onWall(1), 'door', null)).toMatch(/top corner of the door/);
    expect(openingHint(tracking, onWall(1), 'window', null)).toMatch(/bottom corner of the window/);
    expect(openingHint(tracking, onWall(1), 'opening', pending)).toMatch(
      /other top corner of the doorway/
    );
    expect(openingHint(tracking, onWall(1), 'window', pending)).toMatch(/opposite top corner/);
  });

  test('says when the crosshair moved to another wall', () => {
    expect(openingHint(tracking, onWall(2), 'door', pending)).toMatch(/another wall/);
  });

  test('tracking problems come first', () => {
    expect(
      openingHint(
        { state: 'paused', reason: 'excessive-motion', floorFound: true },
        onWall(1),
        'door',
        null
      )
    ).toMatch(/more slowly/);
  });
});
