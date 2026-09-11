# Editor

The active desktop editor stack lives here.

What is in this directory:
- `ui/` - React + Vite editor frontend
- `wails/` - Go/Wails desktop shell, local sidecar server, and renderer process manager
- `renderer/` - native Windows DX12 renderer used for output windows and native playback

Development workflow:
1. `cd editor/ui && npm ci`
2. `cd editor/wails && wails dev`
3. If you are working on native output, build the renderer separately:
   - `cmake -S ../renderer -B ../renderer/build -A x64`
   - `cmake --build ../renderer/build --config Release`

Production shell build:
1. `cd editor/ui && npm run build`
2. `cd editor/wails && .\copy-frontend.ps1`
3. `wails build`

Notes:
- `editor/wails/frontend/dist/.keep` is a tracked placeholder so clean checkouts compile before a real frontend build is copied in.
- The renderer binary is not built by `wails build`; build it from `editor/renderer` when needed.
- This directory is organized around the current React + Wails + DX12 workflow.

Tests
- `npm run test:unit` in `editor/ui` — store, undo, snapping, geometry and design-token tests.
- `npm test` in `editor/ui` — Playwright UI tests (starts its own dev server on 5174).
- `go test ./...` in `editor/wails`.

## Layout

Menu bar across the top, then Media Bin | viewport | Inspector, the timeline
along the bottom, and a status bar. Every divider can be dragged, and
double-clicking one collapses that panel to a rail; sizes are remembered
between sessions. The View menu also toggles each panel.

The status bar shows the last message, the current selection, the open
document with a dot when it has unsaved changes, how many outputs are open
(red if any failed), and the shortcuts that apply to what is selected.

## Keyboard

Help > Keyboard Shortcuts lists everything; the same table drives the key
handler and the accelerators shown in the menus. The essentials:

| Key | Action |
| --- | --- |
| Space | Play / pause |
| Home / End | Go to start / end of content |
| `,` `.` | Step the playhead (Shift for 1s) |
| ← → | Nudge selected clips (Shift for 1s) |
| S | Split the selected clip at the playhead |
| Ctrl+D | Duplicate selected clips |
| Del | Delete the selection |
| Ctrl+A | Select all clips |
| F / Shift+F | Frame all / frame selected |
| Ctrl+0 | Zoom the stage to 100% |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| ` | Toggle the console |
| ? or F1 | Keyboard shortcuts |

Hold Alt while dragging to suspend snapping.

## Working with media

Drop files anywhere in the window, or use Add New in the Media Bin. The bin
supports search, sorting, kind filters, rename (F2 or double-click), and
Relink for a file that has moved — relinking keeps the asset id, so every
timeline clip using it is repaired at once. A missing file is marked in red
and is distinct from a thumbnail that merely failed to render.

Drag an asset onto the timeline (a ghost shows where it will land and how
long it is) or onto the stage.

## Timeline

Drag clips to move them, including several at once and across tracks. Grab a
clip's left or right edge to trim it. Dragging, trimming and dropping snap to
the playhead, to time zero and to other clips' edges, with a guide line
showing what caught. Click a clip to select, Ctrl-click to add, Shift-click
for a range within a track. Right-click a clip for delete, duplicate, split
at playhead and select-all-in-track; right-click a track header to rename or
remove it. Zoom with the buttons, Ctrl+wheel or Zoom to Fit; the zoom stays
anchored on the playhead or the cursor. Drag empty track area to scrub.

## Stage (2D)

Screens and clips are dragged directly. Hold Shift to work with screens only
(clips dim and stop taking clicks). The selected clip gets eight resize
handles; corners keep the aspect ratio unless Shift is held. Marquee-select
replaces by default, Shift adds, Alt subtracts. Pan with the hand tool,
middle mouse or Ctrl+Alt. The zoom readout is a real percentage of media
pixels to screen pixels.

Right-click the stage to add a web or renderer screen.

## Outputs

Each enabled screen opens an output: a browser window for a web screen, a
native renderer process for a renderer screen. The Displays menu opens,
closes and re-opens them all. A renderer's state, frame rate and error text
appear in the Inspector when its screen is selected, with a Relaunch button;
the status bar summarises all outputs. A display window blocked by the
pop-up blocker is reported rather than failing silently.

## Styling

All colours, radii, shadows and stacking levels are CSS variables declared in
`ui/src/styles.css`. `ui/src/theme.js` mirrors them for the few places that
need a token from JavaScript, and two tests keep the two in sync and stop
hex literals reappearing in components. Three.js materials, canvas painting
and the display window are exempt.

Next
- Map cameras from the scene to bookmarks; add a camera dropdown.
- A real Displays panel (the Output view is still a placeholder).
- A scene outliner, so screens can be found without clicking them on the stage.
