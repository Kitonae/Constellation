package main

import (
	"log"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
)

type FileLoader struct{}

func NewFileLoader() *FileLoader {
	return &FileLoader{}
}

func (h *FileLoader) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// CORS for dev mode sidecar
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusOK)
		return
	}

	if strings.HasPrefix(r.URL.Path, "/fs/") {
		rawPath := r.URL.Path[4:]
		// Unescape path to handle spaces and special characters
		path, err := url.PathUnescape(rawPath)
		if err != nil {
			log.Printf("Error unescaping path %s: %v", rawPath, err)
			http.Error(w, "Invalid path", http.StatusBadRequest)
			return
		}

		// Handle Windows drive letters: /C:/... -> C:/...
		if len(path) > 2 && path[0] == '/' && path[2] == ':' {
			path = path[1:]
		}

		// Clean path to use native separators (e.g. \ on Windows)
		path = filepath.Clean(path)

		log.Printf("Serving file: %s", path)
		http.ServeFile(w, r, path)
		return
	}
	w.WriteHeader(http.StatusNotFound)
}
