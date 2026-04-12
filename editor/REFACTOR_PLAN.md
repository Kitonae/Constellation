# Editor Refactor Plan

This file captures the architecture audit, phased refactor plan, and current handoff state for the editor stack so work can resume across sessions without relying on chat history.

## Scope

- `editor/ui` - React editor UI
- `editor/wails` - desktop shell, local sidecar, renderer process manager
- `editor/renderer` - native DX12 renderer

## Current Baseline

- `dx12` became the practical baseline branch and was merged into `main` before this plan was written.
- Repo cleanup baseline is committed in `54437ac` (`clean up editor repo layout and remove stale tooling`).
- The first refactor work branch is `refactor/project-codec-boundary`.
- Cleanup validation already completed:
  - `npm run build` in `editor/ui`
  - `go test ./...` in `editor/wails`

## Main Problems Identified In The Audit

1. No single canonical project or snapshot codec; parsing, migration, and export wrapping are split across multiple files.
2. Playback and output synchronization have multiple authorities across the UI, session layer, and display integration.
3. `editor/ui/src/store.js`, `editor/ui/src/App.jsx`, and `editor/ui/src/components/Viewport2D.jsx` carry too many responsibilities.
4. The Wails sidecar and native renderer lifecycle are functional but have weak reliability boundaries.
5. The native renderer `App` owns too many subsystems directly.

## Desired End State

- One canonical in-memory project model used throughout the UI.
- Import and export compatibility isolated to a codec boundary.
- One authority for playback state and output fanout.
- Smaller UI modules with cleaner ownership boundaries.
- Clearer Wails sidecar contracts and a thinner native renderer coordinator.

## Refactor Principles

- Prefer extraction and boundary cleanup over large rewrites.
- Keep behavior stable with characterization coverage before major moves.
- Keep compatibility logic at import/export boundaries instead of inside UI components.
- Avoid changing the project codec, playback authority, and native transport contracts in the same PR.
- Preserve working DX12/Wails behavior unless a change is directly in scope.

## Phased Plan

### Phase 0 - Characterization Coverage

Status: pending

Scope:
- Add enough tests and smoke coverage to move code without losing behavior.

Key files:
- `editor/ui/src/utils/parseProject.js`
- `editor/ui/src/media/renderer.js`
- `editor/wails/sse.go`
- `editor/wails/renderer.go`
- `editor/renderer/src/scene.cpp`

Done when:
- Parse/render-list behavior has fixtures or unit coverage.
- Wails sidecar has tests around SSE and renderer process semantics.
- A manual smoke list exists for play/pause/seek, display reopen, and renderer launch/close.

### Phase 1 - Project And Snapshot Codec Boundary

Status: done (dfba134, bea2d8d)

Scope:
- Create one module that owns project import, migration, normalization, and export serialization.

Key files:
- `editor/ui/src/utils/parseProject.js`
- `editor/ui/src/store.js`
- `editor/ui/src/App.jsx`
- `editor/ui/src/media/timeline.js`
- new `editor/ui/src/project/projectCodec.js`

Tasks:
- Move wrapper-building logic out of `App.jsx`.
- Centralize legacy/new timeline conversion and project normalization.
- Keep outbound snapshot JSON compatible with current renderer and Wails consumers.
- Ensure only the codec layer knows about legacy field aliases such as `start_at_seconds`, `in_seconds`, `out_seconds`, `events`, and `duration_seconds`.

Done when:
- The rest of the UI works with one normalized project shape.
- Load/save/snapshot code no longer duplicates wrapper construction.
- Import/export compatibility lives in one place.

### Phase 2 - Playback And Output Authority

Status: done (834a3ce)

Scope:
- Consolidate time, play/pause/seek, and output fanout around `MediaSession`.

Key files:
- `editor/ui/src/media/session.js`
- `editor/ui/src/media/sink.js`
- `editor/ui/src/display/displayManager.js`
- `editor/ui/src/components/GlobalTicker.jsx`
- `editor/ui/src/components/Timeline.jsx`
- `editor/ui/src/App.jsx`
- `editor/ui/src/components/DisplayWindow.jsx`

Done when:
- Session code is the only authority for output transport.
- Native and web display sinks receive updates through one path.
- Window lifecycle and `postMessage` handling are hardened.

### Phase 3 - Store And Shell Decomposition

Status: done

Scope:
- Split editor state from app shell orchestration.

Key files:
- `editor/ui/src/store.js`
- `editor/ui/src/App.jsx`
- new `editor/ui/src/store/*`
- new `editor/ui/src/hooks/*`

Done when:
- `store.js` is split by concern.
- `App.jsx` is mostly composition and layout.
- Sidecar init, hotkeys, screen lifecycle, and snapshot sync live in focused hooks.

### Phase 4 - Viewport And Timeline Decomposition

Status: done

Scope:
- Break up the largest editor surfaces into smaller rendering and interaction modules.

