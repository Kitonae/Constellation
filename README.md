# Constellation

This repository currently contains the desktop editor stack and the public website.

## Repo layout

- `editor/ui/` - React + Vite editor frontend
- `editor/wails/` - Go/Wails desktop shell, local sidecar server, and renderer bridge
- `editor/renderer/` - native Windows DX12 renderer
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

Native renderer:

```powershell
cd editor/renderer
cmake -S . -B build -A x64
cmake --build build --config Release
```

## Production build

```powershell
cd editor/wails
task package
```

The renderer binary is built separately from `editor/renderer`.

## Repo hygiene

- `editor/wails/frontend/dist/.keep` is intentionally tracked so clean Go/Wails builds always have an embeddable frontend directory.
- Generated caches and reports such as `.vite/`, `playwright-report/`, and `test-results/` are ignored.
- Local tool settings such as `.claude/settings.local.json` are treated as machine-local and are ignored.
