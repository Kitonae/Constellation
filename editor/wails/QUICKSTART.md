# Quick Start Guide: Running Constellation Editor with Wails

## First Time Setup

1. **Install Wails CLI** (if not already installed):
   ```powershell
   go install github.com/wailsapp/wails/v2/cmd/wails@latest
   ```

2. **Navigate to the Wails directory**:
   ```powershell
   cd editor\wails
   ```

3. **Generate Protobuf bindings**:
   ```powershell
   .\gen-proto.ps1
   ```

4. **Install dependencies**:
   ```powershell
   go mod tidy
   npm --prefix ../ui install
   ```

## Running in Development Mode

```powershell
cd editor\wails
wails dev
```

This will:
- Start the Vite dev server (frontend)
- Launch the Wails app with hot reload
- Open the editor window

## Building for Production

### Option 1: Complete Build (Recommended)
```powershell
cd editor\wails
.\build.ps1
```

### Option 2: Manual Build
```powershell
cd editor\wails
npm --prefix ../ui run build
.\copy-frontend.ps1
wails build
```

The executable will be in: `editor\wails\build\bin\constellation-editor.exe`

## Common Issues

### "protoc not found"
- Install Protocol Buffers compiler: https://github.com/protocolbuffers/protobuf/releases
- Or the script will install vendored protoc-gen-go tools

### "could not import proto package"
- Make sure you ran `.\gen-proto.ps1` first
- Check that `internal/proto/` directory was created

### "Frontend not found" during build
- Run `npm --prefix ../ui run build` first
- Then run `.\copy-frontend.ps1`
- Or use the complete `.\build.ps1` script

### "Wails not found"
- Install Wails: `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- Make sure `$GOPATH/bin` is in your PATH

## Comparing Tauri vs Wails Commands

| Task | Tauri (Old) | Wails (New) |
|------|-------------|-------------|
| Dev mode | `cargo tauri dev` | `wails dev` |
| Build | `cargo tauri build` | `wails build` |
| Config | `tauri.conf.json` | `wails.json` |
| Backend | `src/main.rs` | `main.go`, `grpc.go`, `conversion.go` |
| Frontend API | `@tauri-apps/api` | `window.go.main.App.*` |

## Directory Structure

```
editor/
├── wails/              # Go/Wails backend (NEW)
│   ├── main.go         # App entry point
│   ├── grpc.go         # gRPC client
│   ├── conversion.go   # JSON conversion
│   ├── wails.json      # Wails config
│   ├── go.mod          # Go dependencies
│   ├── gen-proto.ps1   # Proto generation
│   ├── build.ps1       # Build script
│   └── internal/proto/ # Generated proto code
├── ui/                 # React frontend (shared)
│   ├── src/
│   │   └── utils/
│   │       └── wailsApi.js  # Updated for Wails
│   └── package.json
└── tauri/              # Rust/Tauri backend (OLD)
    ├── src/main.rs
    └── tauri.conf.json
```

## Testing the Port

1. Load a project JSON file
2. Apply it to a running Display server (default: `http://127.0.0.1:50051`)
3. Test transport controls (play, pause, stop, seek)
4. Verify timeline and media management work
5. Check display window spawning

## Next Steps

- Test all features to ensure parity with Tauri version
- Update documentation to reference Wails instead of Tauri
- Consider removing the Tauri implementation once Wails is stable
- Update CI/CD pipelines to build with Wails
