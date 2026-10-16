package expo.modules.arcorescanner

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** A closed room whose walls can be aimed at, as JavaScript passes it in `wallRooms`. */
class WallRoomRecord : Record {
  @Field val cornerIds: List<Int> = emptyList()

  @Field val ceilingHeight: Double = 2.4
}

/** A rectangle on a wall of `wallRooms`, such as a door or window, in metres. */
class WallRectRecord : Record {
  @Field val room: Int = 0

  @Field val wall: Int = 0

  @Field val from: Double = 0.0

  @Field val to: Double = 0.0

  @Field val bottom: Double = 0.0

  @Field val top: Double = 0.0
}

/** A point on a wall of `wallRooms`: metres along it from its first corner, and above the floor. */
class WallPointRecord : Record {
  @Field val room: Int = 0

  @Field val wall: Int = 0

  @Field val along: Double = 0.0

  @Field val height: Double = 0.0
}
