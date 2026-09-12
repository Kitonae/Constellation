#include "platform.h"

#include <windows.h>
#include <objbase.h>
#include <mfapi.h>

void platformMediaInit() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    MFStartup(MF_VERSION);
}

void platformMediaShutdown() {
    MFShutdown();
    CoUninitialize();
}

void platformThreadInit() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
}

void platformThreadShutdown() {
    CoUninitialize();
}

std::string platformTempDir() {
    char path[MAX_PATH];
    DWORD len = GetTempPathA(MAX_PATH, path);
    if (len == 0) return ".\\";
    std::string s(path, len);
    if (s.back() != '\\' && s.back() != '/') s += '\\';
    return s;
}

void platformProcessInit() {
    // Per-monitor DPI awareness, before any window exists (see main.cpp).
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
}

void platformSleepMs(int ms) {
    Sleep((DWORD)ms);
}
