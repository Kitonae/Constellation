package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
)

// NewAPIMux builds the http.Handler for the sidecar server.
// It composes the existing FileLoader with SSE and status endpoints.
//
// Everything that reads local files or carries the show requires the session
// token (see auth.go). The app bundle itself does not: it is what the output
// windows load before they have any way to present a token.
func NewAPIMux(fileLoader http.Handler, hub http.Handler, rm ProcessManager, thumbnails *ThumbnailService, token string) http.Handler {
	mux := http.NewServeMux()

	// SSE endpoint — renderer connects here
	mux.Handle("/sse/renderer", requireToken(token, hub))

	// What the renderer can say about a video file that the browser cannot: a
	// frame as a PNG, and its duration and size. Optional: tests build the
	// mux without it.
	if thumbnails != nil {
		mux.Handle("/api/thumbnail", requireToken(token, thumbnails))
		mux.Handle("/api/probe", requireToken(token, http.HandlerFunc(thumbnails.ServeProbe)))
	}

	// Status POST — renderer reports back
	mux.Handle("/api/renderer/status", requireToken(token, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}

		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<16)) // 64KB max
		if err != nil {
			http.Error(w, "read error", http.StatusBadRequest)
			return
		}

		var status RendererStatus
		if err := json.Unmarshal(body, &status); err != nil {
			http.Error(w, "bad json", http.StatusBadRequest)
			return
		}

		rm.UpdateStatus(status)
		log.Printf("Renderer status update: screen=%s state=%s fps=%.1f", status.ScreenID, status.State, status.FPS)
		w.WriteHeader(http.StatusOK)
	})))

	// Local files need the token; the app bundle, which output windows load
	// before they can present one, does not.
	mux.Handle("/fs/", requireToken(token, fileLoader))
	mux.Handle("/", fileLoader)

	return mux
}
