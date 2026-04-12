# Constellation Editor Wails Shell

This directory contains the desktop shell for the editor.

Responsibilities:
- boot the Wails desktop app
- expose Wails bindings consumed by `editor/ui`
- run the local sidecar HTTP/SSE server used by the native renderer
- launch and stop native renderer processes
- embed the built frontend for production builds

## Directory map

- `main.go` - Wails entry point and application bindings
- `renderer.go` - native renderer process discovery and lifecycle
- `sse.go` - renderer event fanout over SSE
- `routes.go` - sidecar HTTP routing and status endpoint
- `fileloader.go` / `fileutil.go` - local file serving helpers
- `build.ps1` - build the Wails shell and copy frontend assets
- `copy-frontend.ps1` - copy `editor/ui/dist` into `frontend/dist`
- `frontend/dist/.keep` - tracked placeholder so clean checkouts compile

## Prerequisites

- Go 1.22+
- Node.js + npm
- Wails CLI v2: `go install github.com/wailsapp/wails/v2/cmd/wails@latest`

## Development

Install dependencies:

```powershell
cd editor/ui
npm ci

cd ../wails
go mod download
```

Run the desktop shell in development mode:

```powershell
cd editor/wails
wails dev
```

`wails dev` starts the UI dev server from `editor/ui` and launches the desktop shell.

## Native Renderer

The DX12 renderer lives in `editor/renderer` and is built separately:

```powershell
cd editor/renderer
cmake -S . -B build -A x64
cmake --build build --config Release
```

The Wails shell discovers the renderer executable from common dev and production paths.

## Production Build

```powershell
cd editor/ui
npm run build

cd ../wails
.\copy-frontend.ps1
wails build
```

The frontend build is copied into `editor/wails/frontend/dist` before `wails build` so the Go binary can embed it.

## Notes

- The active control path is the built-in Wails bindings plus the local sidecar/SSE flow.
- Generated caches and local tooling files such as `.vite/` and `.claude/settings.local.json` are intentionally ignored.
- Run `go test ./...` from `editor/wails` to validate the Go sidecar code.
