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

	mux := NewAPIMux(http.NotFoundHandler(), hub, rm, nil, "t")

	body := `{"screenId":"test-screen","state":"ready","fps":60}`
	req := httptest.NewRequest("POST", "/api/renderer/status", strings.NewReader(body))
	req.Header.Set(tokenHeader, "t")
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
	mux := NewAPIMux(http.NotFoundHandler(), hub, rm, nil, "t")

	req := httptest.NewRequest("POST", "/api/renderer/status", strings.NewReader("not json"))
	req.Header.Set(tokenHeader, "t")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", w.Code)
	}
}

func TestRoutes_StatusPost_WrongMethod(t *testing.T) {
	hub := NewSSEHub()
	rm := &RendererManager{procs: make(map[string]*rendererProc), hub: hub}
	mux := NewAPIMux(http.NotFoundHandler(), hub, rm, nil, "t")

	req := httptest.NewRequest("GET", "/api/renderer/status", nil)
	req.Header.Set(tokenHeader, "t")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Errorf("expected 405, got %d", w.Code)
	}
}

// CORS is an allowlist of the origins the editor and its output windows are
// served from, not a wildcard: a page from anywhere used to be told it could
// read the responses.
func TestRoutes_StatusPost_CORS(t *testing.T) {
	hub := NewSSEHub()
	rm := &RendererManager{procs: make(map[string]*rendererProc), hub: hub}
	mux := NewAPIMux(http.NotFoundHandler(), hub, rm, nil, "t")

	req := httptest.NewRequest("OPTIONS", "/api/renderer/status", nil)
	req.Header.Set("Origin", "http://wails.localhost")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for OPTIONS, got %d", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "http://wails.localhost" {
		t.Errorf("expected the editor's origin echoed, got %q", got)
	}

	req = httptest.NewRequest("OPTIONS", "/api/renderer/status", nil)
	req.Header.Set("Origin", "https://evil.example")
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("a foreign origin must get no CORS grant, got %q", got)
	}
}

func TestRoutes_SSEEndpoint(t *testing.T) {
	hub := NewSSEHub()
	hub.BroadcastSnapshot([]byte(`{"test":true}`)) // cache a snapshot so client gets data immediately
	rm := &RendererManager{procs: make(map[string]*rendererProc), hub: hub}
	mux := NewAPIMux(http.NotFoundHandler(), hub, rm, nil, "t")

	srv := httptest.NewServer(mux)
	defer srv.Close()

	// The stream carries the whole show; it is not open to anyone who can
	// reach the port.
	if bare, err := http.Get(srv.URL + "/sse/renderer"); err == nil {
		bare.Body.Close()
		if bare.StatusCode != http.StatusUnauthorized {
			t.Errorf("without a token: got %d, want 401", bare.StatusCode)
		}
	}

	resp, err := http.Get(srv.URL + "/sse/renderer?token=t")
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
