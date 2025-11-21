package main

import (
	"encoding/base64"
	"mime"
	"os"
	"path/filepath"
	"strings"
)

// ReadFileBase64 reads a local file and returns a data URL (data:<mime>;base64,<data>)
// Used by the React frontend under Wails to display thumbnails for file:// URIs.
// Errors are returned as Go errors so the caller can surface/log them.
func (a *App) ReadFileBase64(path string) (string, error) {
	if path == "" {
		return "", os.ErrNotExist
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	ext := strings.ToLower(filepath.Ext(path))
	if ext != "" {
		ext = ext[1:] // drop dot
	}
	// Basic image/video mime hints
	mimeType := "application/octet-stream"
	switch ext {
	case "jpg", "jpeg":
		mimeType = "image/jpeg"
	case "png":
		mimeType = "image/png"
	case "gif":
		mimeType = "image/gif"
	case "webp":
		mimeType = "image/webp"
	case "bmp":
		mimeType = "image/bmp"
	case "mp4":
		mimeType = "video/mp4"
	case "mov":
		mimeType = "video/quicktime"
	case "webm":
		mimeType = "video/webm"
	case "mkv":
		mimeType = "video/x-matroska"
	case "avi":
		mimeType = "video/x-msvideo"
	case "m4v":
		mimeType = "video/x-m4v"
	case "mpg", "mpeg":
		mimeType = "video/mpeg"
	default:
		if mt := mime.TypeByExtension("." + ext); mt != "" {
			mimeType = mt
		}
	}
	b64 := base64.StdEncoding.EncodeToString(data)
	return "data:" + mimeType + ";base64," + b64, nil
}
