package main

import (
	"context"
	"embed"
	"io/fs"
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
		subAssets, _ := fs.Sub(assets, "frontend/dist")
		a.fileServer = &http.Server{
			Handler: NewFileLoader(subAssets),
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
