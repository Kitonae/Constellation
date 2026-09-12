package main

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"regexp"
)

// The sidecar listens on loopback, but loopback is not an authorization
// boundary: any process on the machine, and any page in any browser that can
// name the port, could read local files through /fs/ or stream the show
// through /sse/. Each session mints a token that the editor learns through a
// Wails binding and every renderer receives on its command line; requests
// without it are refused before any handler sees the path.

const tokenHeader = "X-Constellation-Token"

// newSessionToken is 128 bits of randomness, hex-encoded so it can travel in
// a query string without escaping.
func newSessionToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic("session token: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// tokenFromRequest reads the token from the header, or from the query for
// media elements and event streams that cannot set headers.
func tokenFromRequest(r *http.Request) string {
	if t := r.Header.Get(tokenHeader); t != "" {
		return t
	}
	return r.URL.Query().Get("token")
}

// requireToken refuses requests that do not present the session token.
//
// An empty configured token fails closed: a server that has no token would
// otherwise accept everything, which is the state this exists to remove.
func requireToken(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setCORS(w, r)
		// A preflight carries no credentials by design; answering it grants
		// nothing, the real request is still checked.
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		if token == "" {
			http.Error(w, "sidecar session token not configured", http.StatusServiceUnavailable)
			return
		}
		got := tokenFromRequest(r)
		if subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
			http.Error(w, "missing or invalid session token", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Origins the editor and its output windows are served from: the Wails
// webview scheme, the Vite dev server, and the sidecar itself.
var loopbackOrigin = regexp.MustCompile(`^https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$`)

func originAllowed(origin string) bool {
	switch origin {
	case "http://wails.localhost", "https://wails.localhost", "wails://wails", "wails://localhost":
		return true
	}
	return loopbackOrigin.MatchString(origin)
}

// setCORS echoes an allowed origin back, and says nothing to any other.
// Requests without an Origin -- the renderer, curl -- need no CORS at all.
func setCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" || !originAllowed(origin) {
		return
	}
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", origin)
	h.Add("Vary", "Origin")
	h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	h.Set("Access-Control-Allow-Headers", tokenHeader+", Content-Type")
}
