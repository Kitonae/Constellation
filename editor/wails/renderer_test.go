package main

import (
	"testing"
)

// mockBroadcaster implements Broadcaster for testing.
type mockBroadcaster struct {
	snapshots [][]byte
	times     []float64
	controls  []string
}

func (m *mockBroadcaster) BroadcastSnapshot(data []byte)                        { m.snapshots = append(m.snapshots, data) }
func (m *mockBroadcaster) BroadcastTime(t float64)                              { m.times = append(m.times, t) }
func (m *mockBroadcaster) BroadcastControl(command string)                      { m.controls = append(m.controls, command) }
func (m *mockBroadcaster) BroadcastScreenOpen(screenID string, w, h int)        {}
func (m *mockBroadcaster) BroadcastScreenClose(screenID string)                 {}

func TestRendererManager_GetStatus_UnknownScreen(t *testing.T) {
	hub := &mockBroadcaster{}
	rm := NewRendererManager(hub)

	status := rm.GetStatus("nonexistent")
	if status.State != "stopped" {
		t.Errorf("expected 'stopped' for unknown screen, got %q", status.State)
	}
	if status.ScreenID != "nonexistent" {
		t.Errorf("expected screenID 'nonexistent', got %q", status.ScreenID)
	}
}

func TestRendererManager_UpdateStatus(t *testing.T) {
	hub := &mockBroadcaster{}
	rm := NewRendererManager(hub)

	// Manually add a proc to update
	rm.mu.Lock()
	rm.procs["test-screen"] = &rendererProc{
		screenID: "test-screen",
		status: RendererStatus{
			ScreenID: "test-screen",
			State:    "launching",
		},
	}
	rm.mu.Unlock()

	rm.UpdateStatus(RendererStatus{
		ScreenID: "test-screen",
		State:    "ready",
		FPS:      60.0,
	})

	status := rm.GetStatus("test-screen")
	if status.State != "ready" {
		t.Errorf("expected 'ready', got %q", status.State)
	}
	if status.FPS != 60.0 {
		t.Errorf("expected FPS 60, got %f", status.FPS)
	}
}

func TestRendererManager_UpdateStatus_NonexistentScreen(t *testing.T) {
	hub := &mockBroadcaster{}
	rm := NewRendererManager(hub)

	// Should not panic
	rm.UpdateStatus(RendererStatus{
		ScreenID: "does-not-exist",
		State:    "ready",
	})

	status := rm.GetStatus("does-not-exist")
	if status.State != "stopped" {
		t.Errorf("expected 'stopped' for nonexistent screen, got %q", status.State)
	}
}

func TestRendererManager_StopRenderer_UnknownScreen(t *testing.T) {
	hub := &mockBroadcaster{}
	rm := NewRendererManager(hub)

	err := rm.StopRenderer("nonexistent")
	if err != nil {
		t.Errorf("expected nil error for stopping unknown screen, got %v", err)
	}
}

func TestRendererManager_LaunchRenderer_BadExe(t *testing.T) {
	hub := &mockBroadcaster{}
	rm := &RendererManager{
		procs:   make(map[string]*rendererProc),
		hub:     hub,
		exePath: "nonexistent-renderer.exe",
	}

	err := rm.LaunchRenderer("test-screen", 8080, 1920, 1080)
	if err == nil {
		t.Error("expected error for nonexistent executable")
	}
}

func TestRendererManager_ShutdownAll(t *testing.T) {
	hub := &mockBroadcaster{}
	rm := NewRendererManager(hub)

	// Add some mock procs
	rm.mu.Lock()
	rm.procs["screen-1"] = &rendererProc{screenID: "screen-1", status: RendererStatus{State: "ready"}}
	rm.procs["screen-2"] = &rendererProc{screenID: "screen-2", status: RendererStatus{State: "launching"}}
	rm.mu.Unlock()

	rm.ShutdownAll()

	rm.mu.Lock()
	count := len(rm.procs)
	rm.mu.Unlock()

	if count != 0 {
		t.Errorf("expected 0 procs after shutdown, got %d", count)
	}
}

func TestValidateScreenID(t *testing.T) {
	tests := []struct {
		name    string
		id      string
		wantErr bool
	}{
		{"valid simple", "screen1", false},
		{"valid with hyphens", "screen-1", false},
		{"valid with underscores", "screen_1", false},
		{"valid mixed", "Screen-1_test", false},
		{"empty", "", true},
		{"too long", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", true}, // 65 chars
		{"special chars", "screen;rm -rf", true},
		{"spaces", "screen 1", true},
		{"dots", "screen.1", true},
		{"slashes", "screen/1", true},
		{"backslashes", `screen\1`, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateScreenID(tt.id)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateScreenID(%q) error = %v, wantErr %v", tt.id, err, tt.wantErr)
			}
		})
	}
}
