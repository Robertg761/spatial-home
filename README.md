# Spatial Home

**An interactive digital twin that gives smart homes—and eventually robots—an understanding of physical space.**

## Vision

Smart-home platforms know *which* devices exist and *what* they do, but often lack a useful model of *where* those devices are and *how* the home fits together. Spatial Home aims to close that gap: turn a real home into a navigable 3D environment with a structured spatial model that people, automations, and AI agents can understand.

The goal is to make the home more than a collection of devices: a context-aware environment that can explain, recommend, and—with permission—act.

## The experience

1. **Capture your home in minutes.** Scan rooms with an Android phone or an iPhone, or draw and edit a floor plan by hand. On Android, scanning uses ARCore depth, which works on many phones that have no dedicated depth sensor. On iPhones and iPads with LiDAR, it uses Apple RoomPlan. Both produce the same home model and open in the same editor. Android has no built-in equivalent of RoomPlan's automatic wall, door and furniture labelling, so an Android scan will need more correction in the editor at first. The ambition is a useful first model in roughly three minutes for a suitable room, not a guaranteed whole-house scan.
2. **Make it recognizable.** Automatically generate a clean 3D layout, with optional AI-assisted visual enhancements. Verified measurements and spatial relationships remain separate from generated appearance.
3. **Connect your devices.** Discover appliances and sensors through Home Assistant, suggest their locations, and let the user confirm or correct matches in a few taps.
4. **Interact naturally.** Explore the home, view device information, control supported appliances, and ask questions that require an understanding of physical space.

## What spatial intelligence enables

- **Better automations:** Light the route from a bedroom to a bathroom at night, rather than switching on an entire floor.
- **Environmental awareness:** Use window orientation, sun position, weather, and sensor readings to recommend blind settings or a better location for a plant.
- **Contextual assistance:** Identify the lamp closest to a reading chair, explain sensor blind spots, or suggest improvements from recurring household patterns.
- **Future robotics:** As physical AI matures, share the home's spatial model with compatible robots for task planning and navigation context. Robots will still need their own localization, sensing, obstacle avoidance, and safety systems.

## How it works

Spatial Home is **not a replacement for Home Assistant**. Home Assistant remains responsible for device connectivity, live state, and authorized control. Spatial Home adds:

- A **portable, versioned home model** describing rooms, floors, doors, windows, fixtures, device positions, orientations, and relationships.
- **Phone scanning on Android and iOS** that turns a room scan into a draft floor plan.
- A **2D/3D editor** for creating, reviewing, and correcting that model.
- A **spatial reasoning service** that calculates distances, room connectivity, routes, sunlight exposure, and sensor coverage.
- **APIs and MCP tools** that let AI agents ask spatial questions and combine the answers with Home Assistant's existing capabilities.

The model is designed to be useful even without AI and, over time, interoperable with multiple interfaces and robotic systems.

## Development direction

**First:** Deliver a reliable floor-plan editor, simple 3D model, Home Assistant entity placement, and a working spatial-query demonstration.

**Next:** Streamline phone-scan import on both Android and iOS, device matching, live visualization, and optional higher-fidelity rendering.

**Later:** Add proactive, explainable AI recommendations, more advanced automations, and carefully permissioned integrations with physical robots.

## Principles

**Local-first and privacy-conscious.** Home geometry, occupancy, and device data are sensitive. Cloud AI processing should be optional and explicit. **Android and iPhone alike.** Every feature should work on Android as well as on iPhone. Where one platform can't do something on its own, such as automatic room labelling, the app fills the gap rather than dropping the feature. **User-controlled and safe.** Recommendations should explain their reasoning; impactful actions require appropriate authorization. **Open and interoperable.** The spatial model should outlive any particular visualization, AI provider, or device ecosystem.

*Spatial Home is a proposed product direction; the capabilities above describe its goals, not an already completed application.*

## Repository layout

One TypeScript monorepo using npm workspaces. Apps are what people run; packages are code the apps share, so the web editor and the phone apps never carry two copies of the same logic.

| Path | What it is | Built with |
| --- | --- | --- |
| [`apps/editor`](apps/editor) | Web editor: draw the floor plan, see it in 3D, place Home Assistant devices | React, Vite |
| [`apps/mobile`](apps/mobile) | iOS and Android app: scan rooms into the same home model | React Native, Expo |
| [`packages/ha-client`](packages/ha-client) | Connection to Home Assistant: live states, registries, service calls | TypeScript, no dependencies |
| [`packages/home-model`](packages/home-model) | The `home-layout.json` format every app reads and writes, with validation and plan geometry | TypeScript, Zod |
| [`scripts`](scripts) | Developer tools, such as `ha-check` | Node |

Planned, and added when their phase starts:

- `apps/server`: the spatial reasoning service and MCP server for AI agents.

Shared packages ship TypeScript source rather than build output. Vite, Metro (the bundler behind Expo) and Node 22.18+ all run it directly, so a change in a package shows up in the apps immediately. The editor and the phone app use the same React version, so the workspace holds one copy of React.

## Development

Requires Node 22.18 or later.

```sh
npm install
npm run editor       # web editor at http://localhost:5173
npm run mobile       # Expo dev server; open the app with Expo Go or a development build
npm test             # unit tests
npm run typecheck    # every workspace
npm run ha:check     # connect to your own Home Assistant (see .env.example)
```

In `apps/mobile`, add dependencies with `npx expo install <package>` rather than `npm install`, so they match the Expo SDK.

## License

Licensed under the [Apache License 2.0](LICENSE).
