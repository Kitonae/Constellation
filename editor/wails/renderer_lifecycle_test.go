package main

import (
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

// A real executable that exits at once, so LaunchRenderer can be exercised
// without a renderer. cmd.exe rejects the arguments and returns; elsewhere
// /usr/bin/true ignores them.
func stubRendererExe(t *testing.T) string {
	t.Helper()
	exe := "/usr/bin/true"
	if runtime.GOOS == "windows" {
		exe = os.Getenv("ComSpec")
		if exe == "" {
			exe = `C:\Windows\System32\cmd.exe`
		}
	}
	if _, err := os.Stat(exe); err != nil {
		t.Skipf("no stand-in renderer at %s", exe)
	}
	return exe
}

func TestLaunchRenderer_RestartsALiveProcess(t *testing.T) {
	rm := &RendererManager{procs: make(map[string]*rendererProc), hub: &mockBroadcaster{}, exePath: stubRendererExe(t)}
	defer rm.ShutdownAll()

	if err := rm.LaunchRenderer("s1", 1, 100, 100); err != nil {
		t.Fatal(err)
	}
	first := rm.procs["s1"]
	// Mark it live regardless of how fast the stub exits: the point is the
	// manager's answer to a second launch for a screen it believes is running.
	rm.mu.Lock()
	first.status.State = "ready"
	rm.mu.Unlock()

	if err := rm.LaunchRenderer("s1", 1, 100, 100); err != nil {
		t.Fatalf("relaunch must restart, not refuse: %v", err)
	}
	second := rm.procs["s1"]
	if second == first {
		t.Fatal("relaunch kept the old process record")
	}
	if second.cmd.Process.Pid == first.cmd.Process.Pid {
		t.Error("relaunch did not start a new process")
	}
}

func TestLaunchRenderer_OneAudioOwner(t *testing.T) {
	rm := &RendererManager{procs: make(map[string]*rendererProc), hub: &mockBroadcaster{}, exePath: stubRendererExe(t)}
	defer rm.ShutdownAll()

	if err := rm.LaunchRenderer("a", 1, 100, 100); err != nil {
		t.Fatal(err)
	}
	rm.mu.Lock()
	rm.procs["a"].status.State = "ready"
	rm.mu.Unlock()

	if err := rm.LaunchRenderer("b", 1, 100, 100); err != nil {
		t.Fatal(err)
	}
	if !rm.procs["a"].audio {
		t.Error("the first screen must own the audio")
	}
	if rm.procs["b"].audio {
		t.Error("a second screen must not also play the audio")
	}
	found := false
	for _, arg := range rm.procs["b"].cmd.Args {
		if arg == "--no-audio" {
			found = true
		}
	}
	if !found {
		t.Error("the second process was not told to stay silent")
	}

	// When the owner goes away, the next launch takes the audio over.
	if err := rm.StopRenderer("a"); err != nil {
		t.Fatal(err)
	}
	if err := rm.LaunchRenderer("c", 1, 100, 100); err != nil {
		t.Fatal(err)
	}
	// b is not marked live (the stub has exited and its watcher may have
	// recorded that), so c may or may not inherit; what must hold is that at
	// most one live process owns the audio.
	owners := 0
	rm.mu.Lock()
	for _, p := range rm.procs {
		if p.live() && p.audio {
			owners++
		}
	}
	rm.mu.Unlock()
	if owners > 1 {
		t.Errorf("%d live audio owners, want at most one", owners)
	}
	// Give the stub processes a moment to exit before ShutdownAll.
	time.Sleep(50 * time.Millisecond)
}

func TestLaunchRendererAt_PassesPlacementOnTheCommandLine(t *testing.T) {
	rm := &RendererManager{procs: map[string]*rendererProc{}, hub: &mockBroadcaster{}, exePath: stubRendererExe(t)}
	defer rm.ShutdownAll()

	p := ScreenPlacement{Width: 1920, Height: 1080, Positioned: true, X: 2560, Y: 0, Borderless: true}
	if err := rm.LaunchRendererAt("s1", 1, p); err != nil {
		t.Fatal(err)
	}
	rm.mu.Lock()
	args := rm.procs["s1"].cmd.Args
	rm.mu.Unlock()
	joined := strings.Join(args, " ")
	for _, want := range []string{"--x 2560", "--y 0", "--borderless"} {
		if !strings.Contains(joined, want) {
			t.Errorf("command line is missing %q: %s", want, joined)
		}
	}
}
