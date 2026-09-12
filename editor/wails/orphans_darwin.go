//go:build darwin

package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// killOrphanProcesses terminates every process whose executable is exeBase
// and whose parent process is gone, skipping the PIDs in keep. It returns
// how many it killed.
//
// A renderer whose parent died is one an earlier editor instance launched and
// then left behind: a crash, a kill, or the Go process being restarted under
// `wails3 dev`. On macOS such a process is re-parented to launchd (PID 1).
// Renderers whose parent is still alive belong to someone, either this editor
// (tracked, and in keep) or another instance, and are left alone. Thumbnail
// and probe runs are also children of a live editor and so survive a sweep.
func killOrphanProcesses(exeBase string, keep map[uint32]bool) (int, error) {
	if exeBase == "" {
		return 0, nil
	}
	procs, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return 0, err
	}
	// p_comm holds only the first MAXCOMLEN (16) bytes of the name, so it is
	// a cheap pre-filter; the full executable path is confirmed below.
	prefix := exeBase
	if len(prefix) > 16 {
		prefix = prefix[:16]
	}
	self := int32(os.Getpid())
	killed := 0
	var errs []error
	for i := range procs {
		p := &procs[i]
		pid := p.Proc.P_pid
		if pid <= 0 || pid == self || keep[uint32(pid)] {
			continue
		}
		if unix.ByteSliceToString(p.Proc.P_comm[:]) != prefix {
			continue
		}
		ppid := p.Eproc.Ppid
		if ppid > 1 && processAlive(uint32(ppid)) {
			continue
		}
		if execBase(pid) != exeBase {
			continue
		}
		if err := unix.Kill(int(pid), unix.SIGKILL); err != nil {
			if !errors.Is(err, unix.ESRCH) {
				errs = append(errs, err)
			}
			continue
		}
		killed++
	}
	return killed, errors.Join(errs...)
}

// processAlive reports whether pid names a running process. EPERM means the
// process exists but belongs to someone else, which for this purpose is
// alive: nothing under it is ours.
func processAlive(pid uint32) bool {
	if pid == 0 {
		return false
	}
	err := unix.Kill(int(pid), 0)
	return err == nil || errors.Is(err, unix.EPERM)
}

// execBase returns the base name of the executable a process was started
// from, or "" when it cannot be read. kern.procargs2 begins with an int32
// argc followed by the NUL-terminated executable path.
func execBase(pid int32) string {
	raw, err := unix.SysctlRaw("kern.procargs2", int(pid))
	if err != nil || len(raw) < 4 {
		return ""
	}
	_ = binary.LittleEndian.Uint32(raw[:4])
	rest := raw[4:]
	end := bytes.IndexByte(rest, 0)
	if end < 0 {
		end = len(rest)
	}
	return filepath.Base(string(rest[:end]))
}
