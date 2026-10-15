package expo.modules.arcorescanner

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.opengl.Matrix
import android.view.WindowManager
import androidx.core.content.ContextCompat
import com.google.ar.core.Camera
import com.google.ar.core.Config
import com.google.ar.core.Plane
import com.google.ar.core.Session
import com.google.ar.core.TrackingFailureReason
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.CameraNotAvailableException
import com.google.ar.core.exceptions.SessionPausedException
import com.google.ar.core.exceptions.UnavailableApkTooOldException
import com.google.ar.core.exceptions.UnavailableArcoreNotInstalledException
import com.google.ar.core.exceptions.UnavailableDeviceNotCompatibleException
import com.google.ar.core.exceptions.UnavailableSdkTooOldException
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.Collections
import java.util.WeakHashMap
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.hypot

/**
 * The camera view for a guided capture. It runs the ARCore session, finds the floor, and works out
 * where the crosshair at the centre of the screen meets it. It draws the floor, the corners placed
 * so far and the walls between them over the camera image.
 *
 * The corners themselves belong to JavaScript: it asks for the aim point with `getAimAsync`, keeps
 * the list, and passes it back as the `corners` prop to be drawn.
 */
class ArcoreScannerView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext), GLSurfaceView.Renderer {

  override val shouldUseAndroidLayout = true

  private val onTrackingChange by EventDispatcher()
  private val onAim by EventDispatcher()
  private val onError by EventDispatcher()

  private val surface = GLSurfaceView(context).apply {
    preserveEGLContextOnPause = true
    setEGLContextClientVersion(2)
    setEGLConfigChooser(8, 8, 8, 8, 16, 0)
    setRenderer(this@ArcoreScannerView)
    renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
  }

  private val background = BackgroundRenderer()
  private val overlay = OverlayRenderer()

  // Touched by both the main thread and the GL thread.
  @Volatile private var session: Session? = null
  @Volatile private var resumed = false
  @Volatile private var displayChanged = true
  @Volatile private var corners: List<FloatArray> = emptyList()
  @Volatile private var lastAim: Aim? = null

  private var active = false
  private var textureSession: Session? = null
  private var viewportWidth = 0
  private var viewportHeight = 0
  private var floorHeight: Float? = null
  private var lastTracking = ""
  private var lastAimEventAt = 0L

  private val projection = FloatArray(16)
  private val viewMatrix = FloatArray(16)
  private val viewProjection = FloatArray(16)

  init {
    addView(surface, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    instances.add(this)
  }

  /** Where the crosshair meets the floor, in world coordinates. */
  private data class Aim(val x: Float, val y: Float, val z: Float)

  fun setActive(value: Boolean) {
    active = value
    if (value) resume() else pause()
  }

  fun setCorners(points: List<List<Double>>) {
    corners = points.filter { it.size == 3 }.map { floatArrayOf(it[0].toFloat(), it[1].toFloat(), it[2].toFloat()) }
  }

  /** The current aim point as [x, y, z], or null when the crosshair isn't on the floor. */
  fun aim(): List<Double>? = lastAim?.let { listOf(it.x.toDouble(), it.y.toDouble(), it.z.toDouble()) }

  fun onHostResume() {
    if (active) resume()
  }

  fun onHostPause() = pause()

  fun destroy() {
    pause()
    session?.close()
    session = null
    instances.remove(this)
  }

  private fun resume() {
    if (resumed) return
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      emitError("camera-permission", "The camera permission is needed to scan.")
      return
    }
    try {
      val current = session ?: Session(context).also {
        configure(it)
        session = it
      }
      current.resume()
      surface.onResume()
      resumed = true
      displayChanged = true
    } catch (e: UnavailableArcoreNotInstalledException) {
      emitError("arcore-not-installed", "Google Play Services for AR isn't installed.")
    } catch (e: UnavailableApkTooOldException) {
      emitError("arcore-too-old", "Google Play Services for AR needs updating.")
    } catch (e: UnavailableSdkTooOldException) {
      emitError("app-too-old", "This version of the app is too old for the installed ARCore.")
    } catch (e: UnavailableDeviceNotCompatibleException) {
      emitError("device-not-supported", "This phone doesn't support ARCore.")
    } catch (e: CameraNotAvailableException) {
      emitError("camera-unavailable", "The camera is in use by another app.")
    } catch (e: Exception) {
      emitError("unknown", e.message ?: e.toString())
    }
  }

  private fun pause() {
    if (!resumed) return
    resumed = false
    surface.onPause()
    session?.pause()
  }

