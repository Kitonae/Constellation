#include "app.h"
#include <cstdio>
#include <cstring>
#include <string>
#include <windows.h>

static void printUsage() {
    printf("Usage: constellation-renderer --port <port> --screen <screenId> --width <w> --height <h> [--host <host>]\n");
}

int main(int argc, char* argv[]) {
    AppConfig config;
    config.host = "localhost";

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) {
            config.port = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--screen") == 0 && i + 1 < argc) {
            config.screenId = argv[++i];
        } else if (strcmp(argv[i], "--width") == 0 && i + 1 < argc) {
            config.width = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--height") == 0 && i + 1 < argc) {
            config.height = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--host") == 0 && i + 1 < argc) {
            config.host = argv[++i];
        } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            printUsage();
            return 0;
        }
    }

    if (config.port <= 0) {
        fprintf(stderr, "Error: --port is required\n");
        printUsage();
        return 1;
    }

    printf("Constellation Renderer starting\n");
    printf("  Host: %s\n", config.host.c_str());
    printf("  Port: %d\n", config.port);
    printf("  Screen: %s (%dx%d)\n", config.screenId.empty() ? "(none)" : config.screenId.c_str(), config.width, config.height);

    App app;
    if (!app.init(config)) {
        fprintf(stderr, "Failed to initialize renderer\n");
        return 1;
    }

    int exitCode = app.run();
    app.shutdown();
    return exitCode;
}
