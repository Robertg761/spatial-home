package expo.modules.arcorescanner

import kotlin.math.abs
import kotlin.math.hypot

/**
 * A closed room's corners where ARCore puts their anchors now, for aiming at and drawing its walls.
 * Wall `i` runs from corner `i` to the next, and stands from the floor up to the ceiling.
 */
internal class RoomWalls(val index: Int, val corners: List<FloatArray>, val ceiling: Float) {
  val count get() = corners.size

  fun start(wall: Int) = corners[wall]

  fun end(wall: Int) = corners[(wall + 1) % corners.size]

  fun length(wall: Int): Float {
    val a = start(wall)
    val b = end(wall)
    return hypot(b[0] - a[0], b[2] - a[2])
  }

  /** The world point `along` metres along `wall` and `height` metres above the floor there. */
  fun point(wall: Int, along: Float, height: Float): FloatArray {
    val a = start(wall)
    val b = end(wall)
    val length = length(wall)
    val t = if (length > 0f) (along / length).coerceIn(0f, 1f) else 0f
    return floatArrayOf(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + height, a[2] + (b[2] - a[2]) * t)
  }
}

/** Where a ray meets a wall: `along` it from its first corner and `height` above the floor. */
internal data class WallHitPoint(
  val room: Int,
  val wall: Int,
  val along: Float,
  val height: Float,
  val wallLength: Float,
  val distance: Float,
)

/**
 * The nearest wall of `rooms` that the ray from `origin` along `direction` meets, within
 * `maxDistance` metres. A wall is a vertical rectangle on the line between its corners, from the floor
 * to the ceiling. A hit just past an edge, by up to [EDGE_SLACK], counts and is moved onto the edge,
 * so a door's corner can be marked where it meets a wall's end or the floor.
 */
internal fun hitWall(origin: FloatArray, direction: FloatArray, rooms: List<RoomWalls>, maxDistance: Float): WallHitPoint? {
  var best: WallHitPoint? = null
  for (room in rooms) {
    for (wall in 0 until room.count) {
      val a = room.start(wall)
      val b = room.end(wall)
      val length = room.length(wall)
      if (length < MIN_WALL_LENGTH) continue
      val ux = (b[0] - a[0]) / length
      val uz = (b[2] - a[2]) / length
      // The wall's horizontal normal. Walls are vertical, so the ray meets the wall's plane where
      // its distance along this normal matches the wall's.
      val nx = -uz
      val nz = ux
      val facing = direction[0] * nx + direction[2] * nz
      if (abs(facing) < 1e-4f) continue
      val t = ((a[0] - origin[0]) * nx + (a[2] - origin[2]) * nz) / facing
      if (t <= 0f || t > maxDistance || (best != null && t >= best.distance)) continue
      val x = origin[0] + direction[0] * t
      val y = origin[1] + direction[1] * t
      val z = origin[2] + direction[2] * t
      val along = (x - a[0]) * ux + (z - a[2]) * uz
      if (along < -EDGE_SLACK || along > length + EDGE_SLACK) continue
      val floor = a[1] + (b[1] - a[1]) * (along / length).coerceIn(0f, 1f)
      val height = y - floor
      if (height < -EDGE_SLACK || height > room.ceiling + EDGE_SLACK) continue
      best = WallHitPoint(room.index, wall, along.coerceIn(0f, length), height.coerceIn(0f, room.ceiling), length, t)
    }
  }
  return best
}

private const val EDGE_SLACK = 0.1f
private const val MIN_WALL_LENGTH = 0.05f
