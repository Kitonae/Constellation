#include "app.h"
#include "platform.h"
#include "thumbnail.h"
#include <cstdio>
#include <cstring>
#include <string>
#ifdef _WIN32
#include <io.h>
#else
#include <unistd.h>
#endif

static std::string LOG_PATH;

static void initLogFile(const char* screenId) {
    // Write logs to <temp>/constellation-renderer-<screenId>.log: %TEMP% on
    // Windows, $TMPDIR on macOS, which is also where the editor's own
    // os.TempDir() puts the SSE hub log.
    std::string path = platformTempDir() + "constellation-renderer-" +
        (screenId && screenId[0] ? screenId : "default") + ".log";

    FILE* f = freopen(path.c_str(), "w", stdout);
    if (f) {
        // Redirect stderr to same file
#ifdef _WIN32
        _dup2(_fileno(stdout), _fileno(stderr));
#else
        dup2(fileno(stdout), fileno(stderr));
#endif
        // Disable buffering for real-time log reads
        setvbuf(stdout, nullptr, _IONBF, 0);
        setvbuf(stderr, nullptr, _IONBF, 0);
        LOG_PATH = path;
    }
}

static void printUsage() {
    printf("Usage: constellation-renderer --port <port> --screen <screenId> --width <w> --height <h>\n");
    printf("       [--host <host>] [--ndi-screen <screenId>] [--verbose] [--console]\n");
    printf("  --ndi-screen  which screen feeds the NDI output (default: --screen)\n");
    printf("  --x <px> --y <px>  desktop position of the window (physical pixels)\n");
    printf("  --borderless  no frame: the client area is exactly width x height\n");
    printf("  --overlay     start with the diagnostics overlay shown (F3 toggles it)\n");
    printf("\n");
    printf("       constellation-renderer --thumbnail <video> <out.png> [--time <s>] [--max <px>]\n");
    printf("  Decode one frame headlessly and write it as a PNG (for the media bin).\n");
}

int main(int argc, char* argv[]) {
    // Headless thumbnail mode: no window, no log file, no sidecar. The editor
    // runs this for files the browser cannot decode, so it has to stay quick
    // and quiet and report through the exit code.
    if (argc >= 3 && strcmp(argv[1], "--probe") == 0) {
        return runProbe(argv[2]);
    }
    if (argc >= 4 && strcmp(argv[1], "--thumbnail") == 0) {
        double time = 0.0;
        uint32_t maxDim = 256;
        for (int i = 4; i + 1 < argc; i++) {
            if (strcmp(argv[i], "--time") == 0) time = atof(argv[++i]);
            else if (strcmp(argv[i], "--max") == 0) maxDim = (uint32_t)atoi(argv[++i]);
        }
        return runThumbnail(argv[2], argv[3], time, maxDim > 0 ? maxDim : 256);
    }

    // Per-monitor DPI awareness on Windows, before any window exists. Without
    // it Windows virtualises coordinates and sizes for this process on any
    // display that is not at 100% scale: a 3840x2160 window asked for on a
    // 150% monitor came out as 2560x1440 client pixels stretched back up, and
    // positions from the Output panel (physical pixels) landed in the wrong
    // place. On macOS this brings up NSApplication.
    platformProcessInit();

    AppConfig config;
    config.host = "localhost";
    bool useLogFile = true;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) {
            config.port = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--screen") == 0 && i + 1 < argc) {
            config.screenId = argv[++i];
        } else if (strcmp(argv[i], "--width") == 0 && i + 1 < argc) {
            config.width = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--height") == 0 && i + 1 < argc) {
            config.height = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--x") == 0 && i + 1 < argc) {
            config.placement.x = atoi(argv[++i]);
            config.placement.positioned = true;
        } else if (strcmp(argv[i], "--y") == 0 && i + 1 < argc) {
            config.placement.y = atoi(argv[++i]);
            config.placement.positioned = true;
        } else if (strcmp(argv[i], "--borderless") == 0) {
            config.placement.borderless = true;
        } else if (strcmp(argv[i], "--host") == 0 && i + 1 < argc) {
            config.host = argv[++i];
        } else if (strcmp(argv[i], "--ndi-screen") == 0 && i + 1 < argc) {
            config.ndiScreenId = argv[++i];
        } else if (strcmp(argv[i], "--token") == 0 && i + 1 < argc) {
            config.token = argv[++i];
        } else if (strcmp(argv[i], "--no-audio") == 0) {
            config.audio = false;
        } else if (strcmp(argv[i], "--overlay") == 0) {
            config.overlay = true;
        } else if (strcmp(argv[i], "--verbose") == 0 || strcmp(argv[i], "-v") == 0) {
            config.verbose = true;
        } else if (strcmp(argv[i], "--console") == 0) {
            useLogFile = false;
        } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            printUsage();
            return 0;
        }
    }

    if (useLogFile) {
        initLogFile(config.screenId.c_str());
    }

    if (config.port <= 0) {
        fprintf(stderr, "Error: --port is required\n");
        printUsage();
        return 1;
    }

    printf("Constellation Renderer starting\n");
    if (!LOG_PATH.empty()) printf("  Log: %s\n", LOG_PATH.c_str());
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
