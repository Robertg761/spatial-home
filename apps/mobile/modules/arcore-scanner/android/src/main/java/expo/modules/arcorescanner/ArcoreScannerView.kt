package expo.modules.arcorescanner

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.display.DisplayManager
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.opengl.Matrix
import android.view.WindowManager
import androidx.core.content.ContextCompat
import com.google.ar.core.Anchor
import com.google.ar.core.Camera
import com.google.ar.core.Config
import com.google.ar.core.Plane
import com.google.ar.core.Pose
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
import expo.modules.kotlin.Promise
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.Collections
import java.util.WeakHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.hypot

/**
 * The camera view for a guided capture. It runs the ARCore session, finds the floor, and works out
 * where the crosshair at the centre of the screen meets it. It draws the floor, the corners placed
 * so far and the walls between them over the camera image.
 *
 * Each corner is an ARCore anchor, so it stays put on the real floor as ARCore refines its map of
 * the room, rather than keeping coordinates from the frame it was placed in. JavaScript holds the
 * anchors' ids, passes the current room's as the `cornerIds` prop to be drawn, and reads their
 * current positions with `getCornerPositionsAsync`.
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
  @Volatile private var cornerIds: List<Int> = emptyList()
  @Volatile private var lastAim: Aim? = null
  // Set on the GL thread when ARCore loses the camera, so the frames that follow don't retry it.
  @Volatile private var cameraLost = false

  private var hostPaused = false
  private var cameraRetryPending = false

  private var active = false
  // Only touched on the GL thread, where ARCore wants anchors made and read.
  private val anchors = LinkedHashMap<Int, Anchor>()
  private var nextAnchorId = 1
  private val glJobs = ConcurrentLinkedQueue<GlJob>()
  private var textureSession: Session? = null
  private var viewportWidth = 0
  private var viewportHeight = 0
  private var floorHeight: Float? = null
  @Volatile private var lastTracking = ""
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

  private class GlJob(val promise: Promise, val run: (Session) -> Unit)

  fun setActive(value: Boolean) {
    active = value
    if (value) resume() else pause()
  }

  fun setCornerIds(ids: List<Int>) {
    cornerIds = ids
  }

  /** Anchors a corner at `point` and resolves with its id. */
  fun addCorner(point: List<Double>, promise: Promise) {
    if (point.size != 3) {
      promise.reject("bad-point", "A corner needs x, y and z.", null)
      return
    }
    onGlThread(promise) { session ->
      val anchor = session.createAnchor(Pose.makeTranslation(point[0].toFloat(), point[1].toFloat(), point[2].toFloat()))
      val id = nextAnchorId++
      anchors[id] = anchor
      promise.resolve(id)
    }
  }

  /** Where the corners are now, in the same order, with null for any that no longer exist. */
  fun cornerPositions(ids: List<Int>, promise: Promise) {
    onGlThread(promise) {
      promise.resolve(ids.map { id -> anchors[id]?.pose?.let { listOf(it.tx().toDouble(), it.ty().toDouble(), it.tz().toDouble()) } })
    }
  }

  fun removeCorners(ids: List<Int>, promise: Promise) {
    onGlThread(promise) {
      ids.forEach { anchors.remove(it)?.detach() }
      promise.resolve(null)
    }
  }

  /**
   * Runs `job` on the GL thread at the next frame. It fails rather than waits when the session isn't
   * running, so JavaScript never waits on a frame that won't come.
   */
  private fun onGlThread(promise: Promise, job: (Session) -> Unit) {
    if (!resumed) {
      promise.reject("not-running", NOT_RUNNING, null)
      return
    }
    glJobs.add(GlJob(promise, job))
    // The session may have paused since the check, after it failed the jobs already waiting.
    if (!resumed) failPendingJobs()
  }

  private fun runPendingJobs(session: Session) {
    while (true) {
      val job = glJobs.poll() ?: break
      try {
        job.run(session)
      } catch (e: Exception) {
        job.promise.reject("anchor-failed", e.message ?: e.toString(), e)
      }
    }
  }

  private fun failPendingJobs() {
    while (true) glJobs.poll()?.promise?.reject("not-running", NOT_RUNNING, null) ?: break
  }

  /** The current aim point as [x, y, z], or null when the crosshair isn't on the floor. */
  fun aim(): List<Double>? = lastAim?.let { listOf(it.x.toDouble(), it.y.toDouble(), it.z.toDouble()) }

  fun onHostResume() {
    hostPaused = false
    if (active) resume()
  }

  fun onHostPause() {
    hostPaused = true
    pause()
  }

  fun destroy() {
    active = false
    pause()
    failPendingJobs()
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
      cameraLost = false
      surface.onResume()
      displayManager.registerDisplayListener(displayListener, null)
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
      retryCamera()
    } catch (e: Exception) {
      emitError("unknown", e.message ?: e.toString())
    }
  }

  private fun pause() {
    if (!resumed) return
    resumed = false
    displayManager.unregisterDisplayListener(displayListener)
    surface.onPause()
    session?.pause()
    // The GL thread has stopped, so nothing else takes jobs off the queue.
    failPendingJobs()
    // The aim belongs to the last frame. After a pause ARCore may relocalise, so nothing from
    // before it can be placed: JavaScript hears tracking has stopped until a fresh frame says so.
    lastAim = null
    lastTracking = ""
    post { onTrackingChange(mapOf("state" to "stopped", "reason" to "none", "floorFound" to false)) }
  }

  /**
   * ARCore lost the camera mid-session, usually to another app. Stop as for a pause, so JavaScript
   * hears tracking has stopped and nothing waits on a frame, then try again until the camera is
   * free. Coming back to the app tries again too.
   */
  private fun onCameraLost() {
    pause()
    emitError("camera-unavailable", "The camera stopped working. Scanning picks up again once it’s free.")
    retryCamera()
  }

  /**
   * Tries the camera again shortly, on the main thread. A resume that finds the camera still taken
   * schedules the next try, so this keeps going until the camera is free, the app goes to the
   * background, or the view goes away.
   */
  private fun retryCamera() {
    if (cameraRetryPending) return
    cameraRetryPending = true
    postDelayed({
      cameraRetryPending = false
      if (active && !hostPaused && !resumed && instances.contains(this)) resume()
    }, CAMERA_RETRY_MS)
  }

  // A 180° turn changes neither the view's size nor the configuration, so only a display listener
  // hears about it, as in ARCore's Hello AR sample.
  private val displayManager = context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
  private val displayListener = object : DisplayManager.DisplayListener {
    override fun onDisplayAdded(displayId: Int) {}
    override fun onDisplayRemoved(displayId: Int) {}
    override fun onDisplayChanged(displayId: Int) {
      displayChanged = true
    }
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
    if (!resumed || cameraLost) return
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
      lastAim = null
      cameraLost = true
      post { onCameraLost() }
      return
    }
    runPendingJobs(current)

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

    // Read from the anchors every frame, so the corners follow ARCore's corrections.
    val placed = cornerIds.mapNotNull { anchors[it]?.pose }.map { floatArrayOf(it.tx(), it.ty(), it.tz()) }
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
   * The floor under the phone is the lowest upward-facing plane near it: tables and beds are always
   * above the floor, and the camera can't see below it. Only planes a phone could be held above
   * count, so a storey below that ARCore saw earlier in the session isn't taken for this room's
   * floor. Small patches are ignored.
   */
  private fun floorHeightFrom(planes: List<Plane>, camera: Camera): Float? {
    val eye = camera.pose
    return planes
      .filter { plane ->
        val drop = eye.ty() - plane.centerPose.ty()
        val reach = maxOf(plane.extentX, plane.extentZ) / 2
        val across = hypot(
          (plane.centerPose.tx() - eye.tx()).toDouble(),
          (plane.centerPose.tz() - eye.tz()).toDouble()
        ) - reach
        drop > MIN_FLOOR_DROP &&
          drop < MAX_FLOOR_DROP &&
          across < MAX_FLOOR_DISTANCE &&
          plane.extentX * plane.extentZ >= MIN_FLOOR_AREA
      }
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
    /** How far below the phone, in metres, a plane can be and still be this room's floor. */
    private const val MAX_FLOOR_DROP = 2.2f
    /** How far to the side of the phone, in metres, the floor's nearest edge can be. */
    private const val MAX_FLOOR_DISTANCE = 4.0
    /** The smallest plane, in square metres, that counts as the floor rather than a patch of it. */
    private const val MIN_FLOOR_AREA = 0.25f
    private const val AIM_EVENT_INTERVAL_MS = 150L
    private const val CAMERA_RETRY_MS = 2000L
    private const val NOT_RUNNING = "The camera isn’t running. Wait for it to start again."
    private val FLOOR_COLOR = floatArrayOf(1f, 1f, 1f, 0.35f)
    private val WALL_COLOR = floatArrayOf(0.15f, 0.39f, 0.92f, 1f)
    private val PREVIEW_COLOR = floatArrayOf(0.15f, 0.39f, 0.92f, 0.6f)
    private val AIM_COLOR = floatArrayOf(1f, 1f, 1f, 0.95f)
  }
}
