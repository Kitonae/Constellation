package main

import (
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

// SSEClient represents one connected renderer process.
type SSEClient struct {
	ch chan []byte // buffered; messages dropped if full
}

// SSEHub fans out SSE events to all connected renderer clients.
type SSEHub struct {
	mu           sync.Mutex
	clients      map[*SSEClient]struct{}
	lastSnapshot []byte // cached so new connections get it immediately
}

// NewSSEHub creates a new SSE hub.
func NewSSEHub() *SSEHub {
	return &SSEHub{clients: make(map[*SSEClient]struct{})}
}

// ServeHTTP implements http.Handler for the /sse/renderer endpoint.
func (h *SSEHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	client := &SSEClient{
		ch: make(chan []byte, 64),
	}

	h.mu.Lock()
	h.clients[client] = struct{}{}
	snapshot := h.lastSnapshot
	h.mu.Unlock()

	// Send cached snapshot on connect
	if snapshot != nil {
		log.Printf("[SSE] Client connected, sending cached snapshot (%d bytes)", len(snapshot))
		fmt.Fprintf(w, "event: snapshot\ndata: %s\n\n", snapshot)
		flusher.Flush()
	} else {
		log.Printf("[SSE] Client connected, no cached snapshot available")
	}

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()

	defer func() {
		h.mu.Lock()
		delete(h.clients, client)
		h.mu.Unlock()
	}()

	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-client.ch:
			w.Write(msg)
			flusher.Flush()
		case <-ticker.C:
			fmt.Fprintf(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

// BroadcastSnapshot sends a full project snapshot to all connected renderers.
func (h *SSEHub) BroadcastSnapshot(data []byte) {
	msg := fmt.Appendf(nil, "event: snapshot\ndata: %s\n\n", data)
	h.mu.Lock()
	h.lastSnapshot = data
	h.mu.Unlock()
	h.broadcast(msg)
}

// BroadcastTime sends the current playback time to all connected renderers.
func (h *SSEHub) BroadcastTime(t float64) {
	msg := fmt.Appendf(nil, "event: time\ndata: %.6f\n\n", t)
	h.broadcast(msg)
}

// BroadcastControl sends a transport command (play/pause/stop) to all renderers.
func (h *SSEHub) BroadcastControl(command string) {
	msg := fmt.Appendf(nil, "event: control\ndata: %s\n\n", command)
	h.broadcast(msg)
}

// BroadcastScreenOpen tells renderers to open a window for a screen.
func (h *SSEHub) BroadcastScreenOpen(screenID string, width, height int) {
	msg := fmt.Appendf(nil, "event: screen-open\ndata: {\"screenId\":%q,\"width\":%d,\"height\":%d}\n\n", screenID, width, height)
	h.broadcast(msg)
}

// BroadcastScreenClose tells renderers to close a screen window.
func (h *SSEHub) BroadcastScreenClose(screenID string) {
	msg := fmt.Appendf(nil, "event: screen-close\ndata: {\"screenId\":%q}\n\n", screenID)
	h.broadcast(msg)
}

func (h *SSEHub) broadcast(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for client := range h.clients {
		select {
		case client.ch <- msg:
		default:
			// drop if buffer full — renderer is too slow
		}
	}
}
