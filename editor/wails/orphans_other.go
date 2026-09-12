//go:build !windows && !darwin

package main

// The renderer ships on Windows and macOS; nowhere else has orphans to sweep.
func killOrphanProcesses(exeBase string, keep map[uint32]bool) (int, error) { return 0, nil }

func processAlive(pid uint32) bool { return false }
