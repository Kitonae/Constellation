package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
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
	wg      sync.WaitGroup // tracks exit-watcher goroutines
	procs   map[string]*rendererProc
	hub     Broadcaster
	exePath string
	appCtx  context.Context // app lifecycle context
}

// NewRendererManager creates a new renderer manager.
// The appCtx is the Wails app context — child processes are derived from it
// so they are cancelled when the app shuts down.
func NewRendererManager(hub Broadcaster, appCtx context.Context) *RendererManager {
	exe := resolveRendererExe()
	return &RendererManager{
		procs:  make(map[string]*rendererProc),
		hub:    hub,
		exePath: exe,
		appCtx: appCtx,
	}
}

// resolveRendererExe finds the renderer executable.
// Checks multiple locations: next to the editor binary (production),
// and common dev build paths relative to the working directory.
func resolveRendererExe() string {
	candidates := []string{}

	// 0. Explicit override via environment variable
	if env := os.Getenv("CONSTELLATION_RENDERER"); env != "" {
		candidates = append(candidates, env)
	}

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

		// 3. Sibling repo checkout (e.g. working from a refactor branch copy)
		parent := filepath.Dir(filepath.Dir(filepath.Dir(wd))) // up from editor/wails to repo root, then parent
		candidates = append(candidates,
			filepath.Join(parent, "Constellation", "editor", "renderer", "build", "Release", "constellation-renderer.exe"),
			filepath.Join(parent, "Constellation", "editor", "renderer", "build", "Debug", "constellation-renderer.exe"),
		)
	}

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

	// If a previous process exists and hasn't stopped, reject.
	// If it's stopped (exited), clean it up and allow relaunch.
	if p, ok := rm.procs[screenID]; ok {
		if p.cmd != nil && p.cmd.Process != nil && p.status.State != "stopped" {
			return fmt.Errorf("renderer already running for screen %s (PID %d)", screenID, p.cmd.Process.Pid)
		}
		// Clean up stale entry
		delete(rm.procs, screenID)
	}

	// Check if executable exists
	if _, err := os.Stat(rm.exePath); os.IsNotExist(err) {
		log.Printf("Renderer executable not found at %s", rm.exePath)
		return fmt.Errorf("renderer executable not found: %s", rm.exePath)
	}

	// Derive from app context so child processes are cancelled on app shutdown
	ctx, cancel := context.WithCancel(rm.appCtx)
	cmd := exec.CommandContext(ctx, rm.exePath,
		"--port", fmt.Sprintf("%d", serverPort),
		"--screen", screenID,
		"--width", fmt.Sprintf("%d", width),
		"--height", fmt.Sprintf("%d", height),
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		cancel()
		return fmt.Errorf("failed to start renderer: %w", err)
	}

	// Only add to map after successful Start()
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
	rm.wg.Add(1)
	go func() {
		defer rm.wg.Done()
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
// Waits briefly for the process to exit before returning.
func (rm *RendererManager) StopRenderer(screenID string) error {
	rm.mu.Lock()
	p, ok := rm.procs[screenID]
	if !ok {
		rm.mu.Unlock()
		return nil
	}

	if p.cancel != nil {
		p.cancel()
	}
	rm.mu.Unlock()

	// Wait briefly for the process to exit (the exit watcher will update state).
	// Don't hold the lock while waiting.
	if p.cmd != nil && p.cmd.Process != nil {
		done := make(chan struct{})
		go func() {
			p.cmd.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			log.Printf("Renderer for screen %s did not exit within 3s after cancel", screenID)
		}
	}

	rm.mu.Lock()
	delete(rm.procs, screenID)
	rm.mu.Unlock()
	log.Printf("Stopped renderer for screen %s", screenID)
	return nil
}

// ShutdownAll stops all renderer processes and waits for exit watchers.
func (rm *RendererManager) ShutdownAll() {
	rm.mu.Lock()
	for id, p := range rm.procs {
		if p.cancel != nil {
			p.cancel()
		}
		log.Printf("Shutdown: stopping renderer for screen %s", id)
	}
	rm.procs = make(map[string]*rendererProc)
	rm.mu.Unlock()

	// Wait for all exit-watcher goroutines to finish (with timeout)
	done := make(chan struct{})
	go func() {
		rm.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		log.Printf("All renderer processes exited")
	case <-time.After(5 * time.Second):
		log.Printf("Warning: timed out waiting for renderer processes to exit")
	}
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
