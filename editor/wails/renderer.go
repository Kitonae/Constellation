package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
)

// RendererStatus is returned to the frontend via Wails binding.
type RendererStatus struct {
	ScreenID string  `json:"screenId"`
	State    string  `json:"state"` // "launching", "ready", "error", "stopped"
	FPS      float64 `json:"fps"`
	Error    string  `json:"error,omitempty"`
	PID      int     `json:"pid"`
}

// rendererProc tracks one running renderer process.
type rendererProc struct {
	cmd      *exec.Cmd
	screenID string
	cancel   context.CancelFunc
	status   RendererStatus
}

// RendererManager owns all renderer processes and the SSE hub.
type RendererManager struct {
	mu      sync.Mutex
	procs   map[string]*rendererProc
	hub     Broadcaster
	exePath string
	token   string // handed to each renderer for its sidecar requests
}

// SetToken records the session token renderers must present to the sidecar.
func (rm *RendererManager) SetToken(token string) {
	rm.mu.Lock()
	defer rm.mu.Unlock()
	rm.token = token
}

// NewRendererManager creates a new renderer manager.
// ExePath is where the renderer executable was found, for callers that run
// it in modes other than a live output (thumbnails).
func (rm *RendererManager) ExePath() string { return rm.exePath }

func NewRendererManager(hub Broadcaster) *RendererManager {
	exe := resolveRendererExe()
	return &RendererManager{
		procs:   make(map[string]*rendererProc),
		hub:     hub,
		exePath: exe,
	}
}

// resolveRendererExe finds the renderer executable.
// Checks multiple locations: next to the editor binary (production),
// and common dev build paths relative to the working directory.
func resolveRendererExe() string {
	candidates := []string{}

	// 1. Next to the running binary (production layout)
	if self, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(self), "constellation-renderer.exe"))
	}

	// 2. Dev build paths relative to working directory
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(wd, "..", "renderer", "build", "Release", "constellation-renderer.exe"),
			filepath.Join(wd, "..", "renderer", "build", "Debug", "constellation-renderer.exe"),
			filepath.Join(wd, "build", "bin", "constellation-renderer.exe"),
		)
	}

	// 3. Common absolute dev path
	candidates = append(candidates,
		`C:\src\Constellation\editor\renderer\build\Release\constellation-renderer.exe`,
	)

	for _, c := range candidates {
		if abs, err := filepath.Abs(c); err == nil {
			if _, err := os.Stat(abs); err == nil {
				log.Printf("Renderer executable found at %s", abs)
				return abs
			}
		}
	}

	log.Printf("Warning: renderer executable not found in any known location")
	return "constellation-renderer.exe"
}

// LaunchRenderer starts a renderer process for the given screen.
func (rm *RendererManager) LaunchRenderer(screenID string, serverPort, width, height int) error {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	if p, ok := rm.procs[screenID]; ok {
		if p.cmd != nil && p.cmd.Process != nil && p.status.State != "stopped" {
			return fmt.Errorf("renderer already running for screen %s (PID %d)", screenID, p.cmd.Process.Pid)
		}
	}

	// Check if executable exists
	if _, err := os.Stat(rm.exePath); os.IsNotExist(err) {
		log.Printf("Renderer executable not found at %s", rm.exePath)
		return fmt.Errorf("renderer executable not found: %s", rm.exePath)
	}

	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, rm.exePath,
		"--port", fmt.Sprintf("%d", serverPort),
		"--screen", screenID,
		"--width", fmt.Sprintf("%d", width),
		"--height", fmt.Sprintf("%d", height),
		"--token", rm.token,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		cancel()
		return fmt.Errorf("failed to start renderer: %w", err)
	}

	rp := &rendererProc{
		cmd:      cmd,
		screenID: screenID,
		cancel:   cancel,
		status: RendererStatus{
			ScreenID: screenID,
			State:    "launching",
			PID:      cmd.Process.Pid,
		},
	}
	rm.procs[screenID] = rp
	log.Printf("Launched renderer for screen %s (PID %d)", screenID, cmd.Process.Pid)

	// Watch for process exit
	go func() {
		err := cmd.Wait()
		rm.mu.Lock()
		defer rm.mu.Unlock()
		if p, ok := rm.procs[screenID]; ok && p == rp {
			p.status.State = "stopped"
			if err != nil {
				p.status.Error = err.Error()
				log.Printf("Renderer for screen %s exited with error: %v", screenID, err)
			} else {
				log.Printf("Renderer for screen %s exited cleanly", screenID)
			}
		}
	}()

	return nil
}

// StopRenderer stops the renderer process for a screen.
func (rm *RendererManager) StopRenderer(screenID string) error {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	p, ok := rm.procs[screenID]
	if !ok {
		return nil
	}

	if p.cancel != nil {
		p.cancel()
	}
	delete(rm.procs, screenID)
	log.Printf("Stopped renderer for screen %s", screenID)
	return nil
}

// ShutdownAll stops all renderer processes.
func (rm *RendererManager) ShutdownAll() {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	for id, p := range rm.procs {
		if p.cancel != nil {
			p.cancel()
		}
		log.Printf("Shutdown: stopped renderer for screen %s", id)
	}
	rm.procs = make(map[string]*rendererProc)
}

// GetStatus returns the status of a renderer for a given screen.
func (rm *RendererManager) GetStatus(screenID string) RendererStatus {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	if p, ok := rm.procs[screenID]; ok {
		return p.status
	}
	return RendererStatus{ScreenID: screenID, State: "stopped"}
}

// UpdateStatus updates the status of a renderer (called from status POST handler).
func (rm *RendererManager) UpdateStatus(status RendererStatus) {
	rm.mu.Lock()
	defer rm.mu.Unlock()

	if p, ok := rm.procs[status.ScreenID]; ok {
		if status.State != "" {
			p.status.State = status.State
		}
		if status.FPS > 0 {
			p.status.FPS = status.FPS
		}
		if status.Error != "" {
			p.status.Error = status.Error
		}
	}
}
