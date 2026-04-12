package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSSEHub_BroadcastSnapshot_CachesLast(t *testing.T) {
	hub := NewSSEHub()
	hub.BroadcastSnapshot([]byte(`{"test":"data"}`))

	hub.mu.Lock()
	got := string(hub.lastSnapshot)
	hub.mu.Unlock()

	if got != `{"test":"data"}` {
		t.Errorf("expected cached snapshot, got %q", got)
	}
}

func TestSSEHub_NewClientReceivesCachedSnapshot(t *testing.T) {
	hub := NewSSEHub()
	hub.BroadcastSnapshot([]byte(`{"cached":true}`))

	// Create a test server with the hub
	srv := httptest.NewServer(hub)
	defer srv.Close()

	// Make a request and read the first event
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.Header.Get("Content-Type") != "text/event-stream" {
		t.Errorf("expected text/event-stream, got %q", resp.Header.Get("Content-Type"))
	}

	// Read enough to see the snapshot
	buf := make([]byte, 4096)
	n, _ := resp.Body.Read(buf)
	body := string(buf[:n])

	if !strings.Contains(body, `event: snapshot`) {
		t.Errorf("expected snapshot event, got %q", body)
	}
	if !strings.Contains(body, `{"cached":true}`) {
		t.Errorf("expected cached data in body, got %q", body)
	}
}

func TestSSEHub_BroadcastToClients(t *testing.T) {
	hub := NewSSEHub()

	// Add a test client
	client := &SSEClient{ch: make(chan []byte, 64), timeCh: make(chan []byte, 1)}
	hub.mu.Lock()
	hub.clients[client] = struct{}{}
	hub.mu.Unlock()

	hub.BroadcastTime(1.5)

	select {
	case msg := <-client.timeCh:
		if !strings.Contains(string(msg), "event: time") {
			t.Errorf("expected time event, got %q", msg)
		}
		if !strings.Contains(string(msg), "1.5") {
			t.Errorf("expected time value 1.5, got %q", msg)
		}
	case <-time.After(time.Second):
		t.Error("timed out waiting for broadcast")
	}
}

func TestSSEHub_DropsMessageWhenBufferFull(t *testing.T) {
	hub := NewSSEHub()

	// Add a client with a tiny buffer
	client := &SSEClient{ch: make(chan []byte, 1)}
	hub.mu.Lock()
	hub.clients[client] = struct{}{}
	hub.mu.Unlock()

	// Fill the buffer
	hub.BroadcastControl("play")
	// This should be dropped, not block
	hub.BroadcastControl("pause")

	// Should get the first message
	select {
	case msg := <-client.ch:
		if !strings.Contains(string(msg), "play") {
			t.Errorf("expected play, got %q", msg)
		}
	default:
		t.Error("expected at least one message")
	}
}

func TestSSEHub_ClientDisconnectRemovesClient(t *testing.T) {
	hub := NewSSEHub()
	hub.BroadcastSnapshot([]byte(`{"test":true}`)) // so client gets data immediately

	srv := httptest.NewServer(hub)
	defer srv.Close()

	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}

	// Read the initial snapshot so the connection is established
	buf := make([]byte, 4096)
	resp.Body.Read(buf)

	hub.mu.Lock()
	countBefore := len(hub.clients)
	hub.mu.Unlock()

	if countBefore != 1 {
		t.Errorf("expected 1 client, got %d", countBefore)
	}

	// Close the connection
	resp.Body.Close()

	// Wait for cleanup
	time.Sleep(200 * time.Millisecond)

	hub.mu.Lock()
	countAfter := len(hub.clients)
	hub.mu.Unlock()

	if countAfter != 0 {
		t.Errorf("expected 0 clients after disconnect, got %d", countAfter)
	}
}
