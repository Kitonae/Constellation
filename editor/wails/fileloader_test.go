package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestValidateFSPath(t *testing.T) {
	tests := []struct {
		name    string
		path    string
		wantErr bool
	}{
		{"valid windows path", `C:\Users\test\file.png`, false},
		{"valid windows path forward slash", `C:/Users/test/file.png`, false},
		// filepath.Clean resolves .. so this becomes C:\Windows\System32\cmd.exe — a valid absolute path.
		// Path traversal via /fs/ is caught because the URL path starts with /fs/../ which Clean resolves
		// to a relative path. See TestFileLoaderServeHTTP_PathTraversal for the HTTP-level test.
		{"resolved traversal is valid", `C:\Users\test\..\..\..\Windows\System32\cmd.exe`, false},
		{"UNC path", `\\server\share\file.txt`, true},
		{"relative path", `relative\path\file.txt`, true},
		{"empty path", ``, true},
		{"root only", `C:\`, false},
		{"drive letter only", `C:`, true},
		{"single dot", `.`, true},
		{"double dot", `..`, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Clean first, matching ServeHTTP behavior
			cleaned := filepath.Clean(tt.path)
			err := validateFSPath(cleaned)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateFSPath(%q) [cleaned=%q] error = %v, wantErr %v", tt.path, cleaned, err, tt.wantErr)
			}
		})
	}
}

func TestFileLoaderServeHTTP_PathTraversal(t *testing.T) {
	loader := NewFileLoader(nil)

	req := httptest.NewRequest("GET", "/fs/../../../Windows/System32/cmd.exe", nil)
	w := httptest.NewRecorder()
	loader.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", w.Code)
	}
}

func TestFileLoaderServeHTTP_UNCPath(t *testing.T) {
	loader := NewFileLoader(nil)

	req := httptest.NewRequest("GET", "/fs/\\\\server\\share\\file.txt", nil)
	w := httptest.NewRecorder()
	loader.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d", w.Code)
	}
}

func TestFileLoaderServeHTTP_ValidFile(t *testing.T) {
	// Create a temp file to serve
	tmp, err := os.CreateTemp("", "testfile-*.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmp.Name())
	tmp.WriteString("hello")
	tmp.Close()

	absPath := filepath.ToSlash(tmp.Name())
	loader := NewFileLoader(nil)

	req := httptest.NewRequest("GET", "/fs/"+absPath, nil)
	w := httptest.NewRecorder()
	loader.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestFileLoaderServeHTTP_CORS(t *testing.T) {
	loader := NewFileLoader(nil)

	req := httptest.NewRequest("OPTIONS", "/fs/C:/test.txt", nil)
	w := httptest.NewRecorder()
	loader.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200 for OPTIONS, got %d", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("expected CORS header *, got %q", got)
	}
}
