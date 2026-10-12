# Spatial Home Model for Smart Home Agents

Oct 11, 2026 · @Robert

Build a tool that maps a home in 3D, pins each Home Assistant device to its real spot, and gives AI agents spatial answers so they can run the home with an understanding of its layout.

## The idea

Today a smart home agent knows that a light is in the "Living room" and nothing more. It can't tell which room leads to which, which windows face the afternoon sun, or whether the motion sensor can see the couch.

The 3D model itself isn't what helps the agent, because an LLM can't do much with a mesh. What helps are the facts we can work out from the model and hand to the agent as short, plain answers:

- "The hallway joins the bedroom to the bathroom, so at 2am light that route at 10%."
- "The living room's west windows get sun from about 3pm, so close those blinds when it's hot."
- "The motion sensor covers the couch but not the desk, so don't use it to detect someone working."
- "The reading lamp is 1.2 m from the armchair."

Home Assistant already groups devices into floors and areas, but it has no positions within a room and no idea how rooms connect. That gap is what this project fills.

## How it fits together

&#91;embedded content: how the parts fit together\]

We build the editor, the model and the spatial server. Home Assistant stays the source of truth for devices and keeps handling control.

## What the model holds

The home is stored as one JSON file of labelled things, not as a raw mesh. Each item links back to Home Assistant where one exists.

| Item | What we store | Links to in Home Assistant |
| --- | --- | --- |
| Room | Floor outline, which floor, ceiling height | Area |
| Opening | Door or window, which two rooms it joins (or outside), compass direction | — |
| Fixture | Bed, couch, desk, TV: the things people refer to | — |
| Device | Position, which way it faces, what it covers (motion cone, camera view, light reach) | Entity ID |

From these we work out the useful facts: which rooms connect, the route between any two rooms, how much sun each window gets at a given time, gaps in sensor coverage, and which lights reach which fixtures.

## What the agent can ask

The agent gets a small set of tools through an MCP server, plus a one-paragraph text summary of the home. It never sees the raw geometry. Home Assistant's own MCP server keeps handling device control, and this one handles layout.

| Tool | Answers | Example automation |
| --- | --- | --- |
| `describe_room` | What's in a room, its doors, windows and devices | "Set up the office for a call" picks the right lights and blinds |
| `path_between` | The rooms you pass through from A to B | Night route lighting from bedroom to bathroom |
| `devices_near` | Devices close to a fixture or point | "Reading light on" turns on the lamp by the armchair, not the ceiling light |
| `windows_facing_sun` | Which windows get direct sun right now | Close the west blinds on hot afternoons |
| `coverage_of` | Which sensors can see a room or fixture | Presence logic that knows the desk is a blind spot |

## First version

The first version is a standalone web app that connects to Home Assistant. It's quicker to change than a full integration and works on any device.

**In:**

- Draw rooms on a 2D floor plan, which the app turns into a 3D model
- Place doors and windows
- Pull the device list from Home Assistant and drop each device into place
- Save everything as `home-layout.json`
- An MCP server that answers the five questions above

**Out, for now:**

- Scanning with a phone (LiDAR)
- Photo-realistic 3D or photo scans
- Running inside Home Assistant as an integration
- Live device states shown on the 3D model

## Phases

Each phase works on its own before the next one starts.

1. **Editor.** Draw rooms, doors and windows, and see the home in 3D.
2. **Devices.** Connect to Home Assistant, place devices, and link rooms to areas.
3. **Agent tools.** Build the MCP server and test it on real requests, such as night lighting and sun-aware blinds.
4. **Scanning.** Import iPhone LiDAR scans (Apple RoomPlan), which arrive with walls, doors, windows and furniture already labelled.
5. **Home Assistant integration.** Package it as an integration with its own sidebar panel, so the layout lives inside Home Assistant.

## Open questions

- How precise do positions need to be? Room-level accuracy may be enough for most automations.
- How do we handle homes with several floors and stairs in the route-finding?
