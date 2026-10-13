export {
  CoverageSchema,
  DeviceSchema,
  DoorSchema,
  FixtureSchema,
  FloorSchema,
  HomeLayoutSchema,
  LAYOUT_FORMAT,
  LAYOUT_VERSION,
  OUTSIDE,
  OpeningSchema,
  PassageSchema,
  Point2Schema,
  Point3Schema,
  RoomSchema,
  SiteSchema,
  WindowSchema,
} from './schema.ts';
export type {
  Coverage,
  Device,
  Door,
  Fixture,
  Floor,
  HomeLayout,
  Opening,
  Passage,
  Point2,
  Point3,
  Room,
  Site,
  Window,
} from './schema.ts';
export { createEmptyLayout, serializeLayout } from './layout.ts';
export { parseLayoutJson, validateLayout } from './validate.ts';
export type { LayoutIssue, ValidationResult } from './validate.ts';
export {
  EPSILON,
  compassBearing,
  compassPoint,
  distance,
  isSimplePolygon,
  openingCenter,
  openingFacing,
  planHeading,
  pointInPolygon,
  polygonArea,
  polygonCentroid,
  roomConnections,
  roomWalls,
  signedArea,
  wallOutwardNormal,
} from './geometry.ts';
export type { CompassPoint, Connection, Facing, Wall } from './geometry.ts';
