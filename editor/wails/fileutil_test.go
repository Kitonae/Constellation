package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileService_ReadFileBase64_ValidImage(t *testing.T) {
	// Create a small PNG-like file
	tmp, err := os.CreateTemp("", "test-*.png")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmp.Name())
	tmp.Write([]byte{0x89, 0x50, 0x4E, 0x47}) // PNG magic bytes
	tmp.Close()

	fs := &FileService{}
	result, err := fs.ReadFileBase64(tmp.Name())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.HasPrefix(result, "data:image/png;base64,") {
		t.Errorf("expected data URL with image/png, got prefix %q", result[:40])
	}
}

func TestFileService_ReadFileBase64_EmptyPath(t *testing.T) {
	fs := &FileService{}
	_, err := fs.ReadFileBase64("")
	if err == nil {
		t.Error("expected error for empty path")
	}
}

func TestFileService_ReadFileBase64_NonexistentFile(t *testing.T) {
	fs := &FileService{}
	_, err := fs.ReadFileBase64(`C:\nonexistent\file.png`)
	if err == nil {
		t.Error("expected error for nonexistent file")
	}
}

func TestFileService_ReadFileBase64_TooLargeFile(t *testing.T) {
	// Create a file that exceeds maxFileBytes
	tmp, err := os.CreateTemp("", "test-large-*.bin")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmp.Name())

	// Write just enough to exceed the limit check via stat
	// We'll truncate to maxFileBytes + 1 to trigger the size check
	if err := tmp.Truncate(maxFileBytes + 1); err != nil {
		tmp.Close()
		t.Skipf("cannot create large temp file: %v", err)
		return
	}
	tmp.Close()

	fs := &FileService{}
	_, err = fs.ReadFileBase64(tmp.Name())
	if err == nil {
		t.Error("expected error for oversized file")
	}
	if !strings.Contains(err.Error(), "too large") {
		t.Errorf("expected 'too large' error, got: %v", err)
	}
}

func TestFileService_ReadFileBase64_MIMETypes(t *testing.T) {
	tests := []struct {
		ext      string
		expected string
	}{
		{".jpg", "image/jpeg"},
		{".png", "image/png"},
		{".gif", "image/gif"},
		{".webp", "image/webp"},
		{".mp4", "video/mp4"},
		{".webm", "video/webm"},
	}

	for _, tt := range tests {
		t.Run(tt.ext, func(t *testing.T) {
			tmp, err := os.CreateTemp("", "test-*"+tt.ext)
			if err != nil {
				t.Fatal(err)
			}
			defer os.Remove(tmp.Name())
			tmp.WriteString("test")
			tmp.Close()

			fs := &FileService{}
			result, err := fs.ReadFileBase64(tmp.Name())
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			expected := "data:" + tt.expected + ";base64,"
			if !strings.HasPrefix(result, expected) {
				t.Errorf("expected prefix %q, got %q", expected, result[:min(len(result), 40)])
			}
		})
	}
}

func TestFileService_ReadFileBase64_PathTraversal(t *testing.T) {
	fs := &FileService{}
	_, err := fs.ReadFileBase64(filepath.Join("..", "..", "etc", "passwd"))
	if err == nil {
		t.Error("expected error for relative path")
	}
}
