#include "platform.h"

#import <Cocoa/Cocoa.h>
#include <cstdlib>
#include <unistd.h>

// AVFoundation and ImageIO need no process-wide setup.
void platformMediaInit() {}
void platformMediaShutdown() {}
void platformThreadInit() {}
void platformThreadShutdown() {}

std::string platformTempDir() {
    // $TMPDIR is per user and is what Go's os.TempDir() returns, so the
    // renderer logs land beside the editor's SSE hub log.
    const char* t = getenv("TMPDIR");
    std::string s = (t && t[0]) ? t : "/tmp/";
    if (s.back() != '/') s += '/';
    return s;
}

void platformProcessInit() {
    @autoreleasepool {
        [NSApplication sharedApplication];
        // Accessory: no Dock icon for each screen's process and the editor
        // keeps focus when an output opens. The windows still become key
        // when clicked, which is what the F3/F4/V keys need.
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        [NSApp finishLaunching];
    }
}

void platformSleepMs(int ms) {
    usleep((useconds_t)ms * 1000);
}
