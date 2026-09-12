# Wails Quick Start

## First time setup

```powershell
go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.20
go install github.com/go-task/task/v3/cmd/task@latest

cd editor/ui
npm ci

cd ../wails
go mod download
```

## Run the editor shell

```powershell
cd editor/wails
task dev
```

This starts the React dev server from `editor/ui` and launches the Wails desktop shell.

## Build the native renderer (optional, but required for native output work)

Windows:

```powershell
cd editor/renderer
cmake -S . -B build -A x64
cmake --build build --config Release
```

macOS:

```sh
cd editor/renderer
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

## Production Wails build

```powershell
cd editor/wails
task package
```

Output:
- Wails shell: `editor\wails\bin\constellation-editor.exe` (Windows) or
  `editor/wails/bin/constellation-editor.app` (macOS)
- Renderer (built separately): `editor\renderer\build\Release\constellation-renderer.exe`
  or `editor/renderer/build/constellation-renderer`

## Common issues

### `wails3` or `task` not found
- Install them with `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.20`
  and `go install github.com/go-task/task/v3/cmd/task@latest`
- Make sure your Go bin directory is on `PATH`

### Frontend assets missing in a production build
- Run `task build`, which builds the UI and stages it into `frontend/dist`

### Renderer not launching
- Build the renderer from `editor/renderer`
- Confirm the executable exists in `editor\renderer\build\Release\constellation-renderer.exe`
  (Windows) or `editor/renderer/build/constellation-renderer` (macOS)
- Renderer logs are written to `%TEMP%` / `$TMPDIR` as `constellation-renderer-<screen>.log`

### Go tests fail on a clean checkout because no embedded frontend exists
- The repo keeps `frontend/dist/.keep` tracked for compile-time embedding
- Run `task build` for fresh embedded assets
