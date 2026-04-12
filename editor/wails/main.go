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
	"path/filepath"
	"regexp"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

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

func main() {
	// Create application instance
	app := NewApp()

	// Create sub FS for assets
	subAssets, err := fs.Sub(assets, "frontend/dist")
	if err != nil {
		log.Fatal(err)
	}

	// Create application with options
	err = wails.Run(&options.App{
		Title:  "Constellation Editor",
		Width:  1440,
		Height: 900,
		AssetServer: &assetserver.Options{
			Assets: subAssets,
			Middleware: func(next http.Handler) http.Handler {
				return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if len(r.URL.Path) >= 4 && r.URL.Path[:4] == "/fs/" {
						NewFileLoader(nil).ServeHTTP(w, r)
						return
					}
					next.ServeHTTP(w, r)
				})
			},
		},
		BackgroundColour: &options.RGBA{R: 27, G: 38, B: 54, A: 1},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Bind: []interface{}{
			app,
		},
		Windows: &windows.Options{
			WebviewIsTransparent: false,
			WindowIsTranslucent:  false,
			DisableWindowIcon:    false,
		},
	})

	if err != nil {
		log.Fatal(err)
	}
}

// App struct
type App struct {
	ctx        context.Context
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

// startup is called at application startup
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	sseHub := NewSSEHub()
	a.hub = sseHub
	a.renderers = NewRendererManager(sseHub, ctx)
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
}

// shutdown is called at application termination
func (a *App) shutdown(ctx context.Context) {
	if a.renderers != nil {
		a.renderers.ShutdownAll()
	}
	if sseHub, ok := a.hub.(*SSEHub); ok {
		sseHub.Close()
	}
	if a.fileServer != nil {
		a.fileServer.Close()
	}
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
	a.hub.BroadcastScreenOpen(screenID, width, height)
	return nil
}

// CloseRendererScreen stops the renderer and then broadcasts the close event.
func (a *App) CloseRendererScreen(screenID string) {
	if err := validateScreenID(screenID); err != nil {
		log.Printf("Invalid screen ID in CloseRendererScreen: %v", err)
		return
	}
	a.renderers.StopRenderer(screenID)
	a.hub.BroadcastScreenClose(screenID)
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
	paths, err := wailsRuntime.OpenMultipleFilesDialog(a.ctx, wailsRuntime.OpenDialogOptions{
		Title: "Import Media",
		Filters: []wailsRuntime.FileFilter{
			{DisplayName: "Media Files", Pattern: "*.png;*.jpg;*.jpeg;*.gif;*.bmp;*.webp;*.mp4;*.mov;*.webm;*.mkv;*.avi;*.m4v;*.mpg;*.mpeg;*.gltf;*.glb;*.obj"},
			{DisplayName: "All Files", Pattern: "*.*"},
		},
	})
	if err != nil {
		return nil, err
	}
	return paths, nil
}

// PickMediaFolder opens a native directory dialog and returns absolute paths of all files in it.
func (a *App) PickMediaFolder() ([]string, error) {
	dir, err := wailsRuntime.OpenDirectoryDialog(a.ctx, wailsRuntime.OpenDialogOptions{
		Title: "Import Folder",
	})
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
