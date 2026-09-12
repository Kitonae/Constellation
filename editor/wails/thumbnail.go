package main

import (
	"context"
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ThumbnailService answers two questions about a video file by running the
// renderer executable headlessly: what does a frame look like
// (/api/thumbnail, a PNG) and how long and large is it (/api/probe, JSON).
//
// The editor asks a browser media element first, and the browser cannot
// decode HAP -- the codec media servers standardise on -- nor HEVC without
// the codec pack. The renderer decodes both, so it is asked instead, and the
// answers are cached on disk keyed by the file's identity so each clip is
// decoded once.
//
// Requests for the same answer are coalesced and the number of renderer
// processes alive at once is capped: importing a folder of HAP files used to
// launch one decoder per tile in the same instant.
type ThumbnailService struct {
	exePath  string
	cacheDir string
	timeout  time.Duration

	mu       sync.Mutex
	inflight map[string]*inflightJob // keyed by output path
	sem      chan struct{}           // renderer processes allowed at once
}

type inflightJob struct {
	done chan struct{}
	err  error
}

func NewThumbnailService(exePath string) *ThumbnailService {
	dir := filepath.Join(os.TempDir(), "constellation-thumbnails")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("[Thumbnail] cache dir %s: %v", dir, err)
	}
	return &ThumbnailService{
		exePath:  exePath,
		cacheDir: dir,
		timeout:  20 * time.Second,
		inflight: make(map[string]*inflightJob),
		sem:      make(chan struct{}, 2),
	}
}

// localPathFromURI turns what the editor holds -- a file:// URI or a bare
// path -- into a cleaned, validated filesystem path, by the same rules the
// /fs/ file server applies.
func localPathFromURI(raw string) (string, error) {
	p := raw
	if strings.HasPrefix(p, "file://") {
		u, err := url.Parse(p)
		if err != nil {
			return "", err
		}
		p = u.Path
		if u.Host != "" && u.Host != "localhost" {
			// UNC: file://server/share/x -> //server/share/x
			p = "//" + u.Host + p
		}
	} else if unescaped, err := url.PathUnescape(p); err == nil {
		p = unescaped
	}
	// Windows drive letters: /C:/... -> C:/...
	if len(p) > 2 && p[0] == '/' && p[2] == ':' {
		p = p[1:]
	}
	p = filepath.Clean(p)
	if err := validateFSPath(p); err != nil {
		return "", err
	}
	return p, nil
}

// cacheKey identifies a file by more than its name: the same path with new
// contents gets a new answer, and the same file asked at another time gets
// another.
func cacheKey(path string, size int64, modTimeNanos int64, t float64) string {
	h := sha1.New()
	fmt.Fprintf(h, "%s|%d|%d|%.3f", path, size, modTimeNanos, t)
	return hex.EncodeToString(h.Sum(nil))
}

func cacheNameFor(path string, size int64, modTimeNanos int64, t float64) string {
	return cacheKey(path, size, modTimeNanos, t) + ".png"
}

func probeNameFor(path string, size int64, modTimeNanos int64) string {
	return cacheKey(path, size, modTimeNanos, -1) + ".json"
}

// resolve turns the request's `uri` into a validated local file, writing the
// right status when it cannot. Returns ok=false after responding.
func (s *ThumbnailService) resolve(w http.ResponseWriter, r *http.Request) (src string, info os.FileInfo, ok bool) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return "", nil, false
	}
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return "", nil, false
	}
	src, err := localPathFromURI(r.URL.Query().Get("uri"))
	if err != nil || src == "" {
		http.Error(w, "bad or forbidden path", http.StatusForbidden)
		return "", nil, false
	}
	info, err = os.Stat(src)
	if err != nil || info.IsDir() {
		http.Error(w, "no such file", http.StatusNotFound)
		return "", nil, false
	}
	return src, info, true
}

