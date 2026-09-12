#pragma once
// Process- and thread-level platform setup that the shared code has to call
// but must not know the details of.

#include <string>

// Once per process, before any media API is used: COM and Media Foundation on
// Windows; nothing on macOS.
void platformMediaInit();
void platformMediaShutdown();

// Once per worker thread that uses media APIs (COM apartment on Windows).
void platformThreadInit();
void platformThreadShutdown();

// Where log files go: %TEMP% or $TMPDIR, with a trailing separator.
std::string platformTempDir();

// Per-process setup that has to happen before any window exists (DPI
// awareness on Windows, NSApplication on macOS).
void platformProcessInit();

void platformSleepMs(int ms);
