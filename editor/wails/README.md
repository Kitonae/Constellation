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
- `Taskfile.yml` / `build/Taskfile.yml` - the Wails v3 build pipeline
- `build/config.yml` - app metadata and `wails3 dev` configuration
- `frontend/dist/.keep` - tracked placeholder so clean checkouts compile

## Prerequisites

- Go 1.25+
- Node.js + npm
- Wails CLI v3: `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.20`
- Task: `go install github.com/go-task/task/v3/cmd/task@latest`

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
task dev
```

`task dev` starts the Vite dev server from `editor/ui` on port 5173 and launches
the desktop shell, rebuilding the Go side when it changes.

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
cd editor/wails
task package
```

`task build` (and `task package`, which builds with `PRODUCTION=true`) runs the
whole chain: regenerate bindings, `npm run build` in `editor/ui`, copy the output
into `editor/wails/frontend/dist`, then compile. The copy step exists because
Go's `//go:embed` cannot reference files outside the package directory, and the
Vite project deliberately lives outside this Go module.

The binary lands in `editor/wails/bin/constellation-editor.exe`.

## Notes

- The active control path is the built-in Wails bindings plus the local sidecar/SSE flow.
- Frontend bindings are generated into `editor/ui/bindings/` and imported through
  the `@bindings` Vite alias. Regenerate them with `task common:generate:bindings`
  after changing any bound method on the `App` service.
- Generated caches and local tooling files such as `.vite/` and `.claude/settings.local.json` are intentionally ignored.
- Run `go test ./...` from `editor/wails` to validate the Go sidecar code.
