Editor UI (Tauri + React)

What’s here
- ui/: Vite + React app with react-three-fiber viewport, simple timeline slider, and inspector placeholder.
- tauri/: Tauri shell configured to serve the Vite dev server in dev and bundle the built UI in prod.

Run (Dev)
Option A (one command):
- From repo root: `bash scripts/run-editor.sh`
  - Optional: set `PORT=xxxx` to match a custom Vite port.

Option B (manual):
1) In `editor/ui`: `npm install` then `npm run dev` (port 5173).
2) In `editor/tauri`: `cargo run` (dev shell opens and points to the dev server).

Build
- UI: `npm run build` in `editor/ui`.
- Tauri: `cargo build --release` in `editor/tauri` (bundles UI from `../ui/dist`).

Usage
- Click the file picker in the header and select `examples/scene.example.json` from the repo root.
- The viewport shows a ground grid, any screens as planes, and basic lights. Click a screen to select it.
- Use Move/Rotate/Scale to manipulate the selected node via gizmos. Inspector edits position/scale/quaternion numerically.
- Timeline slider scrubs local time; Play/Pause toggles a simple local clock.
- Console: Toggle the in-app console via the "Console" button to see import/apply logs and errors. Use "Clear" to reset.
- Console: Press the tilde/backtick key (`~` / backquote) to toggle a top drop-down console drawer. It is scrollable and shows import/apply logs and errors. Use "Clear" to reset.
- Enter Display address (e.g., `http://127.0.0.1:50051`) and click "Apply to Display" to send the current project to the Display server. Use Play/Pause/Stop to control transport remotely.
- Add content: click "Add Image" to choose an image file (via Tauri dialog). The image is added to the project's media list and a timeline track is inserted targeting the first screen (or the currently selected screen), starting at the current time with a default 10s duration.
 - Media Bin: Use the Media Bin panel to import images into the project’s media library without placing them yet. Each media row has an "Insert at <time>" button to drop it onto the timeline at the current playhead.
 - Timeline Tracks: The timeline now visualizes media tracks as bars positioned by start time and duration, with a playhead indicator.

Next
- Selection + gizmos; outline hovered/selected nodes.
- Map cameras from scene to bookmarks; add camera dropdown.
- Wire to Display server via gRPC-web or a local bridge for live preview/apply.
