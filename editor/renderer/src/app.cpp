#include "app.h"
#include <cstdio>
#include <chrono>
#include <objbase.h>

bool App::init(const AppConfig& config) {
    m_config = config;

    // Create DXGI factory
    UINT dxgiFlags = 0;
#ifdef _DEBUG
    {
        ComPtr<ID3D12Debug> debug;
        if (SUCCEEDED(D3D12GetDebugInterface(IID_PPV_ARGS(&debug)))) {
            debug->EnableDebugLayer();
            dxgiFlags = DXGI_CREATE_FACTORY_DEBUG;
        }
    }
#endif
    if (FAILED(CreateDXGIFactory2(dxgiFlags, IID_PPV_ARGS(&m_factory)))) {
        fprintf(stderr, "[App] Failed to create DXGI factory\n");
        return false;
    }

    // Select hardware adapter
    ComPtr<IDXGIAdapter1> adapter;
    for (UINT i = 0; m_factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; i++) {
        DXGI_ADAPTER_DESC1 desc;
        adapter->GetDesc1(&desc);
        if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue;
        if (SUCCEEDED(D3D12CreateDevice(adapter.Get(), D3D_FEATURE_LEVEL_11_0, _uuidof(ID3D12Device), nullptr))) {
            break;
        }
        adapter = nullptr;
    }

    // Create device
    if (FAILED(D3D12CreateDevice(adapter.Get(), D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&m_device)))) {
        fprintf(stderr, "[App] Failed to create D3D12 device\n");
        return false;
    }
    printf("[App] D3D12 device created\n");

    // Create command queue
    D3D12_COMMAND_QUEUE_DESC queueDesc = {};
    queueDesc.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    if (FAILED(m_device->CreateCommandQueue(&queueDesc, IID_PPV_ARGS(&m_cmdQueue)))) {
        fprintf(stderr, "[App] Failed to create command queue\n");
        return false;
    }

    // Create a temporary command allocator for the shared command list
    ComPtr<ID3D12CommandAllocator> tempAlloc;
    m_device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&tempAlloc));
    m_device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, tempAlloc.Get(), nullptr, IID_PPV_ARGS(&m_cmdList));
    m_cmdList->Close();

    // Init COM for WIC
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    // Init render pipeline
    if (!m_pipeline.init(m_device.Get())) {
        fprintf(stderr, "[App] Failed to init render pipeline\n");
        return false;
    }

    // Init texture cache
    if (!m_textureCache.init(m_device.Get(), m_cmdQueue.Get())) {
        fprintf(stderr, "[App] Failed to init texture cache\n");
        return false;
    }

    // Start SSE client
    m_sseClient = std::make_unique<SSEClient>(m_eventQueue, m_config.host, m_config.port, m_config.screenId);
    m_sseClient->start();

    // Start status reporter
    m_statusReporter = std::make_unique<StatusReporter>(m_config.host, m_config.port);

    // Create initial window from CLI args
    if (!m_config.screenId.empty() && m_config.width > 0 && m_config.height > 0) {
        handleScreenOpen(m_config.screenId, m_config.width, m_config.height);
    }

    printf("[App] Initialized, connecting to %s:%d\n", m_config.host.c_str(), m_config.port);
    return true;
}

int App::run() {
    m_running = true;

    while (m_running) {
        // Process Win32 messages for all windows
        MSG msg;
        while (PeekMessage(&msg, nullptr, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) {
                m_running = false;
                break;
            }
            TranslateMessage(&msg);
            DispatchMessage(&msg);
        }
        if (!m_running) break;

        // Check if all windows are closed
        bool anyVisible = false;
        for (auto& [id, screen] : m_screens) {
            if (screen->isValid() && IsWindowVisible(screen->hwnd())) {
                anyVisible = true;
                break;
            }
        }
        if (!m_screens.empty() && !anyVisible) {
            printf("[App] All windows closed, exiting\n");
            m_running = false;
            break;
        }

        processEvents();
        render();

        // Throttle if no screens (idle wait)
        if (m_screens.empty()) {
            Sleep(16);
        }
    }

    return 0;
}

void App::processEvents() {
    while (auto event = m_eventQueue.tryPop()) {
        if (event->type == "snapshot") {
            m_scene.loadSnapshot(event->data);
            printf("[App] Snapshot loaded\n");
        } else if (event->type == "time") {
            m_currentTime = event->timeValue;
        } else if (event->type == "control") {
            std::string cmd = event->data.is_string() ? event->data.get<std::string>() : "";
            if (cmd == "play") {
                m_playing = true;
            } else if (cmd == "pause") {
                m_playing = false;
            } else if (cmd == "stop") {
                m_playing = false;
                m_currentTime = 0;
            }
            printf("[App] Control: %s\n", cmd.c_str());
        } else if (event->type == "screen-open") {
            std::string sid = event->data.value("screenId", "");
            int w = event->data.value("width", 1920);
            int h = event->data.value("height", 1080);
            if (!sid.empty()) {
                handleScreenOpen(sid, w, h);
            }
        } else if (event->type == "screen-close") {
            std::string sid = event->data.value("screenId", "");
            if (!sid.empty()) {
                handleScreenClose(sid);
            }
        }
    }
}

