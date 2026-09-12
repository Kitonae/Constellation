package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLocalPathFromURI(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("drive-letter cases")
	}
	cases := map[string]string{
		"file:///C:/Users/x/clip%20one.mov": `C:\Users\x\clip one.mov`,
		"C:/Users/x/clip.mov":               `C:\Users\x\clip.mov`,
		`C:\Users\x\clip.mov`:               `C:\Users\x\clip.mov`,
	}
	for in, want := range cases {
		got, err := localPathFromURI(in)
		if err != nil {
			t.Errorf("%q: unexpected error %v", in, err)
			continue
		}
		if got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestThumbnail_RejectsTraversal(t *testing.T) {
	svc := NewThumbnailService("")
	req := httptest.NewRequest("GET", "/api/thumbnail?uri=file:///C:/x/../../etc/passwd", nil)
	w := httptest.NewRecorder()
	svc.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden && w.Code != http.StatusNotFound {
		t.Errorf("expected 403 or 404 for a traversal, got %d", w.Code)
	}
}

func TestThumbnail_MissingFileIs404(t *testing.T) {
	svc := NewThumbnailService("")
	missing := filepath.Join(t.TempDir(), "nope.mov")
	req := httptest.NewRequest("GET", "/api/thumbnail?uri="+missing, nil)
	w := httptest.NewRecorder()
	svc.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Errorf("expected 404, got %d", w.Code)
	}
}

func TestThumbnail_NoRendererIs503(t *testing.T) {
	// A real file but no renderer to decode it: the caller must be able to
	// tell "service unavailable" from "this file cannot be thumbnailed".
	dir := t.TempDir()
	clip := filepath.Join(dir, "clip.mov")
	if err := os.WriteFile(clip, []byte("not really a movie"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc := NewThumbnailService(filepath.Join(dir, "no-such-renderer.exe"))
	svc.cacheDir = dir
	req := httptest.NewRequest("GET", "/api/thumbnail?uri="+clip, nil)
	w := httptest.NewRecorder()
	svc.ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 without a renderer, got %d", w.Code)
	}
}

func TestProbe_NoRendererIs503(t *testing.T) {
	dir := t.TempDir()
	clip := filepath.Join(dir, "clip.mov")
	if err := os.WriteFile(clip, []byte("movie"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc := NewThumbnailService(filepath.Join(dir, "no-such-renderer.exe"))
	svc.cacheDir = dir
	req := httptest.NewRequest("GET", "/api/probe?uri="+clip, nil)
	w := httptest.NewRecorder()
	svc.ServeProbe(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 without a renderer, got %d", w.Code)
	}
}

func TestProbe_ServesCachedJSON(t *testing.T) {
	dir := t.TempDir()
	clip := filepath.Join(dir, "clip.mov")
	if err := os.WriteFile(clip, []byte("movie"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc := NewThumbnailService(filepath.Join(dir, "no-such-renderer.exe"))
	svc.cacheDir = dir
	info, _ := os.Stat(clip)
	name := probeNameFor(filepath.Clean(clip), info.Size(), info.ModTime().UnixNano())
	if err := os.WriteFile(filepath.Join(dir, name), []byte(`{"duration":5.0}`), 0o644); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("GET", "/api/probe?uri="+clip, nil)
	w := httptest.NewRecorder()
	svc.ServeProbe(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 from cache, got %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("expected application/json, got %q", ct)
	}
}

func TestThumbnail_ServesCachedPNG(t *testing.T) {
	// With the result already in the cache the renderer is never consulted,
	// so a missing executable must not matter.
	dir := t.TempDir()
	clip := filepath.Join(dir, "clip.mov")
	if err := os.WriteFile(clip, []byte("movie"), 0o644); err != nil {
		t.Fatal(err)
	}
	svc := NewThumbnailService(filepath.Join(dir, "no-such-renderer.exe"))
	svc.cacheDir = dir

	info, err := os.Stat(clip)
	if err != nil {
		t.Fatal(err)
	}
	name := cacheNameFor(filepath.Clean(clip), info.Size(), info.ModTime().UnixNano(), 0)
	if err := os.WriteFile(filepath.Join(dir, name), []byte("\x89PNG\r\n\x1a\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest("GET", "/api/thumbnail?uri="+clip, nil)
	w := httptest.NewRecorder()
	svc.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200 from cache, got %d", w.Code)
	}
}