  private fun configure(session: Session) {
    val config = Config(session).apply {
      // Guided capture only needs the floor, so it works the same on phones without the Depth API.
      planeFindingMode = Config.PlaneFindingMode.HORIZONTAL
      updateMode = Config.UpdateMode.LATEST_CAMERA_IMAGE
      focusMode = Config.FocusMode.AUTO
      depthMode = Config.DepthMode.DISABLED
      lightEstimationMode = Config.LightEstimationMode.DISABLED
    }
    session.configure(config)
  }

  // --- GLSurfaceView.Renderer, on the GL thread ---

  override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
    GLES20.glClearColor(0f, 0f, 0f, 1f)
    background.create()
    overlay.create()
    textureSession = null
  }

  override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
    GLES20.glViewport(0, 0, width, height)
    viewportWidth = width
    viewportHeight = height
    displayChanged = true
  }

  override fun onDrawFrame(gl: GL10?) {
    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
    val current = session ?: return
    if (!resumed) return
    if (textureSession !== current) {
      current.setCameraTextureName(background.textureId)
      textureSession = current
    }
    if (displayChanged) {
      current.setDisplayGeometry(displayRotation(), viewportWidth, viewportHeight)
      displayChanged = false
    }

    val frame = try {
      current.update()
    } catch (e: SessionPausedException) {
      return
    } catch (e: CameraNotAvailableException) {
      emitError("camera-unavailable", "The camera stopped working.")
      return
    }

    background.draw(frame)
    val camera = frame.camera
    val floors = current.getAllTrackables(Plane::class.java).filter {
      it.trackingState == TrackingState.TRACKING &&
        it.subsumedBy == null &&
        it.type == Plane.Type.HORIZONTAL_UPWARD_FACING
    }
    reportTracking(camera, floors.isNotEmpty())
    if (camera.trackingState != TrackingState.TRACKING) {
      lastAim = null
      return
    }

    camera.getProjectionMatrix(projection, 0, 0.05f, 50f)
    camera.getViewMatrix(viewMatrix, 0)
    Matrix.multiplyMM(viewProjection, 0, projection, 0, viewMatrix, 0)

    val placed = corners
    val lowest = floorHeightFrom(floors, camera)
    floorHeight = placed.firstOrNull()?.get(1) ?: lowest
    val aim = floorHeight?.let { aimAt(camera, it) }
    lastAim = aim
    // The corners went on a table or bed found before the floor was.
    val cornersRaised = placed.isNotEmpty() && lowest != null && placed[0][1] - lowest > MIN_FLOOR_DROP

    drawFloors(floors)
    drawCorners(placed, aim)
    reportAim(aim, placed, cornersRaised)
  }

  /**
   * The floor is the lowest upward-facing plane, since the camera can't see anything below the
   * floor, while tables and beds are always above it. Planes too small to be more than a patch, or
   * not clearly below the phone, are ignored.
   */
  private fun floorHeightFrom(planes: List<Plane>, camera: Camera): Float? {
    val eye = camera.pose.ty()
    return planes
      .filter { eye - it.centerPose.ty() > MIN_FLOOR_DROP && it.extentX * it.extentZ >= MIN_FLOOR_AREA }
      .minOfOrNull { it.centerPose.ty() }
  }

  /**
   * Where the line from the camera through the centre of the screen meets the floor's height. The
   * floor ARCore detects rarely reaches the corners of a room, so this uses the floor's height
   * rather than the detected area itself.
   */
  private fun aimAt(camera: Camera, floor: Float): Aim? {
    val pose = camera.displayOrientedPose
    val z = pose.zAxis
    // The camera looks along its -z axis.
    val dx = -z[0]
    val dy = -z[1]
    val dz = -z[2]
    if (dy > -0.15f) return null
    val t = (floor - pose.ty()) / dy
    if (t <= 0f || t > MAX_AIM_DISTANCE) return null
    return Aim(pose.tx() + dx * t, floor, pose.tz() + dz * t)
  }

  private fun drawFloors(planes: List<Plane>) {
    val points = ArrayList<Float>()
    val local = FloatArray(3)
    val world = FloatArray(3)
    for (plane in planes) {
      val polygon = plane.polygon
      val count = polygon.limit() / 2
      for (i in 0 until count) {
        for ((j, k) in listOf(i to (i + 1) % count)) {
          for (index in listOf(j, k)) {
            local[0] = polygon.get(index * 2)
            local[1] = 0f
            local[2] = polygon.get(index * 2 + 1)
            plane.centerPose.transformPoint(local, 0, world, 0)
            points.add(world[0])
            points.add(world[1])
            points.add(world[2])
          }
        }
      }
    }
    overlay.draw(GLES20.GL_LINES, points.toFloatArray(), viewProjection, FLOOR_COLOR, lineWidth = 2f)
  }

  private fun drawCorners(placed: List<FloatArray>, aim: Aim?) {
    if (placed.size >= 2) {
      val walls = FloatArray(placed.size * 3)
      placed.forEachIndexed { i, corner -> corner.copyInto(walls, i * 3) }
      overlay.draw(GLES20.GL_LINE_STRIP, walls, viewProjection, WALL_COLOR, lineWidth = 6f)
    }
    val last = placed.lastOrNull()
    if (aim != null && last != null) {
      overlay.draw(GLES20.GL_LINES, floatArrayOf(last[0], last[1], last[2], aim.x, aim.y, aim.z), viewProjection, PREVIEW_COLOR)
    }
    if (placed.isNotEmpty()) {
      val dots = FloatArray(placed.size * 3)
      placed.forEachIndexed { i, corner -> corner.copyInto(dots, i * 3) }
      overlay.draw(GLES20.GL_POINTS, dots, viewProjection, WALL_COLOR, pointSize = 22f)
    }
    if (aim != null) {
      overlay.draw(GLES20.GL_POINTS, floatArrayOf(aim.x, aim.y, aim.z), viewProjection, AIM_COLOR, pointSize = 30f)
    }
  }

  private fun reportTracking(camera: Camera, floorFound: Boolean) {
    val state = when (camera.trackingState) {
      TrackingState.TRACKING -> "tracking"
      TrackingState.PAUSED -> "paused"
      else -> "stopped"
    }
    val reason = when (camera.trackingFailureReason) {
      TrackingFailureReason.INSUFFICIENT_LIGHT -> "insufficient-light"
      TrackingFailureReason.EXCESSIVE_MOTION -> "excessive-motion"
      TrackingFailureReason.INSUFFICIENT_FEATURES -> "insufficient-features"
      TrackingFailureReason.CAMERA_UNAVAILABLE -> "camera-unavailable"
      TrackingFailureReason.BAD_STATE -> "bad-state"
      else -> "none"
    }
    val key = "$state:$reason:$floorFound"
    if (key == lastTracking) return
    lastTracking = key
    post { onTrackingChange(mapOf("state" to state, "reason" to reason, "floorFound" to floorFound)) }
  }

  /** Tells JavaScript where the crosshair is a few times a second, for the live measurements. */
  private fun reportAim(aim: Aim?, placed: List<FloatArray>, cornersRaised: Boolean) {
    val now = System.currentTimeMillis()
    if (now - lastAimEventAt < AIM_EVENT_INTERVAL_MS) return
    lastAimEventAt = now
    val event = mutableMapOf<String, Any>("onFloor" to (aim != null), "cornersRaised" to cornersRaised)
    if (aim != null) {
      event["point"] = listOf(aim.x.toDouble(), aim.y.toDouble(), aim.z.toDouble())
      placed.lastOrNull()?.let { event["fromLast"] = hypot((aim.x - it[0]).toDouble(), (aim.z - it[2]).toDouble()) }
      placed.firstOrNull()?.let { event["toFirst"] = hypot((aim.x - it[0]).toDouble(), (aim.z - it[2]).toDouble()) }
    }
    post { onAim(event) }
  }

  private fun emitError(code: String, message: String) {
    post { onError(mapOf("code" to code, "message" to message)) }
  }

  @Suppress("DEPRECATION")
  private fun displayRotation(): Int =
    (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.rotation

  companion object {
    /** Live views, so the module can pause and resume them with the app. */
    val instances: MutableSet<ArcoreScannerView> = Collections.synchronizedSet(Collections.newSetFromMap(WeakHashMap()))

    private const val MAX_AIM_DISTANCE = 8f
    /** How far below the phone, in metres, a plane must be to count as the floor. */
    private const val MIN_FLOOR_DROP = 0.3f
    /** The smallest plane, in square metres, that counts as the floor rather than a patch of it. */
    private const val MIN_FLOOR_AREA = 0.25f
    private const val AIM_EVENT_INTERVAL_MS = 150L
    private val FLOOR_COLOR = floatArrayOf(1f, 1f, 1f, 0.35f)
    private val WALL_COLOR = floatArrayOf(0.15f, 0.39f, 0.92f, 1f)
    private val PREVIEW_COLOR = floatArrayOf(0.15f, 0.39f, 0.92f, 0.6f)
    private val AIM_COLOR = floatArrayOf(1f, 1f, 1f, 0.95f)
  }
}
