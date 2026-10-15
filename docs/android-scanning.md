# Android room scanning

Research into how to scan rooms on Android phones, October 2026. It covers what ARCore offers, which phones support what, the ways to get walls, doors and windows, and how to build it into the Expo app.

Labels: **[Fact]** has a linked source. **[Inference]** is reasoning from the facts. **[Unverified]** was looked for and not confirmed.

## Summary

- **Android has no equivalent of RoomPlan.** ARCore gives tracking, horizontal and vertical planes, and depth, but nothing that outputs walls, doors or windows. A feature request for one, opened in June 2026, has had no reply from Google ([issue #1772](https://github.com/google-ar/arcore-android-sdk/issues/1772)).
- **The classic ARCore SDK is maintained.** Version 1.56.0 came out on 4 September 2026 and added depth in metres ([releases](https://github.com/google-ar/arcore-android-sdk/releases)). Jetpack XR's ARCore runtime for phones is still a developer preview, and depends on classic ARCore anyway ([docs](https://developer.android.com/develop/xr/jetpack-xr-sdk/arcore/mobile)). Build on classic ARCore.
- **Build guided capture first.** The user taps the floor corners on the detected floor plane, sets the ceiling height, and marks doors and windows on the walls. It works on every ARCore-certified phone without the Depth API. Automatic wall fitting can follow on phones that support depth.
- **Testing only on the S24 Ultra hides problems.** It supports the Depth API and has a flagship chip and camera. It has no time-of-flight sensor that ARCore uses, so its depth works the same way as a mid-range phone's, just faster and cleaner. A second, cheaper test phone is strongly advised.
- **Integration:** write an Expo module in Kotlin on ARCore. `@reactvision/react-viro` 3.0.3 targets Expo 57 and React Native 0.86 and is a workable route for prototyping. Either way, the app needs a development build, not Expo Go.

## 1. ARCore today

### Maintenance

- **[Fact]** The classic SDK has released regularly: 1.50 (July 2025), 1.51 (October 2025), 1.52 (December 2025), 1.53 (March 2026), 1.54 (April 2026) and 1.56 (4 September 2026). Version 1.56 adds `AcquireDepthImageMeters` and `AcquireRawDepthImageMeters`, giving depth in metres as floats. It also raises `targetSdkVersion` to API 37 through manifest merging ([releases](https://github.com/google-ar/arcore-android-sdk/releases)).
- **[Fact]** Jetpack XR's ARCore library (`androidx.xr.arcore`) reached 1.0.0-beta02 in August 2026 ([release notes](https://developer.android.com/jetpack/androidx/releases/xr-arcore)). Its phone runtime is labelled a developer preview in which "some features may be missing or may not work as expected", and it still needs `com.google.ar:core` ([mobile page](https://developer.android.com/develop/xr/jetpack-xr-sdk/arcore/mobile)).
- **[Fact]** Jetpack XR labels planes as wall, floor, ceiling or table, but its planes page lists only XR headsets and wired glasses as supported devices ([planes](https://developer.android.com/develop/xr/jetpack-xr-sdk/arcore/planes)). **[Unverified]** whether the labels work on phones. Classic ARCore only says whether a plane faces up, faces down or is vertical ([Plane.Type](https://developers.google.com/ar/reference/java/com/google/ar/core/Plane.Type)).
- **[Inference]** Nothing has replaced ARCore on phones. Jetpack XR targets headsets and glasses first. It's worth watching, but not building on yet.

### Features that matter for rooms

- **Plane detection.** Horizontal and vertical planes are supported, but Google notes vertical surfaces are "harder to detect" ([design guide](https://developers.google.com/ar/design/environment/definition)). Detection relies on visual features, so plain painted walls often yield no plane at all ([Unity forum](https://discussions.unity.com/t/vertical-plane-detection-difficulty-in-real-world-ar-foundation/817101)). The floor plane is the most reliable thing ARCore finds.
- **Depth API.** Depth comes from motion with a single camera, merged with time-of-flight data where a phone has a sensor. It reaches 65 m but is most accurate from 0.5 to 5 m, is imprecise on featureless surfaces such as white walls, and only arrives once the phone moves ([depth](https://developers.google.com/ar/develop/depth)).
- **Full and raw depth.** Full depth is smoothed and dense, with no confidence values. Raw depth is sparse but more accurate, comes with a confidence image, and costs about half the computation. Google recommends raw depth for 3D reconstruction, measurement and shape detection. Blank walls often get zero confidence ([raw depth](https://developers.google.com/ar/develop/java/depth/raw-depth)).
- **Scene Semantics** is outdoor only: indoor use is "currently unsupported and may yield unreliable results", and its labels are things like sky, building and road ([SemanticMode](https://developers.google.com/ar/reference/java/com/google/ar/core/Config.SemanticMode), [guide](https://developers.google.com/ar/develop/scene-semantics)). Not useful for rooms.
- **Recording and Playback** saves a session as an MP4 with the camera, motion sensors and API events, to replay later during development, including on other phones ([docs](https://developers.google.com/ar/develop/recording-and-playback)). It's very useful for regression-testing wall detection.

## 2. Which phones support what

- **[Fact]** Google's device list says "As of May 2026, over 88% of active devices support the Depth API". It doesn't say whether that means all active Android devices or active ARCore devices; probably the latter ([devices](https://developers.google.com/ar/devices)).
- **[Fact]** There is no current official count of ARCore phones. The last figures were 1.4 billion compatible devices after Google I/O 2023 ([AR Insider](https://arinsider.co/2023/06/05/data-dive-arcore-gains-ground/)) and over a billion installs of Google Play Services for AR in 2020 ([Android Police](https://www.androidpolice.com/2020/12/15/googles-arcore-library-is-now-installed-on-1-billion-devices/?amp)). **[Inference]** That's most recent mid-range and better phones, but well under half of all Android phones.
- **[Fact]** The Galaxy S24, S24+, S24 Ultra and S24 FE support the Depth API. None is listed with a time-of-flight depth sensor, and nor are the S23 Ultra, S25 Ultra or Pixel 10. Only older models such as the S10 5G, Note10+ and S20 Ultra have one ([devices](https://developers.google.com/ar/devices)). The S24 Ultra's laser autofocus module is sometimes called a ToF sensor in the press ([samsungmagazine.eu](https://samsungmagazine.eu/2024/02/01/galaxy-s24-ultra-se-chlubi-vylepsenou-senzorovou-technologii-tof-jak-se-to-projevuje-na-fotografiich/)). **[Inference]** It's an autofocus aid, not a depth camera ARCore uses.
- **[Unverified]** Cheaper Samsung models, as read from the device list: the A15 5G, A16 5G, A26 5G, A35, A36, A55 and A56 support depth. The A14 5G and A25 5G are listed without it. The A05 and A06 aren't listed at all. Check these in the Play Console device catalog.

### Where the S24 Ultra flatters the app

| Factor | S24 Ultra | Typical mid- or low-end phone | Risk of testing only on the S24 Ultra |
| --- | --- | --- | --- |
| ARCore certified | Yes | The cheapest phones often aren't | The "no ARCore" path never gets exercised |
| Depth API | Yes | About 12% of active devices lack it | Features that need depth quietly go missing |
| Time-of-flight for ARCore | No | No | None: this part is representative |
| Processor | Snapdragon 8 Gen 3 | Two to five times slower **[Inference]** | Depth plus wall fitting plus ML may stutter, and tracking may drop frames |
| Camera in low light | Excellent | Noisier, often without stabilisation **[Inference]** | Fewer visual features, so even fewer wall planes and more drift |
| On-device ML | Depth Anything V2 in about 62 ms on its NPU ([Qualcomm AI Hub](https://aihub.qualcomm.com/jobs/jgje2m715)) | Many MediaTek and Exynos phones fall back to CPU or GPU **[Inference]** | ML that feels real-time on the S24 Ultra may be unusable elsewhere |

**Mitigations [Inference]:**

- Buy one cheap ARCore-certified phone without the Depth API, and one mid-range MediaTek phone.
- Add debug switches that force "no depth" and a low-resolution camera.
- Record sessions and replay them on each phone.

## 3. Ways to get walls, doors and windows

### Guided capture

The user aims at each corner where the floor meets the walls, hit-testing against the floor plane, and closes the outline.

- **Ceiling height:** they aim at the ceiling line, or type it in.
- **Doors and windows:** they tap each side edge on the wall, then the sill and head heights.

This is how magicplan works on Android. Its help pages say "At this time, Android devices are not supported for magicplan's scan features": Android users define corners, square a room or draw instead ([magicplan help](https://help.magicplan.app/scan-a-room-with-the-camera-of-your-mobile-device-android)). Door and window detection is iPhone-only, and it recommends a Bluetooth laser for exact numbers ([accuracy](https://help.magicplan.app/how-accurate-is-magicplan)). A major vendor pulling camera scanning back on Android shows how hard automating it is.

**Accuracy.** **[Unverified]** No peer-reviewed study of ARCore room dimensions was found. The nearest data points are:

- ARKit point measurement averaged under ±2.5 cm of error at 1–3 m at the centre of the image, with much larger errors towards the edges ([IEEE OJEMB 2024](https://doi.org/10.1109/ojemb.2024.3358562)).
- ARCore content drifted 4.8 cm after walking away and back ([arXiv 2109.14757](https://arxiv.org/pdf/2109.14757)).

**[Inference]** Expect roughly ±2–5 cm per wall in good light, with errors adding up around the room. Closing the loop, so the last corner returns to the first, gives an error that can be shown to the user.

It works on any ARCore-certified phone, with no depth needed.

### Automatic walls from depth

**How it works:**

1. Gather raw-depth points above a confidence threshold, together with ARCore's feature points, in world coordinates.
2. Fit vertical planes with RANSAC. Gravity is known, so the planes can be constrained to stand upright.
3. Turn the planes into lines on the plan, intersect them for corners, and square them up where the room is rectangular.

ARCore's own vertical planes can seed the fit.

**Doors and windows [Inference].** Open doors and glass show up as gaps in the wall, with depth readings behind the plane or none at all. Closed doors and windows sit flush with the wall, so they need image cues, such as an ML detector or frame edges, projected onto the fitted wall.

**Limits:**

- Raw-depth confidence is near zero on blank walls, and depth is best from 0.5 to 5 m ([raw depth](https://developers.google.com/ar/develop/java/depth/raw-depth), [depth](https://developers.google.com/ar/develop/depth)).
- One indoor comparison found ARCore depth's average error against LiDAR was about 23–30 cm per pixel ([arXiv 2204.01693](https://arxiv.org/pdf/2204.01693)).
- **[Inference]** Fitting a plane averages out per-pixel noise, but white walls and glass leave holes. Use it to suggest and refine walls, and keep the user confirming them.

It needs a phone with the Depth API and spare processing power.

### On-device ML

- **Filling in depth.** Depth Anything V2 runs in about 47 ms on an S25, 62 ms on an S24 and 84 ms on an S23 ([S25](https://aihub.qualcomm.com/jobs/jpr20wve5), [S24](https://aihub.qualcomm.com/jobs/jgje2m715)). Its depth is relative, so ARCore's measured points would have to give it scale.
- **Detecting doors, windows and furniture.**
  - Datasets: HomeObjects-3K has about 3,000 images in 12 classes, including door, window, sofa and chair ([docs](https://dagshub.com/Ultralytics/ultralytics/src/opts-args/docs/en/datasets/detect/homeobjects-3k.md)). DoorDetect is doors only, at about 45% mAP ([GitHub](https://github.com/MiguelARD/DoorDetect-Dataset)).
  - Windows are harder: one paper reports 77.4% accuracy for doors against 38.1% for windows ([Applied Sciences 2022](https://doaj.org/article/a5079d205cd34607adb9b4060eb78903)).
  - **Licensing trap:** Ultralytics YOLO is AGPL-3.0, with a paid licence for closed-source products ([licence](https://ultralytics.com/license)).
- **Layout from point clouds.** SpatialLM (NeurIPS 2025) turns point clouds, including ones from phone video, into walls, doors, windows and furniture boxes ([GitHub](https://github.com/manycore-research/SpatialLM), [paper](https://arxiv.org/abs/2506.07491v2)). **[Inference]** At 0.5–1 billion parameters it belongs on a server, as an optional "upload a scan, get a layout" step.

### Third-party SDKs and open source

- **[Unverified]** No licensable Android SDK that outputs walls and openings like RoomPlan was found. magicplan, CubiCasa and Locometric are apps; CubiCasa mentions an export API, but its developer pages couldn't be reached.
- **[Fact]** Niantic's ARDK is Unity-based and frozen, with fixes until 28 February 2027 ([Niantic docs](https://www.nianticspatial.com/docs/nsdk/3.17.0/)). It's a poor fit for React Native.
- Worth reading for reference, though not reusable as they are: [RoomMapperAR](https://bitbucket.org/ottsaar/room-mapper-ar/wiki/Home) (Unity and ARCore, with semi-automatic door and window detection) and [AR-Measure-App](https://github.com/mmd-nemati/AR-Measure-App) (ARCore reticle measuring).

### Comparison

| Approach | Phones | Walls | Doors and windows | Accuracy | Effort | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Guided capture | All ARCore-certified | User taps | User taps | About ±2–5 cm per wall **[Inference]** | Low to medium | **Build first** |
| Depth and RANSAC | Depth API (about 88% of active devices) | Suggested; fails on plain walls | Only open doors and glass | Centimetres where walls have texture **[Inference]** | Medium to high | Second stage |
| On-device ML | Better with an NPU, slow on cheap phones | Indirectly | Detector boxes projected onto walls | Weak on windows | High; watch licences | Third stage, flagships first |
| Server-side SpatialLM | Any, by upload | Yes | Yes | Not measured on ARCore data | High (a server) | Optional, later |
| Third-party SDK | — | None found | None found | — | — | Not available |

## 4. Building it into the Expo app

**Recommended: an Expo module in Kotlin on ARCore.** It follows the [native view tutorial](https://docs.expo.dev/modules/native-view-tutorial/): an `ExpoView` hosting a `GLSurfaceView`, with props in and events out, and pausing and resuming the ARCore session with the activity. Keep the geometry in Kotlin and send JavaScript the finished [room scan](../packages/scan-import/README.md), plus a light preview of progress. **[Inference]** This gives full access to raw depth, confidence, camera settings and recording.

**Alternative for prototyping: `@reactvision/react-viro`.**

- Version 3.0.3 (7 October 2026) targets Expo 57 and React Native 0.86, requires the New Architecture, and is MIT-licensed, maintained by a full-time team ([GitHub](https://github.com/ReactVision/viro)).
- Its plane anchors carry their alignment and outline, and its hit results carry depth with confidence.
- **[Inference]** Access to raw point clouds for custom plane fitting is limited, so native code may still be needed.

**Not yet: SceneView's React Native binding.** SceneView (Apache-2.0, Filament and ARCore) is stable as an Android library at 4.55.0, but `@sceneview-sdk/react-native` is alpha and covers a subset ([GitHub](https://github.com/SceneView/sceneview)). It could serve as a Kotlin rendering dependency inside our own module.

### Manifest and config plugin

From [Enable ARCore](https://developers.google.com/ar/develop/java/enable-arcore):

- The app needs the `CAMERA` permission.
- Declare ARCore as optional with `<meta-data android:name="com.google.ar.core" android:value="optional"/>`, so the app still installs on phones without ARCore, which can fall back to entering measurements. Declaring it required hides the app from those phones.
- AR needs `minSdk` 24.
- Call `ArCoreApk.checkAvailability()` early and `requestInstall()` before creating a session, and handle the user declining the install.

Two more things to watch:

- **[Fact]** ARCore 1.56 pushes `targetSdkVersion` 37 through manifest merging unless the app sets its own ([releases](https://github.com/google-ar/arcore-android-sdk/releases)). **[Inference]** Pin it with `expo-build-properties` to what Expo 57 expects.
- **[Fact]** Native modules need a development build ([Expo docs](https://docs.expo.dev/develop/development-builds/introduction/)), and Expo 57's prebuild regenerates `android/` by default ([digest](https://releases.sh/release/rel_aH7NaXbDXMlY2_I-Ak0D0)). Every manifest and Gradle change belongs in a config plugin, never in hand edits.

## 5. Plan

1. **Plumbing.** An Expo module with an ARCore session, ARCore declared optional, the availability and install flow, camera permission, and a fallback for phones without ARCore. It writes the shared room scan format, so the iPhone and Android scanners meet in one place.
2. **Guided capture, on every ARCore phone. Ship this first.**
   - The floor plane, then corner taps for the outline, with optional squaring of right angles and the loop-closure error shown.
   - Ceiling height, by aiming at the ceiling line or typing it in.
   - Doors and windows: tap their edges on a wall, then their sill and head heights.
   - Optionally, furniture: two floor corners, a height and a label.

   It's the only approach that works without depth on every certified phone, gives predictable results to a few centimetres, and is what the market leader ships on Android today.
3. **Depth assist, where the Depth API is supported.**
   - Raw depth above a confidence threshold, with RANSAC wall planes, to suggest walls and snap the user's taps to them.
   - Gaps in a wall to suggest open doors and windows.
   - Keep the user confirming, and turn it off on phones that can't keep up.
4. **ML, on capable phones or on a server.** A door, window and furniture detector projected onto fitted walls, using a model without AGPL terms or with a licence. Optionally, SpatialLM on a server for fully automatic layouts.

**Testing.** Add a cheap ARCore phone without depth. Add switches that force no depth and low resolution. Record sessions and replay them as regression tests. Track tracking loss and loop-closure error per phone model.

## Still to confirm

- An official count of ARCore devices, and what "active devices" means in Google's 88% figure.
- Whether Jetpack XR's wall and floor labels work on phones.
- Terms for CubiCasa's or Locometric's SDKs or APIs.
- A peer-reviewed accuracy figure for measuring rooms with ARCore.
- The Depth API status of the A14 5G and A25 5G, in the Play Console device catalog.
