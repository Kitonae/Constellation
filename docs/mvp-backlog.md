MVP Backlog — Constellation

Notes
- Import these as GitHub issues. Titles are unique; labels in brackets.
- Milestones: M1 (Core), M2 (Editor), M3 (Playback), M4 (Polish).

Issues
1. [M1][proto] Define scene and control protobufs
   - Add/iterate schemas in proto/constellation/v1.
   - Include Project, Scene, Timeline, DisplayControl service.

2. [M1][display] Bootstrap Rust project structure
   - Create cargo workspace (display/).
   - Add tonic/gRPC server scaffold with health endpoint.

3. [M1][display] Implement DisplayControl: LoadProject/LoadScene
   - Accept payloads, validate, cache current scene/timeline in memory.
   - Return Ack with errors on invalid payloads.

4. [M1][display] Implement transport: Play/Pause/Stop/Seek/SetRate
   - Deterministic clock; monotonic time.
   - Expose SubscribeState stream with TransportState + basic FPS metrics.

5. [M1][display] Rendering loop and window management
   - Create render window; clear color; render loop tied to transport clock.
   - Stub draw calls for scene graph traversal.

6. [M2][editor] Tauri + React project scaffold
   - Create Tauri shell with Vite React app.
   - Wire up basic layout: Viewport, Timeline, Inspector panes.

7. [M2][editor] 3D viewport with react-three-fiber
   - Load scene JSON (examples/scene.example.json) and render nodes.
   - Basic gizmos for translate/rotate/scale.

8. [M2][editor] Timeline UI basics
   - Render media track + playhead; play/pause/seek controls.
   - Serialize/deserialize minimal Project JSON.

9. [M3][display] Media playback pipeline (CPU decode)
   - Integrate ffmpeg/gstreamer bindings; render to texture.
   - Route clip frames to ScreenComponent target.

10. [M3][display] Audio output and sync
    - Basic audio playback tied to transport time.
    - Latency compensation flag.

11. [M3][display] OSC control (in/out)
    - Map transport and clip controls to OSC addresses.

12. [M4][editor] Project save/load and autosave
    - Implement filesystem persistence; versioned autosaves.

13. [M4][editor] Live vs Preview mode
    - Add “Apply to Display” button; diff summary before push.

14. [M4][infra] CI: build artifacts for Windows
    - Build Display exe and Editor installer.

Batch creation (GitHub CLI)
If using GitHub CLI, run in repo root after logging in:

```
gh issue create --title "[M1][proto] Define scene and control protobufs" --body-file docs/mvp-backlog.md --label M1,proto --milestone M1
```

Repeat with tailored bodies per issue by copying the relevant bullet list.

