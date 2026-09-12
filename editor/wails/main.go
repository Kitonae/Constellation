package main

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// FilesDroppedEvent is the event the frontend subscribes to for native file
// drops. Wails v3 routes drops through Go, so this name is the contract
// between main.go and the editor's import handling.
const FilesDroppedEvent = "media:filesDropped"

var screenIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

// validateScreenID checks that a screen ID is safe for use as a process identifier.
func validateScreenID(id string) error {
	if !screenIDPattern.MatchString(id) {
		return fmt.Errorf("invalid screen ID %q: must be 1-64 alphanumeric, hyphen, or underscore characters", id)
	}
	return nil
}

//go:embed all:frontend/dist
var assets embed.FS

// fsMiddleware serves /fs/ media requests from the file loader and passes
// everything else to the asset server.
func fsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(r.URL.Path) >= 4 && r.URL.Path[:4] == "/fs/" {
			NewFileLoader(nil).ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	// Create application instance
	appService := NewApp()

	// Create sub FS for assets
	subAssets, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		log.Fatal(err)
	}

	app := application.New(application.Options{
		Name:        "Constellation Editor",
		Description: "Video display control editor",
		Services: []application.Service{
			application.NewService(appService),
		},
		Assets: application.AssetOptions{
			Handler:    application.AssetFileServerFS(subAssets),
			Middleware: fsMiddleware,
		},
	})

	// The service reaches the runtime (native dialogs) through the app.
	appService.app = app

	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title:            "Constellation Editor",
		Width:            1440,
		Height:           900,
		BackgroundColour: application.NewRGB(27, 38, 54),
		// The WebView2 File object has no .path, so an HTML drop yields a
		// blob: URI the native renderer cannot open. The Wails drag-and-drop
		// runtime hands us absolute paths instead. Files must be dropped on an
		// element carrying `data-file-drop-target` for this to fire.
		EnableFileDrop: true,
	})

	// Unlike v2's OnFileDrop, which handed paths straight to JavaScript, v3
	// delivers the drop to Go. Relay it to the frontend under our own event
	// name so the import path there stays a single subscription.
	window.OnWindowEvent(events.Common.WindowFilesDropped, func(e *application.WindowEvent) {
		files := e.Context().DroppedFiles()
		if len(files) == 0 {
			return
		}
		app.Event.Emit(FilesDroppedEvent, files)
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

// App struct
type App struct {
	app            *application.App
	fileServerPort int
	fileServer     *http.Server
	initError      string
	hub            Broadcaster
	renderers      ProcessManager
	files          FileReader
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// ServiceStartup is called when the service starts, before the window opens.
func (a *App) ServiceStartup(ctx context.Context, options application.ServiceOptions) error {
	sseHub := NewSSEHub()
	a.hub = sseHub
	a.renderers = NewRendererManager(sseHub)
	a.files = &FileService{}

	// Start a sidecar file server for dev mode access and renderer communication
	listener, err := net.Listen("tcp", "localhost:0")
	if err == nil {
		a.fileServerPort = listener.Addr().(*net.TCPAddr).Port
		subAssets, _ := fs.Sub(assets, "frontend/dist")
		fileLoader := NewFileLoader(subAssets)
		mux := NewAPIMux(fileLoader, sseHub, a.renderers)
		a.fileServer = &http.Server{Handler: mux}
		go func() {
			if err := a.fileServer.Serve(listener); err != nil && err != http.ErrServerClosed {
				log.Printf("File server error: %v", err)
			}
		}()
		log.Printf("Sidecar server started on port %d", a.fileServerPort)
	} else {
		a.initError = fmt.Sprintf("Failed to start sidecar file server: %v", err)
		log.Printf("%s", a.initError)
	}
	return nil
}

// ServiceShutdown is called at application termination.
func (a *App) ServiceShutdown() error {
	if a.renderers != nil {
		a.renderers.ShutdownAll()
	}
	if a.fileServer != nil {
		a.fileServer.Close()
	}
	return nil
}

// GetInitError returns any initialization error (empty string if all OK).
func (a *App) GetInitError() string {
	return a.initError
}

// ReadFileBase64 delegates to the FileService for Wails binding.
func (a *App) ReadFileBase64(path string) (string, error) {
	return a.files.ReadFileBase64(path)
}

// GetFileServerPort returns the sidecar server port for the frontend.
func (a *App) GetFileServerPort() int {
	return a.fileServerPort
}

// FileExists reports whether a local media file is still on disk.
//
// The Media Bin needs to tell "the file moved" apart from "the thumbnail
// failed to decode"; both used to render as the same grey placeholder. Goes
// through the same path validation as the file server, so it cannot be used
// to probe arbitrary locations.
func (a *App) FileExists(path string) bool {
	clean := filepath.Clean(path)
	if err := validateFSPath(clean); err != nil {
		return false
	}
	info, err := os.Stat(clean)
	if err != nil {
		return false
	}
	return !info.IsDir()
}

// RevealInExplorer opens the OS file browser with the file selected.
func (a *App) RevealInExplorer(path string) error {
	clean := filepath.Clean(path)
	if err := validateFSPath(clean); err != nil {
		return err
	}
	if _, err := os.Stat(clean); err != nil {
		return fmt.Errorf("file not found: %w", err)
	}
	// explorer.exe returns exit status 1 even when it succeeds, so the error
	// from Run is not meaningful here; Start avoids waiting on it at all.
	return exec.Command("explorer.exe", "/select,", clean).Start()
}

// --- Renderer Wails bindings ---

// LaunchRenderer starts a native renderer process for a screen.
func (a *App) LaunchRenderer(screenID string, width, height int) error {
	if err := validateScreenID(screenID); err != nil {
		return err
	}
	return a.renderers.LaunchRenderer(screenID, a.fileServerPort, width, height)
}

// StopRenderer stops the renderer process for a screen.
func (a *App) StopRenderer(screenID string) error {
	if err := validateScreenID(screenID); err != nil {
		return err
	}
	return a.renderers.StopRenderer(screenID)
}

// GetRendererStatus returns the current status of a renderer for a screen.
func (a *App) GetRendererStatus(screenID string) RendererStatus {
	if err := validateScreenID(screenID); err != nil {
		return RendererStatus{ScreenID: screenID, State: "error", Error: err.Error()}
	}
	return a.renderers.GetStatus(screenID)
}

// OpenRendererScreen launches a renderer process and sends a screen-open SSE event.
func (a *App) OpenRendererScreen(screenID string, width, height int) error {
	if err := validateScreenID(screenID); err != nil {
		return err
	}
	err := a.renderers.LaunchRenderer(screenID, a.fileServerPort, width, height)
	if err != nil {
		log.Printf("Renderer launch error for %s: %v", screenID, err)
		return err
	}
	a.hub.SendScreenOpen(screenID, width, height)
	return nil
}

// CloseRendererScreen sends a screen-close event and stops the renderer.
func (a *App) CloseRendererScreen(screenID string) {
	if err := validateScreenID(screenID); err != nil {
		log.Printf("Invalid screen ID in CloseRendererScreen: %v", err)
		return
	}
	a.hub.SendScreenClose(screenID)
	a.renderers.StopRenderer(screenID)
}

// PushSnapshot sends the full project state to all connected renderers.
func (a *App) PushSnapshot(projectJSON string) {
	a.hub.BroadcastSnapshot([]byte(projectJSON))
}

// PushTime sends the current playback time to all connected renderers.
func (a *App) PushTime(t float64) {
	a.hub.BroadcastTime(t)
}

// PushControl sends a transport command to all connected renderers.
func (a *App) PushControl(command string) {
	a.hub.BroadcastControl(command)
}

// PickMediaFiles opens a native file dialog and returns absolute paths.
// This avoids blob: URIs which don't work cross-origin in display windows.
func (a *App) PickMediaFiles() ([]string, error) {
	return a.app.Dialog.OpenFile().
		SetTitle("Import Media").
		CanChooseFiles(true).
		AddFilter("Media Files", "*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp;*.mp4;*.mov;*.webm;*.mkv;*.avi;*.m4v;*.mpg;*.mpeg;*.gltf;*.glb;*.obj").
		AddFilter("All Files", "*.*").
		PromptForMultipleSelection()
}

// PickMediaFolder opens a native directory dialog and returns absolute paths of all files in it.
func (a *App) PickMediaFolder() ([]string, error) {
	dir, err := a.app.Dialog.OpenFile().
		SetTitle("Import Folder").
		CanChooseDirectories(true).
		CanChooseFiles(false).
		PromptForSingleSelection()
	if err != nil || dir == "" {
		return nil, err
	}
	// Walk the directory and collect file paths
	var paths []string
	entries, err := fs.ReadDir(os.DirFS(dir), ".")
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		paths = append(paths, filepath.Join(dir, e.Name()))
	}
	return paths, nil
}
