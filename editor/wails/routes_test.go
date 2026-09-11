package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRoutes_StatusPost_Valid(t *testing.T) {
	hub := NewSSEHub()
	rm := &RendererManager{
		procs:   make(map[string]*rendererProc),
		hub:     hub,
		exePath: "",
	}

	// Add a proc so UpdateStatus has something to update
	rm.mu.Lock()
	rm.procs["test-screen"] = &rendererProc{
		screenID: "test-screen",
		status:   RendererStatus{ScreenID: "test-screen", State: "launching"},
	}
	rm.mu.Unlock()

	mux := NewAPIMux(http.NotFoundHandler(), hub, rm)

	body := `{"screenId":"test-screen","state":"ready","fps":60}`
	req := httptest.NewRequest("POST", "/api/renderer/status", strings.NewReader(body))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	status := rm.GetStatus("test-screen")
	if status.State != "ready" {
		t.Errorf("expected state 'ready', got %q", status.State)
	}
}

func TestRoutes_StatusPost_BadJSON(t *testing.T) {
	hub := NewSSEHub()
	rm := &RendererManager{procs: make(map[string]*rendererProc), hub: hub}
	mux := NewAPIMux(http.NotFoundHandler(), hub, rm)

	req := httptest.NewRequest("POST", "/api/renderer/status", strings.NewReader("not json"))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestRoutes_StatusPost_WrongMethod(t *testing.T) {
	hub := NewSSEHub()
	rm := &RendererManager{procs: make(map[string]*rendererProc), hub: hub}
	mux := NewAPIMux(http.NotFoundHandler(), hub, rm)

	req := httptest.NewRequest("GET", "/api/renderer/status", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

func TestRoutes_StatusPost_CORS(t *testing.T) {
	hub := NewSSEHub()
	rm := &RendererManager{procs: make(map[string]*rendererProc), hub: hub}
	mux := NewAPIMux(http.NotFoundHandler(), hub, rm)

	req := httptest.NewRequest("OPTIONS", "/api/renderer/status", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for OPTIONS, got %d", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("expected CORS *, got %q", got)
	}
}

func TestRoutes_SSEEndpoint(t *testing.T) {
	hub := NewSSEHub()
	hub.BroadcastSnapshot([]byte(`{"test":true}`)) // cache a snapshot so client gets data immediately
	rm := &RendererManager{procs: make(map[string]*rendererProc), hub: hub}
	mux := NewAPIMux(http.NotFoundHandler(), hub, rm)

	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/sse/renderer")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Errorf("expected text/event-stream, got %q", resp.Header.Get("Content-Type"))
	}

	// Read snapshot event and close — don't wait for keepalive
	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	if !strings.Contains(string(buf[:n]), "snapshot") {
		t.Errorf("expected snapshot event, got %q", string(buf[:n]))
	}
}