// produce makes sure `out` exists, running the renderer with `args` if it
// does not. Concurrent requests for the same `out` share one run.
func (s *ThumbnailService) produce(ctx context.Context, out string, args ...string) error {
	if _, err := os.Stat(out); err == nil {
		return nil
	}
	if s.exePath == "" {
		return errNoRenderer
	}
	if _, err := os.Stat(s.exePath); err != nil {
		return errNoRenderer
	}

	s.mu.Lock()
	if job, running := s.inflight[out]; running {
		s.mu.Unlock()
		select {
		case <-job.done:
			return job.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	job := &inflightJob{done: make(chan struct{})}
	s.inflight[out] = job
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.inflight, out)
		s.mu.Unlock()
		close(job.done)
	}()

	// Hold a process slot; a burst of imports queues here instead of
	// launching a decoder per file.
	select {
	case s.sem <- struct{}{}:
	case <-ctx.Done():
		job.err = ctx.Err()
		return job.err
	}
	defer func() { <-s.sem }()

	// Someone else may have finished it while we waited for a slot.
	if _, err := os.Stat(out); err == nil {
		return nil
	}

	runCtx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, s.exePath, args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		job.err = fmt.Errorf("%w: %v: %s", errRendererFailed, err, strings.TrimSpace(string(output)))
		return job.err
	}
	return nil
}

var (
	errNoRenderer     = fmt.Errorf("renderer executable not available")
	errRendererFailed = fmt.Errorf("renderer could not produce a result")
)

// Status codes tell the caller which thing went wrong: 403 bad path, 404 no
// file, 503 no renderer, 415 the renderer looked and could not make one.
func writeProduceError(w http.ResponseWriter, src string, err error) {
	log.Printf("[Thumbnail] %s: %v", src, err)
	switch {
	case err == errNoRenderer:
		http.Error(w, "renderer executable not available", http.StatusServiceUnavailable)
	case err == context.DeadlineExceeded || err == context.Canceled:
		http.Error(w, "renderer timed out", http.StatusGatewayTimeout)
	default:
		http.Error(w, "the renderer could not decode this file", http.StatusUnsupportedMediaType)
	}
}

// ServeHTTP is /api/thumbnail: one frame as a PNG.
func (s *ThumbnailService) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	src, info, ok := s.resolve(w, r)
	if !ok {
		return
	}
	t := 0.0
	if v := r.URL.Query().Get("t"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f >= 0 {
			t = f
		}
	}
	out := filepath.Join(s.cacheDir, cacheNameFor(src, info.Size(), info.ModTime().UnixNano(), t))
	if err := s.produce(r.Context(), out,
		"--thumbnail", src, out, "--time", strconv.FormatFloat(t, 'f', 3, 64), "--max", "256"); err != nil {
		writeProduceError(w, src, err)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeFile(w, r, out)
}

// ServeProbe is /api/probe: duration, size, frame rate and codec as JSON.
func (s *ThumbnailService) ServeProbe(w http.ResponseWriter, r *http.Request) {
	src, info, ok := s.resolve(w, r)
	if !ok {
		return
	}
	out := filepath.Join(s.cacheDir, probeNameFor(src, info.Size(), info.ModTime().UnixNano()))
	if _, err := os.Stat(out); err != nil {
		// The renderer prints the JSON; it is captured here and written to the
		// cache so the next request is a file read.
		if err := s.produceProbe(r.Context(), src, out); err != nil {
			writeProduceError(w, src, err)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeFile(w, r, out)
}

func (s *ThumbnailService) produceProbe(ctx context.Context, src, out string) error {
	// Route through produce() for the dedup and the process cap, but the
	// renderer writes to stdout rather than to a file, so capture it here.
	tmp := out + ".tmp"
	err := s.produce(ctx, out, "--probe", src)
	if err != nil {
		return err
	}
	if _, statErr := os.Stat(out); statErr == nil {
		return nil // another request finished it
	}
	runCtx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()
	output, runErr := exec.CommandContext(runCtx, s.exePath, "--probe", src).Output()
	if runErr != nil {
		return fmt.Errorf("%w: %v", errRendererFailed, runErr)
	}
	line := strings.TrimSpace(string(output))
	if !strings.HasPrefix(line, "{") {
		return fmt.Errorf("%w: unexpected output %q", errRendererFailed, line)
	}
	if err := os.WriteFile(tmp, []byte(line), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, out)
}
