package main

import (
	"context"
	"embed"
	"log"
	"net"
	"net/http"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	// Create application instance
	app := NewApp()

	// Create application with options
	err := wails.Run(&options.App{
		Title:  "Constellation Editor",
		Width:  1440,
		Height: 900,
		AssetServer: &assetserver.Options{
			Assets:  assets,
			Handler: NewFileLoader(),
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
	ctx            context.Context
	fileServerPort int
	fileServer     *http.Server
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called at application startup
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	// Start a sidecar file server for dev mode access
	listener, err := net.Listen("tcp", "localhost:0")
	if err == nil {
		a.fileServerPort = listener.Addr().(*net.TCPAddr).Port
		a.fileServer = &http.Server{
			Handler: NewFileLoader(),
		}
		go func() {
			if err := a.fileServer.Serve(listener); err != nil && err != http.ErrServerClosed {
				log.Printf("File server error: %v", err)
			}
		}()
		log.Printf("Sidecar file server started on port %d", a.fileServerPort)
	} else {
		log.Printf("Failed to start sidecar file server: %v", err)
	}
}

// shutdown is called at application termination
func (a *App) shutdown(ctx context.Context) {
	if a.fileServer != nil {
		a.fileServer.Close()
	}
}

func (a *App) GetFileServerPort() int {
	return a.fileServerPort
}
