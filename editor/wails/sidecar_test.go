package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
}

func TestRequireToken(t *testing.T) {
	h := requireToken("secret", okHandler())

	cases := []struct {
		name   string
		build  func() *http.Request
		status int
	}{
		{"no token", func() *http.Request { return httptest.NewRequest("GET", "/x", nil) }, http.StatusUnauthorized},
		{"wrong token", func() *http.Request { return httptest.NewRequest("GET", "/x?token=nope", nil) }, http.StatusUnauthorized},
		{"query token", func() *http.Request { return httptest.NewRequest("GET", "/x?token=secret", nil) }, http.StatusOK},
		{"header token", func() *http.Request {
			r := httptest.NewRequest("GET", "/x", nil)
			r.Header.Set(tokenHeader, "secret")
			return r
		}, http.StatusOK},
		{"preflight passes without a token", func() *http.Request { return httptest.NewRequest("OPTIONS", "/x", nil) }, http.StatusOK},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, c.build())
			if w.Code != c.status {
				t.Errorf("got %d, want %d", w.Code, c.status)
			}
		})
	}

	// A server with no token must refuse rather than admit everyone.
	w := httptest.NewRecorder()
	requireToken("", okHandler()).ServeHTTP(w, httptest.NewRequest("GET", "/x?token=", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("unconfigured token: got %d, want 503", w.Code)
	}
}

func TestSetCORS_AllowlistNotWildcard(t *testing.T) {
	check := func(origin, want string) {
		t.Helper()
		r := httptest.NewRequest("GET", "/x", nil)
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		setCORS(w, r)
		if got := w.Header().Get("Access-Control-Allow-Origin"); got != want {
			t.Errorf("origin %q: ACAO %q, want %q", origin, got, want)
		}
	}
	check("http://wails.localhost", "http://wails.localhost")
	check("http://localhost:5173", "http://localhost:5173")
	check("http://127.0.0.1:53366", "http://127.0.0.1:53366")
	check("https://evil.example", "")
	check("http://localhost.evil.example", "")
	check("", "")
}

func TestSidecar_MediaNeedsTokenAndDecodesOnce(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("drive-letter paths")
	}
	dir := t.TempDir()
	// A literal percent sign in the name is legal and used to 400: the path
	// arrived already decoded and was unescaped a second time.
	name := "100% done.png"
	if err := os.WriteFile(filepath.Join(dir, name), []byte("PNG?"), 0o644); err != nil {
		t.Fatal(err)
	}

	hub := NewSSEHub()
	rm := &RendererManager{procs: make(map[string]*rendererProc), hub: hub}
	mux := NewAPIMux(NewFileLoader(nil), hub, rm, nil, "t")

	// Encode each segment the way the editor does.
	segs := strings.Split(filepath.ToSlash(filepath.Join(dir, name)), "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	fsPath := "/fs/" + strings.Join(segs, "/")

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", fsPath, nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("without a token: got %d, want 401", w.Code)
	}

	w = httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", fsPath+"?token=t", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("with a token: got %d, want 200 (body %q)", w.Code, w.Body.String())
	}
	if w.Body.String() != "PNG?" {
		t.Errorf("served the wrong bytes: %q", w.Body.String())
	}
}

func TestSidecar_AppBundleNeedsNoToken(t *testing.T) {
	hub := NewSSEHub()
	rm := &RendererManager{procs: make(map[string]*rendererProc), hub: hub}
	served := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/fs/") {
			t.Errorf("/fs/ reached the loader without a token")
		}
		w.WriteHeader(http.StatusOK)
	})
	mux := NewAPIMux(served, hub, rm, nil, "t")

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/assets/index.js", nil))
	if w.Code != http.StatusOK {
		t.Errorf("app assets must load without a token, got %d", w.Code)
	}
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/sse/renderer?screen=a", nil))
	if w.Code != http.StatusUnauthorized {
		t.Errorf("the event stream must need a token, got %d", w.Code)
	}
}

func TestOriginAllowed_WailsOriginWithDevPort(t *testing.T) {
	for _, o := range []string{"http://wails.localhost", "http://wails.localhost:5173", "https://wails.localhost:34115", "wails://wails"} {
		if !originAllowed(o) {
			t.Errorf("%s should be allowed", o)
		}
	}
	for _, o := range []string{"http://wails.localhost.evil.com", "http://notwails.localhost:5173", "http://example.com"} {
		if originAllowed(o) {
			t.Errorf("%s must not be allowed", o)
		}
	}
}
