package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
)

// NewAPIMux builds the http.Handler for the sidecar server.
// It composes the existing FileLoader with SSE and status endpoints.
func NewAPIMux(fileLoader http.Handler, hub http.Handler, rm ProcessManager, thumbnails http.Handler) http.Handler {
	mux := http.NewServeMux()

	// SSE endpoint — renderer connects here
	mux.Handle("/sse/renderer", hub)

	// One frame of a video as a PNG, from the renderer, for files the browser
	// cannot decode. Optional: tests build the mux without it.
	if thumbnails != nil {
		mux.Handle("/api/thumbnail", thumbnails)
	}

	// Status POST — renderer reports back
	mux.HandleFunc("/api/renderer/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "*")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
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
	})

	// Everything else falls through to the existing FileLoader
	mux.Handle("/", fileLoader)

	return mux
}
