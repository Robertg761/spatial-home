package expo.modules.arcorescanner

import com.google.ar.core.ArCoreApk
import com.google.ar.core.exceptions.UnavailableDeviceNotCompatibleException
import com.google.ar.core.exceptions.UnavailableUserDeclinedInstallationException
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ArcoreScannerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ArcoreScanner")

    /**
     * Whether this phone can run ARCore: "supported", "needs-install", "needs-update",
     * "unsupported", "checking" while ARCore is still finding out (ask again shortly), or "unknown"
     * when it couldn't find out, such as when the check timed out offline (worth trying again).
     */
    AsyncFunction("getAvailabilityAsync") {
      val context = appContext.reactContext ?: return@AsyncFunction "checking"
      val availability = ArCoreApk.getInstance().checkAvailability(context)
      when (availability) {
        ArCoreApk.Availability.SUPPORTED_INSTALLED -> "supported"
        ArCoreApk.Availability.SUPPORTED_NOT_INSTALLED -> "needs-install"
        ArCoreApk.Availability.SUPPORTED_APK_TOO_OLD -> "needs-update"
        ArCoreApk.Availability.UNSUPPORTED_DEVICE_NOT_CAPABLE -> "unsupported"
        // UNKNOWN_ERROR and UNKNOWN_TIMED_OUT say nothing about the phone itself.
        else -> if (availability.isTransient) "checking" else "unknown"
      }
    }

    /**
     * Makes sure Google Play Services for AR is ready, installing or updating it if needed. ARCore
     * wants this before every session, even when it's installed, since it also fetches the phone's
     * calibration data. "installed" when it's ready, "requested" when an install has started (check
     * again when the app returns, with userRequested false), "declined", or "unsupported".
     */
    AsyncFunction("requestInstallAsync") { userRequested: Boolean, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("no-activity", "The app isn't in the foreground.", null)
        return@AsyncFunction
      }
      try {
        when (ArCoreApk.getInstance().requestInstall(activity, userRequested)) {
          ArCoreApk.InstallStatus.INSTALLED -> promise.resolve("installed")
          else -> promise.resolve("requested")
        }
      } catch (e: UnavailableUserDeclinedInstallationException) {
        promise.resolve("declined")
      } catch (e: UnavailableDeviceNotCompatibleException) {
        promise.resolve("unsupported")
      } catch (e: Exception) {
        promise.reject("install-failed", e.message ?: e.toString(), e)
      }
    }.runOnQueue(Queues.MAIN)

    View(ArcoreScannerView::class) {
      Events("onTrackingChange", "onAim", "onError")

      Prop("active") { view: ArcoreScannerView, active: Boolean -> view.setActive(active) }

      Prop("cornerIds") { view: ArcoreScannerView, ids: List<Int> -> view.setCornerIds(ids) }

      Prop("aimMode") { view: ArcoreScannerView, mode: String? -> view.setAimWalls(mode == "walls") }

      Prop("wallRooms") { view: ArcoreScannerView, rooms: List<WallRoomRecord>? -> view.setWallRooms(rooms ?: emptyList()) }

      Prop("openings") { view: ArcoreScannerView, rects: List<WallRectRecord>? -> view.setOpenings(rects ?: emptyList()) }

      Prop("pendingCorner") { view: ArcoreScannerView, point: WallPointRecord? -> view.setPendingCorner(point) }

      AsyncFunction("anchorAimAsync") { view: ArcoreScannerView, ids: List<Int>, promise: Promise ->
        view.anchorAim(ids, promise)
      }

      AsyncFunction("getCornerPositionsAsync") { view: ArcoreScannerView, ids: List<Int>, promise: Promise ->
        view.cornerPositions(ids, promise)
      }

      AsyncFunction("wallAimAsync") { view: ArcoreScannerView, promise: Promise -> view.wallAim(promise) }

      AsyncFunction("removeCornersAsync") { view: ArcoreScannerView, ids: List<Int>, promise: Promise ->
        view.removeCorners(ids, promise)
      }

      OnViewDestroys { view: ArcoreScannerView -> view.destroy() }
    }

    OnActivityEntersForeground {
      ArcoreScannerView.instances.toList().forEach { it.onHostResume() }
    }

    OnActivityEntersBackground {
      ArcoreScannerView.instances.toList().forEach { it.onHostPause() }
    }
  }
}