void App::render() {
    auto activeClips = m_scene.evaluate(m_currentTime);

    for (auto& [id, screen] : m_screens) {
        if (!screen->isValid()) continue;

        screen->beginFrame(m_cmdList.Get());

        // Clear to black
        m_pipeline.clearScreen(m_cmdList.Get(), screen->currentRTV(),
                               screen->width(), screen->height(), 0.0f, 0.0f, 0.0f, 1.0f);

        // Bind SRV heap and pipeline state
        if (m_textureCache.srvHeap()) {
            m_pipeline.bindHeap(m_cmdList.Get(), m_textureCache.srvHeap());
        }

        // Draw each active clip as a textured quad
        int sw = screen->width();
        int sh = screen->height();

        for (const auto& ac : activeClips) {
            if (!ac.clip || ac.clip->uri.empty()) continue;

            // Skip video files for now (Phase 4)
            const std::string& uri = ac.clip->uri;
            {
                size_t dot = uri.rfind('.');
                if (dot != std::string::npos) {
                    std::string ext = uri.substr(dot + 1);
                    for (auto& c : ext) c = (char)tolower(c);
                    if (ext == "mp4" || ext == "mov" || ext == "webm" || ext == "mkv" ||
                        ext == "avi" || ext == "m4v" || ext == "mpg" || ext == "mpeg") {
                        continue;
                    }
                }
            }

            const CachedTexture* tex = m_textureCache.get(uri);
            if (!tex) continue;

            // Compute quad dimensions (scale 0 = natural size)
            float w = (ac.tm->scale.x > 0) ? (float)ac.tm->scale.x : (float)tex->width;
            float h = (ac.tm->scale.y > 0) ? (float)ac.tm->scale.y : (float)tex->height;

            TransformCB transform = {};
            transform.position[0] = (float)ac.tm->position.x;
            transform.position[1] = (float)ac.tm->position.y;
            transform.scale[0] = w;
            transform.scale[1] = h;
            transform.screenSize[0] = (float)sw;
            transform.screenSize[1] = (float)sh;

            EffectsCB effects = {};
            effects.opacity = (float)ac.finalOpacity;
            effects.brightness = 1.0f;
            effects.contrast = 1.0f;
            effects.saturate_amount = 1.0f;

            // Apply effects from clip
            for (const auto& [name, ep] : ac.tm->effects) {
                if (!ep.enabled) continue;
                if (name == "blur") effects.blur_radius = (float)ep.value;
                else if (name == "brightness") effects.brightness = (float)ep.value;
                else if (name == "contrast") effects.contrast = (float)ep.value;
                else if (name == "saturate") effects.saturate_amount = (float)ep.value;
                else if (name == "grayscale") effects.grayscale = (float)ep.value;
                else if (name == "sepia") effects.sepia = (float)ep.value;
                else if (name == "hue-rotate") effects.hue_rotate_deg = (float)ep.value;
                else if (name == "invert") effects.invert = (float)ep.value;
            }
            // Legacy blur
            if (ac.tm->blur > 0 && effects.blur_radius == 0) {
                effects.blur_radius = (float)ac.tm->blur;
            }

            m_pipeline.drawQuad(m_cmdList.Get(), transform, effects, tex->srvGpu);
        }

        screen->endFrame(m_cmdList.Get(), m_cmdQueue.Get());
    }
}

void App::handleScreenOpen(const std::string& screenId, int width, int height) {
    if (m_screens.count(screenId)) {
        printf("[App] Screen %s already open\n", screenId.c_str());
        return;
    }

    auto screen = std::make_unique<Screen>(screenId, width, height,
        m_device.Get(), m_cmdQueue.Get(), m_factory.Get());

    if (screen->isValid()) {
        m_screens[screenId] = std::move(screen);
        m_statusReporter->reportReady(screenId);
        printf("[App] Opened screen %s (%dx%d)\n", screenId.c_str(), width, height);
    } else {
        m_statusReporter->reportError(screenId, "Failed to create window");
    }
}

void App::handleScreenClose(const std::string& screenId) {
    m_screens.erase(screenId);
    printf("[App] Closed screen %s\n", screenId.c_str());
}

void App::shutdown() {
    m_running = false;
    if (m_sseClient) {
        m_sseClient->stop();
    }
    m_screens.clear();
    m_textureCache.shutdown();
    CoUninitialize();
    printf("[App] Shutdown complete\n");
}
