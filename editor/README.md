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
