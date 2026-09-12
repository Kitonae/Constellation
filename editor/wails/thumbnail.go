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
	"time"
)

// ThumbnailService serves /api/thumbnail: one frame of a video as a PNG,
// produced by the renderer executable in its headless --thumbnail mode.
//
// The editor draws its thumbnails in the browser, which cannot decode HAP --
// the codec media servers standardise on -- nor HEVC without the codec pack.
// The renderer decodes both, so it is asked instead, and the result is cached
// on disk keyed by the file's identity so each clip is decoded once.
type ThumbnailService struct {
	exePath  string
	cacheDir string
	timeout  time.Duration
}

func NewThumbnailService(exePath string) *ThumbnailService {
	dir := filepath.Join(os.TempDir(), "constellation-thumbnails")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		log.Printf("[Thumbnail] cache dir %s: %v", dir, err)
	}
	return &ThumbnailService{exePath: exePath, cacheDir: dir, timeout: 20 * time.Second}
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

// cacheNameFor keys a thumbnail on the file's identity, not just its name:
// the same path with new contents gets a new thumbnail, and the same file
// asked at another time gets another.
func cacheNameFor(path string, size int64, modTimeNanos int64, t float64) string {
	h := sha1.New()
	fmt.Fprintf(h, "%s|%d|%d|%.3f", path, size, modTimeNanos, t)
	return hex.EncodeToString(h.Sum(nil)) + ".png"
}

func (s *ThumbnailService) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}

	src, err := localPathFromURI(r.URL.Query().Get("uri"))
	if err != nil || src == "" {
		http.Error(w, "bad or forbidden path", http.StatusForbidden)
		return
	}
	info, err := os.Stat(src)
	if err != nil || info.IsDir() {
		http.Error(w, "no such file", http.StatusNotFound)
		return
	}

	t := 0.0
	if v := r.URL.Query().Get("t"); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f >= 0 {
			t = f
		}
	}

	out := filepath.Join(s.cacheDir, cacheNameFor(src, info.Size(), info.ModTime().UnixNano(), t))

	if _, err := os.Stat(out); err != nil {
		if s.exePath == "" {
			http.Error(w, "renderer executable not configured", http.StatusServiceUnavailable)
			return
		}
		if _, err := os.Stat(s.exePath); err != nil {
			http.Error(w, "renderer executable not found", http.StatusServiceUnavailable)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), s.timeout)
		defer cancel()
		cmd := exec.CommandContext(ctx, s.exePath,
			"--thumbnail", src, out, "--time", strconv.FormatFloat(t, 'f', 3, 64), "--max", "256")
		if output, err := cmd.CombinedOutput(); err != nil {
			log.Printf("[Thumbnail] %s: %v: %s", src, err, strings.TrimSpace(string(output)))
			// 415: the renderer looked and cannot make one, which is different
			// from the file being missing or the service being down.
			http.Error(w, "the renderer could not decode a frame", http.StatusUnsupportedMediaType)
			return
		}
	}

	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeFile(w, r, out)
}
