package main

import (
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"os"
	"path/filepath"
	"strings"
)

const maxFileBytes = 50 * 1024 * 1024 // 50 MB cap for base64 encoding

// FileService handles file reading and base64 encoding.
type FileService struct{}

// ReadFileBase64 reads a local file and returns a data URL (data:<mime>;base64,<data>).
func (fs *FileService) ReadFileBase64(path string) (string, error) {
	if path == "" {
		return "", os.ErrNotExist
	}

	cleaned := filepath.Clean(path)
	if err := validateFSPath(cleaned); err != nil {
		return "", fmt.Errorf("invalid path: %w", err)
	}

	f, err := os.Open(cleaned)
	if err != nil {
		return "", fmt.Errorf("open file: %w", err)
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return "", fmt.Errorf("stat file: %w", err)
	}
	if info.Size() > maxFileBytes {
		return "", fmt.Errorf("file too large for base64 encoding (%d bytes, max %d)", info.Size(), maxFileBytes)
	}

	data, err := io.ReadAll(f)
	if err != nil {
		return "", fmt.Errorf("read file: %w", err)
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
	case "gltf":
		mimeType = "model/gltf+json"
	case "glb":
		mimeType = "model/gltf-binary"
	case "obj":
		mimeType = "text/plain"
	case "stl":
		mimeType = "model/stl"
	default:
		if mt := mime.TypeByExtension("." + ext); mt != "" {
			mimeType = mt
		}
	}
	b64 := base64.StdEncoding.EncodeToString(data)
	return "data:" + mimeType + ";base64," + b64, nil
}
