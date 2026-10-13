# arcore-scanner

The Android room scanner: a local Expo module in Kotlin on Google's ARCore 1.56. It shows the camera, finds the floor, and lets the person place a room's corners by aiming a crosshair at them. The app turns those corners into a [room scan](../../../../packages/scan-import), which `importScan` turns into a `home-layout.json`.

This is the guided capture described in [Android room scanning](../../../../docs/android-scanning.md). It needs only the floor plane, so it works on every ARCore-certified phone, with or without the Depth API.

## Using it

It needs a development build, because Expo Go can't load custom native code:

```sh
cd apps/mobile
npm run android   # expo run:android: builds the app and installs it on a connected phone
```

ARCore is declared optional, so the app still installs on phones without it. The scan screen then says the phone isn't supported. On a supported phone without Google Play Services for AR, it offers to install it from the Play Store.

## API

`index.ts` exports:

| Export | What it does |
| --- | --- |
| `scannerIncluded` | Whether this build has the module. False on iPhone, on the web and in Expo Go. |
| `getAvailabilityAsync()` | `supported`, `needs-install`, `needs-update`, `unsupported`, or `checking` while ARCore is still finding out. |
| `requestInstallAsync()` | Opens the Play Store to install or update ARCore. `installed`, `requested` (check again when the app comes back), `declined` or `unsupported`. |
| `ArcoreScannerView` | The camera view. Props: `active` and `corners`. Events: `onTrackingChange`, `onAim` and `onError`. Its ref has `getAimAsync()`, which gives where the crosshair meets the floor. |

Points are in ARCore's world frame: metres, y up, and the session's starting point as the origin. The room scan format uses the same frame.

Every room in one scan has to come from one AR session, so they share that frame. The scan screen keeps the view mounted, and only pauses it, while showing the result. Leaving the screen ends the session, and ARCore may not keep the same origin after the app has been in the background.

The camera permission is requested by the app, not the module.

## How it works

- `ArcoreScannerView.kt` runs the ARCore session on a `GLSurfaceView`. Each frame it draws the camera, the floor planes found so far, the walls between the corners, and the crosshair's point on the floor.
- The crosshair is a ray from the centre of the camera, intersected with the floor's height. The floor's height comes from the first corner once there is one, and otherwise from the largest upward-facing plane at least 0.5 m below the phone, so that a table isn't taken for the floor.
- `BackgroundRenderer.kt` draws the camera image, and `OverlayRenderer.kt` draws lines and points.
- The session pauses when the app goes to the background and resumes when it comes back.

## Not yet

- Doors and windows, marked on the walls. This comes next.
- Measuring the ceiling height with the phone. For now the person types it in.
- Automatic walls from depth, on phones that support it.
