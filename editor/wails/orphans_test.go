package main

import (
	"os"
	"os/exec"
	"runtime"
	"testing"
	"time"
)

func TestKillOrphanProcesses_NoMatchKillsNothing(t *testing.T) {
	killed, err := killOrphanProcesses("constellation-no-such-renderer-zz.exe", nil)
	if err != nil {
		t.Fatalf("sweep failed: %v", err)
	}
	if killed != 0 {
		t.Fatalf("killed %d processes that cannot exist", killed)
	}
}

func TestKillOrphanProcesses_EmptyNameIsANoOp(t *testing.T) {
	// A manager with no executable must never turn into "kill everything".
	if killed, _ := killOrphanProcesses("", nil); killed != 0 {
		t.Fatalf("killed %d", killed)
	}
}

func TestProcessAlive(t *testing.T) {
	if runtime.GOOS != "windows" && runtime.GOOS != "darwin" {
		t.Skip("no orphan sweep on this platform")
	}
	if !processAlive(uint32(os.Getpid())) {
		t.Error("the test process itself reported dead")
	}
	if processAlive(0) {
		t.Error("PID 0 reported alive")
	}
}

func TestSSEHub_CloseAllScreensForgetsEveryScreen(t *testing.T) {
	hub := NewSSEHub()
	hub.SendScreenOpen("screen-1", 1280, 720)
	hub.SendScreenOpen("screen-2", 1920, 1080)
	hub.CloseAllScreens()

	hub.mu.Lock()
	n := len(hub.openScreens)
	hub.mu.Unlock()
	if n != 0 {
		t.Errorf("%d screens would still be replayed to the next renderer", n)
	}
}

// A real orphan: a copy of ping.exe under a unique name, started through
// `cmd /c start` so that its parent (that cmd.exe) has exited by the time
// the sweep runs. The sweep must find it by name and kill it.
func TestKillOrphanProcesses_KillsAParentlessProcess(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("windows only")
	}
	src := `C:\Windows\System32\PING.EXE`
	data, err := os.ReadFile(src)
	if err != nil {
		t.Skip("no ping.exe")
	}
	dir := t.TempDir()
	name := "constellation-orphan-test-renderer.exe"
	exe := dir + `\` + name
	if err := os.WriteFile(exe, data, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("cmd.exe", "/c", "start", "/b", "", exe, "-n", "60", "127.0.0.1")
	if err := cmd.Run(); err != nil {
		t.Fatalf("spawn: %v", err)
	}
	// cmd.exe has returned, so the ping copy is now parentless.
	deadline := time.Now().Add(5 * time.Second)
	for {
		killed, err := killOrphanProcesses(name, nil)
		if err != nil {
			t.Fatalf("sweep: %v", err)
		}
		if killed == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("orphan never found (killed=%d)", killed)
		}
		time.Sleep(50 * time.Millisecond)
	}
	// Give the kill a moment, then a second sweep must find nothing.
	time.Sleep(200 * time.Millisecond)
	if killed, _ := killOrphanProcesses(name, nil); killed != 0 {
		t.Errorf("second sweep killed %d", killed)
	}
}

// TestOrphanSleeper is not a test: it is the body of the orphan that
// TestKillOrphanProcesses_KillsAParentlessProcessDarwin spawns. A copy of
// /bin/sleep cannot be used there as it is on Windows, because macOS refuses
// to run platform binaries from anywhere but their own path; the test binary
// itself, copied under the renderer's name, runs fine.
func TestOrphanSleeper(t *testing.T) {
	if os.Getenv("CONSTELLATION_ORPHAN_SLEEPER") == "" {
		t.Skip("only meaningful as a spawned orphan")
	}
	time.Sleep(60 * time.Second)
}

// The macOS twin: this test binary under a unique name, started through
// `sh -c 'nohup ... &'` so that its parent (that sh) has exited and the copy
// has been re-parented to launchd by the time the sweep runs.
func TestKillOrphanProcesses_KillsAParentlessProcessDarwin(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("darwin only")
	}
	self, err := os.Executable()
	if err != nil {
		t.Skip("no test executable path")
	}
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	name := "constellation-orphan-test-renderer"
	exe := dir + "/" + name
	if err := os.WriteFile(exe, data, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("/bin/sh", "-c",
		`CONSTELLATION_ORPHAN_SLEEPER=1 nohup "$0" -test.run='^TestOrphanSleeper$' >/dev/null 2>&1 &`, exe)
	if err := cmd.Run(); err != nil {
		t.Fatalf("spawn: %v", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		killed, err := killOrphanProcesses(name, nil)
		if err != nil {
			t.Fatalf("sweep: %v", err)
		}
		if killed == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("orphan never found (killed=%d)", killed)
		}
		time.Sleep(50 * time.Millisecond)
	}
	time.Sleep(200 * time.Millisecond)
	if killed, _ := killOrphanProcesses(name, nil); killed != 0 {
		t.Errorf("second sweep killed %d", killed)
	}
}
