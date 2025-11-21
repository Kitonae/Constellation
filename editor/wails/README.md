# Constellation Editor - Wails Version

This is the Wails (Go) port of the Constellation Editor, replacing the previous Tauri (Rust) implementation.

## Prerequisites

- Go 1.21 or higher
- Node.js and npm
- Wails CLI v2: `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- protoc (Protocol Buffers compiler)

## Setup

1. **Generate protobuf Go code:**
   ```powershell
   cd editor/wails
   .\gen-proto.ps1
   ```

2. **Install frontend dependencies:**
   ```powershell
   cd ../ui
   npm install
   ```

3. **Download Go dependencies:**
   ```powershell
   cd ../wails
   go mod tidy
   ```

## Development

Run the application in development mode:

```powershell
cd editor/wails
wails dev
```

This will:
- Start the Vite dev server on `http://localhost:5173`
- Launch the Wails application with hot reload
- Watch for changes in both Go and frontend code

## Building

Build a production binary:

```powershell
cd editor/wails
wails build
```

The compiled executable will be in `editor/wails/build/bin/`.

## Architecture

### Backend (Go)
- **main.go**: Wails application entry point
- **grpc.go**: gRPC client methods for communicating with the Display server
- **conversion.go**: JSON to protobuf conversion logic
- **internal/proto/**: Generated protobuf Go code

### Frontend (React)
Located in `editor/ui/`, shared with the Tauri version but adapted to use Wails runtime:
- Uses `window.go.main.App.*` methods to call Go backend
- See `src/utils/wailsApi.js` for the Wails runtime integration

## API Methods

The Go backend exposes these methods to the frontend:

- `ApplyProject(addr, projectJSON)` - Load a project to the display server
- `Play(addr, at)` - Start playback
- `Pause(addr)` - Pause playback
- `Stop(addr)` - Stop playback
- `Seek(addr, to)` - Seek to a specific time
- `SetRate(addr, rate)` - Set playback rate

All methods communicate with the Display server via gRPC.

## Differences from Tauri Version

1. **Language**: Rust → Go
2. **Framework**: Tauri → Wails
3. **Build system**: Cargo → Go modules + Wails CLI
4. **Frontend binding**: `@tauri-apps/api` → `window.go.*` (Wails runtime)
5. **File serving**: Uses Wails asset server instead of Tauri's `convertFileSrc`

## Configuration

- `wails.json` - Wails project configuration
- `go.mod` - Go module dependencies
- Frontend config remains in `editor/ui/` (package.json, vite.config.js)
