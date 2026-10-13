import { z } from 'zod';

// What a phone scanner hands over: the rooms it captured, in the AR session's world coordinates.
//
// ARKit (RoomPlan) and ARCore share one convention, which this format uses unchanged: metres, a
// right-handed frame with y pointing up against gravity, and x and z horizontal. Every room in one
// scan must be in the same session, so their positions relate. The importer turns this into a
// home-layout.json: it squares the plan up to the walls, closes wall loops into room outlines, and
// puts doors, windows and furniture where they belong.

export const SCAN_FORMAT = 'spatial-home/room-scan';
export const SCAN_VERSION = 1;

export const Vector3Schema = z
  .tuple([z.number(), z.number(), z.number()])
  .describe('[x, y, z] in metres, y up.');

export const ScanWallSchema = z
  .strictObject({
    id: z.string().min(1).optional(),
    start: Vector3Schema.describe('One bottom corner of the wall, where it meets the floor.'),
    end: Vector3Schema.describe('The other bottom corner.'),
    height: z.number().positive(),
  })
  .describe('A flat wall, as a vertical rectangle standing on the floor.');

export const ScanOpeningSchema = z.strictObject({
  id: z.string().min(1).optional(),
  kind: z.enum(['door', 'window', 'opening']).describe('"opening" is a doorway with no door.'),
  center: Vector3Schema.describe('Centre of the opening.'),
  width: z.number().positive(),
  height: z.number().positive(),
  wallId: z
    .string()
    .min(1)
    .optional()
    .describe('The wall it is in, when the scanner knows. Otherwise the nearest wall is used.'),
});

export const ScanObjectSchema = z
  .strictObject({
    id: z.string().min(1).optional(),
    category: z
      .string()
      .min(1)
      .describe(
        'What it is, such as RoomPlan\'s "bed", "sofa", "table", "television" or "storage".'
      ),
    center: Vector3Schema.describe('Centre of the bounding box.'),
    size: z
      .tuple([z.number().positive(), z.number().positive(), z.number().positive()])
      .describe('[width, height, depth] of the box before it is turned.'),
    yaw: z
      .number()
      .describe('Turn about the vertical axis, in radians, anticlockwise seen from above.'),
  })
  .describe('A piece of furniture or an appliance, as a box.');

export const RoomScanSchema = z.strictObject({
  name: z.string().min(1).optional(),
  category: z
    .string()
    .min(1)
    .optional()
    .describe('What kind of room the scanner thinks it is, such as "bedroom" or "kitchen".'),
  outline: z
    .array(Vector3Schema)
    .min(3)
    .optional()
    .describe(
      'Floor corners in order around the room, when the scanner has them, such as from a guided capture where the user taps each corner. Otherwise the outline is built from the walls.'
    ),
  ceilingHeight: z
    .number()
    .positive()
    .optional()
    .describe(
      'Floor to ceiling, in metres, when measured or entered. Otherwise the tallest wall is used.'
    ),
  walls: z.array(ScanWallSchema).default([]),
  openings: z.array(ScanOpeningSchema).default([]),
  objects: z.array(ScanObjectSchema).default([]),
});

export const ScanSessionSchema = z.strictObject({
  format: z.literal(SCAN_FORMAT),
  version: z.literal(SCAN_VERSION),
  source: z
    .strictObject({
      platform: z.string().min(1).describe('Such as "ios-roomplan" or "android-arcore".'),
      method: z.string().min(1).optional().describe('Such as "automatic" or "guided".'),
      app: z.string().min(1).optional(),
    })
    .optional(),
  worldNorth: z
    .number()
    .min(0)
    .lt(360)
    .optional()
    .describe(
      'Compass bearing of the world -z axis, when the session knows it (ARKit gravityAndHeading).'
    ),
  rooms: z.array(RoomScanSchema).min(1),
});

export type Vector3 = z.infer<typeof Vector3Schema>;
export type ScanWall = z.infer<typeof ScanWallSchema>;
export type ScanOpening = z.infer<typeof ScanOpeningSchema>;
export type ScanObject = z.infer<typeof ScanObjectSchema>;
export type RoomScan = z.infer<typeof RoomScanSchema>;
export type ScanSession = z.infer<typeof ScanSessionSchema>;
/** A scan as a scanner may write it, with empty lists left out. */
export type ScanSessionInput = z.input<typeof ScanSessionSchema>;
