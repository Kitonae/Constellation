//go:build !windows

package main

// The renderer only ships on Windows; nowhere else has orphans to sweep.
func killOrphanProcesses(exeBase string, keep map[uint32]bool) (int, error) { return 0, nil }
