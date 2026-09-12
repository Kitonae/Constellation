package main

import (
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"path/filepath"
	"runtime"
	"strings"
)

type FileLoader struct {
	assets fs.FS
}

func NewFileLoader(assets fs.FS) *FileLoader {
	return &FileLoader{
		assets: assets,
	}
}

// hasDotDotSegment reports whether any slash- or backslash-separated
// component of path is "..".
func hasDotDotSegment(path string) bool {
	for _, part := range strings.FieldsFunc(path, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == ".." {
			return true
		}
	}
	return false
}

// hasDriveLetter reports whether path starts like C:\ or C:/.
func hasDriveLetter(path string) bool {
	return len(path) >= 3 && path[1] == ':' && (path[2] == '\\' || path[2] == '/')
}

// validateFSPath checks that a cleaned filesystem path is safe to serve.
// Rejects traversal attempts, UNC paths, and relative paths.
func validateFSPath(path string) error {
	// Reject UNC paths (\\server\share)
	if strings.HasPrefix(path, `\\`) {
		return fmt.Errorf("UNC paths not allowed")
	}
	// Windows needs a drive letter (C:\...). Elsewhere a rooted POSIX path
	// is the absolute form; the drive-letter rule alone refused every file
	// on macOS.
	if !hasDriveLetter(path) {
		if runtime.GOOS == "windows" || !filepath.IsAbs(path) {
			return fmt.Errorf("path must be absolute")
		}
	}
	// Reject any remaining .. components after filepath.Clean
	for _, part := range strings.Split(path, string(filepath.Separator)) {
		if part == ".." {
			return fmt.Errorf("path traversal not allowed")
		}
	}
	return nil
}

func (h *FileLoader) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setCORS(w, r)
	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	if strings.HasPrefix(r.URL.Path, "/fs/") {
		// net/http has already decoded the path once. Decoding it again
		// turned a legal "100% done.png" into a 400, because the second pass
		// read "% d" as an escape.
		path := r.URL.Path[4:]

		// Traversal and UNC are refused on the request as written, before
		// any rooting or cleaning can turn them into something that looks
		// legitimate.
		if strings.HasPrefix(path, `\\`) || hasDotDotSegment(path) {
			log.Printf("Rejected file path %q: traversal or UNC", path)
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}

		// Handle Windows drive letters: /C:/... -> C:/...
		if len(path) > 2 && path[0] == '/' && path[2] == ':' {
			path = path[1:]
		} else if runtime.GOOS != "windows" && !strings.HasPrefix(path, "/") {
			// The editor writes /fs/Users/x for /Users/x, and the mux
			// collapses a doubled slash anyway; every POSIX path is rooted.
			path = "/" + path
		}

		// Clean path to use native separators (e.g. \ on Windows)
		path = filepath.Clean(path)

		if err := validateFSPath(path); err != nil {
			log.Printf("Rejected file path %q: %v", path, err)
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}

		log.Printf("Serving file: %s", path)
		http.ServeFile(w, r, path)
		return
	}

	if h.assets != nil {
		http.FileServer(http.FS(h.assets)).ServeHTTP(w, r)
		return
	}

	w.WriteHeader(http.StatusNotFound)
}
