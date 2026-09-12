package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

// SSEClient represents one connected renderer process.
type SSEClient struct {
	// Which screen this renderer was launched for. Window commands are
	// addressed to it: one process is launched per screen, so broadcasting
	// a screen-open makes every other renderer open that screen's window too.
	screenID string
	ch       chan []byte // buffered; messages dropped if full
	timeCh   chan []byte // single-slot channel for time events (latest wins)
}

// SSEHub fans out SSE events to all connected renderer clients.
type SSEHub struct {
	mu           sync.Mutex
	clients      map[*SSEClient]struct{}
	lastSnapshot []byte // cached so new connections get it immediately

	// A renderer launched mid-show has missed everything that came before it,
	// and the transport is not re-sent until it next changes. Without these a
	// renderer opened while paused sits at zero, and one opened while playing
	// receives time ticks but never the play it needed to start its audio.
	lastControl []byte
	lastTime    []byte

	// Window commands per screen, replayed on connect: the renderer is
	// launched and told to open its screen before it has connected, so the
	// live send always misses.
	openScreens map[string][]byte

	// Stats (atomic, lock-free)
	statTimePushed  atomic.Int64
	statTimeSent    atomic.Int64
	statEventPushed atomic.Int64
	statEventSent   atomic.Int64
	statDropped     atomic.Int64
}

// NewSSEHub creates a new SSE hub.
func NewSSEHub() *SSEHub {
	hub := &SSEHub{
		clients:     make(map[*SSEClient]struct{}),
		openScreens: make(map[string][]byte),
	}
	go hub.logStats()
	return hub
}

func (h *SSEHub) logStats() {
	// Open a log file alongside the renderer logs
	logPath := filepath.Join(os.TempDir(), "constellation-sse-hub.log")
	f, err := os.Create(logPath)
	if err != nil {
		log.Printf("[SSE] Failed to create log file %s: %v", logPath, err)
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "SSE Hub log started at %s\n", time.Now().Format(time.RFC3339))
	log.Printf("[SSE] Logging stats to %s", logPath)

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		tp := h.statTimePushed.Swap(0)
		ts := h.statTimeSent.Swap(0)
		ep := h.statEventPushed.Swap(0)
		es := h.statEventSent.Swap(0)
		dr := h.statDropped.Swap(0)

		h.mu.Lock()
		nc := len(h.clients)
		h.mu.Unlock()

		line := fmt.Sprintf("[SSE stats] clients=%d  time: pushed=%d sent=%d  events: pushed=%d sent=%d  dropped=%d\n",
			nc, tp, ts, ep, es, dr)
		f.WriteString(time.Now().Format("15:04:05 ") + line)
		f.Sync()
		if tp > 0 || ep > 0 {
			log.Print(line)
		}
	}
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
	setCORS(w, r)

	screenID := r.URL.Query().Get("screen")
	client := &SSEClient{
		screenID: screenID,
		ch:       make(chan []byte, 64),
		timeCh:   make(chan []byte, 1),
	}

	h.mu.Lock()
	h.clients[client] = struct{}{}
	snapshot := h.lastSnapshot
	screenOpen := h.openScreens[screenID]
	control := h.lastControl
	lastTime := h.lastTime
	h.mu.Unlock()

	// Catch the new renderer up, in the order it would have received things
	// had it been connected: what to draw, which window to draw it in, whether
	// the transport is running, and where the playhead is.
	if snapshot != nil {
		log.Printf("[SSE] Client for %q connected, sending cached snapshot (%d bytes)",
			screenID, len(snapshot))
		fmt.Fprintf(w, "event: snapshot\ndata: %s\n\n", snapshot)
	} else {
		log.Printf("[SSE] Client for %q connected, no cached snapshot available", screenID)
	}
	if screenOpen != nil {
		w.Write(screenOpen)
	}
	if control != nil {
		w.Write(control)
	}
	if lastTime != nil {
		w.Write(lastTime)
	}
	flusher.Flush()

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
			h.statEventSent.Add(1)
		case msg := <-client.timeCh:
			// Drain to latest — if multiple time events queued, only send the newest
			latest := msg
			for {
				select {
				case newer := <-client.timeCh:
					latest = newer
				default:
					goto sendTime
				}
			}
		sendTime:
			w.Write(latest)
			flusher.Flush()
			h.statTimeSent.Add(1)
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
// Uses a dedicated single-slot channel so only the latest time is delivered.
func (h *SSEHub) BroadcastTime(t float64) {
	msg := fmt.Appendf(nil, "event: time\ndata: %.6f\n\n", t)
	h.statTimePushed.Add(1)
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastTime = msg
	for client := range h.clients {
		// Replace: drain old value, push new
		select {
		case <-client.timeCh:
		default:
		}
		select {
		case client.timeCh <- msg:
		default:
		}
	}
}

// BroadcastControl sends a transport command (play/pause/stop) to all renderers.
func (h *SSEHub) BroadcastControl(command string) {
	msg := fmt.Appendf(nil, "event: control\ndata: %s\n\n", command)
	h.mu.Lock()
	h.lastControl = msg
	h.mu.Unlock()
	h.broadcast(msg)
}

// SendScreenOpen tells one screen's renderer to open its window.
//
// Addressed rather than broadcast: a renderer that receives a screen-open
// creates that window whether or not the screen is its own, so broadcasting
// gave every running renderer a duplicate of every other screen. The message
// is also kept for replay, because the renderer is launched and told to open
// in the same breath and cannot yet be connected.
func (h *SSEHub) SendScreenOpen(screenID string, width, height int) {
	msg := fmt.Appendf(nil, "event: screen-open\ndata: {\"screenId\":%q,\"width\":%d,\"height\":%d}\n\n", screenID, width, height)
	h.mu.Lock()
	h.openScreens[screenID] = msg
	h.mu.Unlock()
	h.sendToScreen(screenID, msg)
}

// SendScreenClose tells one screen's renderer to close its window.
func (h *SSEHub) SendScreenClose(screenID string) {
	msg := fmt.Appendf(nil, "event: screen-close\ndata: {\"screenId\":%q}\n\n", screenID)
	h.mu.Lock()
	delete(h.openScreens, screenID)
	h.mu.Unlock()
	h.sendToScreen(screenID, msg)
}

func (h *SSEHub) sendToScreen(screenID string, msg []byte) {
	h.statEventPushed.Add(1)
	h.mu.Lock()
	defer h.mu.Unlock()
	for client := range h.clients {
		if client.screenID != screenID {
			continue
		}
		select {
		case client.ch <- msg:
		default:
			h.statDropped.Add(1)
		}
	}
}

func (h *SSEHub) broadcast(msg []byte) {
	h.statEventPushed.Add(1)
	h.mu.Lock()
	defer h.mu.Unlock()
	for client := range h.clients {
		select {
		case client.ch <- msg:
		default:
			h.statDropped.Add(1)
		}
	}
}
