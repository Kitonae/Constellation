package main

import (
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"path/filepath"
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

// validateFSPath checks that a cleaned filesystem path is safe to serve.
// Rejects traversal attempts, UNC paths, and relative paths.
func validateFSPath(path string) error {
	// Reject UNC paths (\\server\share)
	if strings.HasPrefix(path, `\\`) {
		return fmt.Errorf("UNC paths not allowed")
	}
	// Require absolute path with drive letter on Windows (e.g. C:\...)
	if len(path) < 3 || path[1] != ':' || (path[2] != '\\' && path[2] != '/') {
		return fmt.Errorf("path must be absolute with drive letter")
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

		// Handle Windows drive letters: /C:/... -> C:/...
		if len(path) > 2 && path[0] == '/' && path[2] == ':' {
			path = path[1:]
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