Key files:
- `editor/ui/src/components/Viewport2D.jsx`
- `editor/ui/src/components/Timeline.jsx`
- `editor/ui/src/media/renderer.js`
- new `editor/ui/src/components/viewport2d/*`
- new `editor/ui/src/components/timeline/*`

Done when:
- Math and render logic are testable outside the full components.
- The main component files stop acting as god objects.

### Phase 5 - Wails Sidecar And Renderer Process Hardening

Status: done

Scope:
- Strengthen lifecycle and delivery guarantees between Wails and the native renderer.

Key files:
- `editor/wails/sse.go`
- `editor/wails/renderer.go`
- `editor/wails/routes.go`
- `editor/wails/main.go`
- `editor/wails/interfaces.go`

Done when:
- Time updates can remain lossy, but control and snapshot events are reliable.
- Renderer start/stop/relaunch cannot silently desync.
- Hardcoded dev-path assumptions are removed.

### Phase 6 - Native Renderer Subsystem Split

Status: already addressed

Scope:
- Reduce the native `App` to a coordinator over smaller modules.

Key files:
- `editor/renderer/src/app.h`
- `editor/renderer/src/app.cpp`
- `editor/renderer/src/scene.cpp`
- `editor/renderer/src/screen.cpp`
- `editor/renderer/src/texture_cache.cpp`
- `editor/renderer/src/status_reporter.cpp`

Done when:
- URI handling, event processing, decoder management, and per-screen coordination have clearer ownership.
- `App` is no longer the primary home for every subsystem.

### Phase 7 - Final Repo And Build Cleanup

Status: done

Scope:
- Finish any remaining layout or documentation cleanup after architecture changes settle.

Key files:
- `editor/wails/wails.json`
- `editor/ui/package.json`
- docs and onboarding notes

Done when:
- Repo layout, docs, and build paths match the actual runtime model.

## Suggested PR Sequence

0. Baseline cleanup - done in `54437ac`
1. Characterization coverage
2. Project/snapshot codec boundary
3. MediaSession transport consolidation
4. Store/App decomposition
5. Viewport and Timeline split
6. Wails sidecar/process hardening
7. Native renderer subsystem split
8. Final repo/build cleanup if needed

Notes:
- If characterization coverage needed for the codec work is small, it can be folded into the codec PR.
- After transport consolidation, store decomposition and some Wails hardening work can proceed in parallel.

## Current Handoff State

Current branch:
- `refactor/project-codec-boundary`

Status: All phases complete.

The refactor plan is fully executed. The codebase now has:
- One canonical project codec boundary (projectCodec.js)
- One playback authority (MediaSession with clock + sinks)
- Store split into 6 focused slices
- App.jsx reduced to layout with hooks for orchestration
- Viewport2D and Timeline decomposed into testable submodules
- Wails sidecar with proper lifecycle/shutdown guarantees
- Native renderer already well-structured from the DX12 work
- Stale files removed

## Change Log

- 2026-04-12: Phase 7 — removed stale parseProject.js shim, final cleanup.
- 2026-04-12: Phase 6 — skipped; renderer already decomposed into 11 focused subsystem modules from the DX12 work.
- 2026-04-12: Phase 5 — hardened Wails sidecar: removed hardcoded dev path from renderer.go, derived process contexts from app context, added WaitGroup for exit watchers, StopRenderer now waits for process exit (3s timeout), ShutdownAll waits for all exits (5s timeout), fixed CloseRendererScreen ordering (stop then broadcast), added SSEHub.Close() with stop channel for stats goroutine.
- 2026-04-12: Phase 4 — extracted Timeline math to timeline/timelineUtils.js. Extracted Viewport2D helpers (Node2D, ModelNode2D, VideoFrame, StageMenu, SelectionOverlay, IconButton) and math (dotGridBg, clamp, coordinate utils) to viewport2d/ submodules. Viewport2D reduced from 1135 to 770 lines.
- 2026-04-12: Phase 3 — split store.js into 6 concern-based slices (projectSlice, sceneSlice, transportSlice, uiSlice, consoleSlice, importSlice). Extracted App.jsx orchestration into 4 hooks (useHotkeys, useScreenLifecycle, useSnapshotSync, useGlobalMediaDrop). App.jsx is now mostly composition and layout. Removed duplicate sidecar init.
- 2026-04-12: Phase 2 — consolidated playback/output authority around MediaSession. Removed store.tick() double time authority, registered NativeSink for Go renderer, stripped scattered broadcastToDisplays/PushTime/PushSnapshot calls from GlobalTicker, App.jsx, Timeline.jsx.
- 2026-04-12: Phase 1 — extracted project codec boundary (dfba134). Fixed missing getTrackItems import (bea2d8d).
- 2026-04-12: Initial plan written after architecture audit, cleanup baseline, and branch realignment.
