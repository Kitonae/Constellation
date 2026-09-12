# Constellation

This repository currently contains the desktop editor stack and the public website.

## Repo layout

- `editor/ui/` - React + Vite editor frontend
- `editor/wails/` - Go/Wails desktop shell, local sidecar server, and renderer bridge
- `editor/renderer/` - native renderer: Direct3D 12 on Windows, Metal on macOS
- `website/` - marketing and downloads site

## Editor workflow

Frontend UI:

```powershell
cd editor/ui
npm ci
npm run dev
```

Wails shell:

```powershell
cd editor/wails
go mod download
task dev
```

Native renderer (Windows):

```powershell
cd editor/renderer
cmake -S . -B build -A x64
cmake --build build --config Release
```

Native renderer (macOS, Xcode command line tools and CMake):

```sh
cd editor/renderer
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
ctest --test-dir build
```

The NDI SDK for Apple is picked up from `/Library/NDI SDK for Apple` when
installed; set `NDI_SDK_DIR` to use another location. Add
`-DRENDERER_UNIVERSAL=ON` for an arm64 + x86_64 binary.

## Production build

```powershell
cd editor/wails
task package
```

The renderer binary is built separately from `editor/renderer`. On macOS
`task package` stages it, with `libndi.dylib`, into the app bundle next to the
editor binary when `editor/renderer/build/constellation-renderer` exists.

## Repo hygiene

- `editor/wails/frontend/dist/.keep` is intentionally tracked so clean Go/Wails builds always have an embeddable frontend directory.
- Generated caches and reports such as `.vite/`, `playwright-report/`, and `test-results/` are ignored.
- Local tool settings such as `.claude/settings.local.json` are treated as machine-local and are ignored.
