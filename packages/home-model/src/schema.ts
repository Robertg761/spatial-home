import { z } from 'zod';

// The home-layout.json format, version 1.
//
// Coordinates are in metres on a flat plan shared by every floor, so floors stack: x grows to the
// right of the plan and y grows towards its top. Heights (z) are measured from the floor surface
// of the item's own floor. Angles are degrees clockwise: a plan heading of 0 points to the top of
// the plan, 90 to its right. `site.northBearing` says which compass direction the top of the plan
// faces, so compass directions are worked out rather than stored and stay right when a room moves.

export const LAYOUT_FORMAT = 'spatial-home/home-layout';
export const LAYOUT_VERSION = 1;
/** The id an opening's `connects` uses for the outside of the home. */
export const OUTSIDE = 'outside';

const IdString = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 'Use letters, digits and _ . : - only')
  .max(100);
const Id = IdString.describe('Unique across every item in the layout.');
/** A reference to another item's id. */
const Ref = IdString;

const Name = z.string().min(1).max(200);
const Length = z.number().positive().describe('Metres, greater than zero.');
const Distance = z.number().nonnegative().describe('Metres, zero or more.');
const Bearing = z.number().min(0).lt(360).describe('Degrees clockwise, from 0 up to 360.');

export const Point2Schema = z
  .tuple([z.number(), z.number()])
  .describe('[x, y] on the plan, in metres.');
export const Point3Schema = z
  .tuple([z.number(), z.number(), z.number()])
  .describe('[x, y, z]: plan position, and height above the floor, in metres.');

export const SiteSchema = z.strictObject({
  northBearing: Bearing.describe(
    'The compass bearing the top of the plan faces: 0 when the top of the plan is north, 90 when it is east.'
  ),
});

export const FloorSchema = z.strictObject({
  id: Id,
  name: Name,
  level: z.int().describe('Storey number: 0 is the ground floor, negative numbers are below it.'),
  elevation: z.number().describe('Height of this floor surface above the ground floor, in metres.'),
  ha: z.strictObject({ floorId: z.string().min(1) }).optional(),
});

export const RoomSchema = z.strictObject({
  id: Id,
  name: Name,
  floorId: Ref.describe('The floor this room is on.'),
  outline: z
    .array(Point2Schema)
    .min(3)
    .describe(
      'Corners in order around the room. Wall i runs from corner i to corner i + 1, and the last wall closes the outline.'
    ),
  ceilingHeight: Length,
  ha: z.strictObject({ areaId: z.string().min(1) }).optional(),
});

const OpeningFields = {
  id: Id,
  name: Name.optional(),
  wall: z
    .strictObject({ roomId: Ref, index: z.int().nonnegative() })
    .describe('The wall of `roomId` the opening sits in.'),
  offset: Distance.describe('Distance from the start of the wall to the centre of the opening.'),
  width: Length,
  height: Length,
  connects: Ref.describe('The room on the other side of the wall, or "outside".'),
};

export const DoorSchema = z.strictObject({ kind: z.literal('door'), ...OpeningFields });
export const WindowSchema = z.strictObject({
  kind: z.literal('window'),
  ...OpeningFields,
  sillHeight: Distance.describe('Height of the bottom of the window above the floor.'),
});
export const PassageSchema = z
  .strictObject({ kind: z.literal('passage'), ...OpeningFields })
  .describe('A gap in a wall with no door, such as an open archway.');
export const OpeningSchema = z.discriminatedUnion('kind', [
  DoorSchema,
  WindowSchema,
  PassageSchema,
]);

export const FixtureSchema = z
  .strictObject({
    id: Id,
    name: Name,
    kind: z
      .string()
      .min(1)
      .max(50)
      .describe('What it is, such as "bed", "sofa", "armchair", "desk", "table" or "tv".'),
    roomId: Ref.describe('The room it is in.'),
    position: Point2Schema.describe('Centre of the footprint on the plan.'),
    size: z.strictObject({ width: Length, depth: Length, height: Length }),
    rotation: Bearing.describe('Rotation of the footprint, clockwise.'),
  })
  .describe('Furniture and other things people refer to: the bed, the sofa, the desk.');

export const CoverageSchema = z
  .strictObject({
    kind: z.enum(['motion', 'presence', 'camera', 'light']),
    range: Length,
    fieldOfView: z
      .number()
      .gt(0)
      .max(360)
      .optional()
      .describe(
        'Horizontal angle covered, centred on the heading. Omitted means all around (360).'
      ),
  })
  .describe('What a device senses or lights, as a cone or circle around it.');

export const DeviceSchema = z
  .strictObject({
    id: Id,
    name: Name,
    roomId: Ref.describe('The room it is in.'),
    position: Point3Schema,
    heading: Bearing.optional().describe(
      'Plan heading the device faces. Needed for any coverage narrower than 360°.'
    ),
    tilt: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe('Degrees below horizontal; negative points up.'),
    coverage: z.array(CoverageSchema).optional(),
    ha: z
      .strictObject({
        deviceId: z.string().min(1).optional(),
        entityIds: z.array(z.string().regex(/^[a-z0-9_]+\.[a-z0-9_]+$/, 'Not an entity id')).min(1),
      })
      .optional()
      .describe(
        'A physical device can carry several entities, such as motion, temperature and battery.'
      ),
  })
  .describe('A physical device placed in the home.');

export const HomeLayoutSchema = z
  .strictObject({
    format: z.literal(LAYOUT_FORMAT),
    version: z.literal(LAYOUT_VERSION),
    name: Name.optional(),
    site: SiteSchema,
    floors: z.array(FloorSchema),
    rooms: z.array(RoomSchema),
    openings: z.array(OpeningSchema),
    fixtures: z.array(FixtureSchema),
    devices: z.array(DeviceSchema),
  })
  .describe('A Spatial Home layout: the rooms of a home, how they connect, and what is in them.');

export type Point2 = z.infer<typeof Point2Schema>;
export type Point3 = z.infer<typeof Point3Schema>;
export type Site = z.infer<typeof SiteSchema>;
export type Floor = z.infer<typeof FloorSchema>;
export type Room = z.infer<typeof RoomSchema>;
export type Door = z.infer<typeof DoorSchema>;
export type Window = z.infer<typeof WindowSchema>;
export type Passage = z.infer<typeof PassageSchema>;
export type Opening = z.infer<typeof OpeningSchema>;
export type Fixture = z.infer<typeof FixtureSchema>;
export type Coverage = z.infer<typeof CoverageSchema>;
export type Device = z.infer<typeof DeviceSchema>;
export type HomeLayout = z.infer<typeof HomeLayoutSchema>;
