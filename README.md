Constellation — Media Server (MVP scaffold)

Overview
- Two modules: Display Server (real-time renderer + playback) and Editor UI (timeline + 3D stage).
- This repo contains initial schemas, examples, and stubs to align architecture and API.

Structure
- proto/: gRPC + Protobuf schemas for Editor ↔ Display.
- display/: Rust display server (gRPC), codegen from proto.
- client/: Rust CLI to call Display (load project, play/seek/etc.).
- editor/: notes and structure for a Tauri + React editor.
- examples/: sample project and scene JSON.
- docs/: MVP backlog and design notes.

Quick Start (conceptual)
- Define messages in proto/, generate code for Display and Editor languages.
- Implement Display gRPC server (see display/), Editor gRPC/WebSocket client.
- Use examples/scene.example.json as reference for scene payloads.

Build (Rust workspace)
- Install Rust toolchain (stable).
- From repo root:
  - `cargo build -p constellation-display`
  - `cargo build -p constellation-cli`

Run
- Start server (opens a render window): `cargo run -p constellation-display`
- Load project from JSON: `cargo run -p constellation-cli -- --addr http://127.0.0.1:50051 load-project examples/scene.example.json`
- Transport: `cargo run -p constellation-cli -- play` | `pause` | `stop` | `seek --to 12.5` | `rate --rate 0.5`
- Subscribe to state: `cargo run -p constellation-cli -- subscribe`

Next
- Flesh out Display control service from proto/.
- Implement Editor 3D viewport (react-three-fiber) and timeline.
- Add media playback pipeline and output management in Display.
