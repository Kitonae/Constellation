//go:build windows

package main

import (
	"errors"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// killOrphanProcesses terminates every process whose executable name is
// exeBase (compared case-insensitively) and whose parent process is gone,
// skipping the PIDs in keep. It returns how many it killed.
//
// A renderer whose parent died is one an earlier editor instance launched and
// then left behind: a crash, a kill, or the Go process being restarted under
// `wails3 dev`. Renderers whose parent is still alive belong to someone,
// either this editor (tracked, and in keep) or another instance, and are left
// alone. Thumbnail and probe runs are also children of a live editor and so
// survive a sweep as well.
func killOrphanProcesses(exeBase string, keep map[uint32]bool) (int, error) {
	if exeBase == "" {
		return 0, nil
	}
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(snap)

	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	if err := windows.Process32First(snap, &pe); err != nil {
		return 0, err
	}
	killed := 0
	var errs []error
	for {
		name := windows.UTF16ToString(pe.ExeFile[:])
		if strings.EqualFold(name, exeBase) && !keep[pe.ProcessID] && !processAlive(pe.ParentProcessID) {
			if err := terminateProcess(pe.ProcessID); err != nil {
				errs = append(errs, err)
			} else {
				killed++
			}
		}
		if err := windows.Process32Next(snap, &pe); err != nil {
			break
		}
	}
	return killed, errors.Join(errs...)
}

// processAlive reports whether pid names a running process. A PID that cannot
// be opened for any reason other than "no such process" is treated as alive:
// that is a process we could not have started, so nothing under it is ours.
func processAlive(pid uint32) bool {
	if pid == 0 {
		return false
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return !errors.Is(err, windows.ERROR_INVALID_PARAMETER)
	}
	defer windows.CloseHandle(h)
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return true
	}
	// STILL_ACTIVE (259) is the only code a running process reports. A PID
	// whose process has exited but whose handle table entry lingers reports
	// its real exit code here.
	return code == 259
}

func terminateProcess(pid uint32) error {
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, pid)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	return windows.TerminateProcess(h, 1)
}
