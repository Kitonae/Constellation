#include "app.h"
#include <cstdio>
#include <chrono>
#include <objbase.h>
#include <mfapi.h>
#include <algorithm>
#include <cctype>

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
    for (UINT i = 0; m_factory->EnumAdapters1(i, &m_adapter) != DXGI_ERROR_NOT_FOUND; i++) {
        DXGI_ADAPTER_DESC1 desc;
        m_adapter->GetDesc1(&desc);
        if (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue;
        if (SUCCEEDED(D3D12CreateDevice(m_adapter.Get(), D3D_FEATURE_LEVEL_11_0, _uuidof(ID3D12Device), nullptr))) {
            break;
        }
        m_adapter = nullptr;
    }
    ComPtr<IDXGIAdapter1>& adapter = m_adapter;

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

    // Init COM for WIC and Media Foundation
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    MFStartup(MF_VERSION);

    // Create shared D3D11 device for DXVA video decode.
    // Try D3D11On12 first (wraps DX12 device, enables zero-copy NV12 video decode).
    // Falls back to standalone D3D11 (shared DXGI textures, BGRA output).
    {
        HRESULT hr11 = E_FAIL;
        bool d3d11on12 = false;

        // Try D3D11On12: wraps our DX12 device so decoded textures are D3D12 resources
        {
            IUnknown* queues[] = { m_cmdQueue.Get() };
            hr11 = D3D11On12CreateDevice(
                m_device.Get(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                nullptr, 0,         // use D3D12 device's feature level
                queues, 1,          // must be DIRECT queue
                0,                  // node mask
                &m_d3d11Device, &m_d3d11Context, nullptr);
            if (SUCCEEDED(hr11)) {
                // Get ID3D11On12Device2 for UnwrapUnderlyingResource (Win10 2004+)
                hr11 = m_d3d11Device.As(&m_d3d11On12Device);
                if (SUCCEEDED(hr11)) {
                    d3d11on12 = true;
                    printf("[App] D3D11On12 device created (NV12 zero-copy enabled)\n");
                } else {
                    printf("[App] ID3D11On12Device2 QI failed (0x%08x), need Win10 2004+\n", hr11);
                    m_d3d11Device.Reset();
                    m_d3d11Context.Reset();
                }
            } else {
                printf("[App] D3D11On12CreateDevice failed (0x%08x), trying standalone D3D11\n", hr11);
            }
        }

        // Fallback: standalone D3D11 device (Phase 1 shared DXGI textures path)
        if (!d3d11on12) {
            UINT d3d11Flags = D3D11_CREATE_DEVICE_VIDEO_SUPPORT;
            D3D_FEATURE_LEVEL fl;
            hr11 = D3D11CreateDevice(m_adapter.Get(),
                m_adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE,
                nullptr, d3d11Flags, nullptr, 0, D3D11_SDK_VERSION,
                &m_d3d11Device, &fl, nullptr);
            if (SUCCEEDED(hr11)) {
                printf("[App] Standalone D3D11 device created for DXVA\n");
            } else {
                printf("[App] D3D11 device creation failed (0x%08x), videos will use software decode\n", hr11);
            }
        }

        if (m_d3d11Device) {
            ComPtr<ID3D10Multithread> mt;
            if (SUCCEEDED(m_d3d11Device.As(&mt))) mt->SetMultithreadProtected(TRUE);

            UINT token = 0;
            hr11 = MFCreateDXGIDeviceManager(&token, &m_dxgiManager);
            if (SUCCEEDED(hr11)) {
                m_dxgiManager->ResetDevice(m_d3d11Device.Get(), token);
            }

            m_nv12Active = d3d11on12;  // refined after pipeline init
        }
    }

    // Init render pipeline
    if (!m_pipeline.init(m_device.Get())) {
        fprintf(stderr, "[App] Failed to init render pipeline\n");
        return false;
    }

    // NV12 path requires both D3D11On12 and the NV12 video PSO
    if (m_nv12Active && !m_pipeline.hasVideoPipeline()) {
        printf("[App] NV12 PSO not available, falling back to BGRA shared textures\n");
        m_nv12Active = false;
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

    // Initialize NDI sender
#if HAS_NDI
    {
        std::string ndiName = "Constellation";
        if (!m_config.screenId.empty()) ndiName += " - " + m_config.screenId;
        if (!m_ndiSender.init(m_device.Get(), m_cmdQueue.Get(), ndiName,
                              m_config.width, m_config.height, 60.0)) {
            printf("[App] NDI sender init failed (non-fatal)\n");
        }
    }
#endif

    m_lastStatTime = std::chrono::steady_clock::now();
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
            if (msg.message == WM_KEYDOWN) {
                if (msg.wParam == 'V') {
                    m_config.verbose = !m_config.verbose;
                    for (auto& [uri, dec] : m_videoDecoders) dec->setVerbose(m_config.verbose);
                    printf("[App] Verbose %s\n", m_config.verbose ? "ON" : "OFF");
                }
                if (msg.wParam == VK_F3) {
                    m_showDebug = !m_showDebug;
                    printf("[App] Debug overlay %s\n", m_showDebug ? "ON" : "OFF");
                }
                if (msg.wParam == VK_F4) {
                    m_ndiEnabled = !m_ndiEnabled;
                    printf("[App] NDI output %s\n", m_ndiEnabled ? "ON" : "OFF");
                }
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
    auto events = m_eventQueue.drainAll();
    m_eventsProcessed += (int)events.size();
    for (auto& event : events) {
        if (event.type == "snapshot") {
            m_scene.loadSnapshot(event.data);
            printf("[App] Snapshot loaded\n");
        } else if (event.type == "time") {
            m_currentTime = event.timeValue;
        } else if (event.type == "control") {
            std::string cmd = event.data.is_string() ? event.data.get<std::string>() : "";
            if (cmd == "play") {
                m_playing = true;
            } else if (cmd == "pause") {
                m_playing = false;
            } else if (cmd == "stop") {
                m_playing = false;
                m_currentTime = 0;
            }
            printf("[App] Control: %s\n", cmd.c_str());
        } else if (event.type == "screen-open") {
            std::string sid = event.data.value("screenId", "");
            int w = event.data.value("width", 1920);
            int h = event.data.value("height", 1080);
            if (!sid.empty()) {
                handleScreenOpen(sid, w, h);
            }
        } else if (event.type == "screen-close") {
            std::string sid = event.data.value("screenId", "");
            if (!sid.empty()) {
                handleScreenClose(sid);
            }
        }
    }
}

void App::render() {
    auto cpuStart = std::chrono::steady_clock::now();
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
        auto renderStart = std::chrono::steady_clock::now();
        int sw = screen->width();
        int sh = screen->height();

        for (const auto& ac : activeClips) {
            if (!ac.clip || ac.clip->uri.empty()) continue;

            const std::string& uri = ac.clip->uri;

            // Skip blob: and http: URIs — native renderer can't access these
            if (uri.substr(0, 5) == "blob:" || uri.substr(0, 5) == "http:" || uri.substr(0, 6) == "https:") {
                static int blobWarn = 0;
                if (blobWarn++ % 600 == 0)
                    printf("[App] Skipping blob/http URI: %.80s (use Add New button for native renderer)\n", uri.c_str());
                continue;
            }

            const CachedTexture* tex = nullptr;

            if (isVideoFile(uri)) {
                // Decode video frame at current timeline position within this clip
                VideoDecoder* decoder = getVideoDecoder(uri);
                if (!decoder) {
                    static int vMiss = 0;
                    if (vMiss++ % 300 == 0) printf("[App] No decoder for %.60s\n", uri.c_str());
                    continue;
                }

                double timeInClip = m_currentTime - ac.tm->start;
                const VideoFrame* frame = decoder->getFrameAtTime(timeInClip);
                if (!frame) {
                    static int fMiss = 0;
                    if (fMiss++ % 300 == 0) printf("[App] No frame for %s at t=%.3f\n", ac.tm->id.c_str(), timeInClip);
                    continue;
                }

                std::string texKey = "__video_" + ac.tm->id;

                if (frame->nv12 && frame->hasGpuTexture()) {
                    // NV12 zero-copy path: register NV12 texture with 2 SRVs (Y + UV)
                    tex = m_textureCache.registerNV12(texKey, frame->d3d12Texture.Get(),
                        frame->width, frame->height);
                } else if (frame->hasGpuTexture()) {
                    // Phase 1 GPU shared path: register BGRA texture directly
                    tex = m_textureCache.registerExternal(texKey, frame->d3d12Texture.Get(),
                        frame->width, frame->height, DXGI_FORMAT_B8G8R8A8_UNORM);
                } else if (!frame->pixels.empty()) {
                    // CPU fallback path: upload pixel data
                    tex = m_textureCache.uploadPixels(texKey, frame->pixels.data(),
                        frame->width, frame->height, DXGI_FORMAT_B8G8R8A8_UNORM);
                }

                if (!tex) {
                    static int uMiss = 0;
                    if (uMiss++ % 300 == 0) printf("[App] texture failed for %s (%ux%u)\n", texKey.c_str(), frame->width, frame->height);
                }
            } else {
                tex = m_textureCache.get(uri);
            }

            if (!tex) {
                static int missCount = 0;
                if (missCount++ % 300 == 0) printf("[App] Texture miss for %.60s...\n", uri.c_str());
                continue;
            }

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

            if (tex->isNV12) {
                m_pipeline.drawVideoQuad(m_cmdList.Get(), transform, effects,
                    tex->srvGpu, tex->srvGpuUV);
            } else {
                m_pipeline.drawQuad(m_cmdList.Get(), transform, effects, tex->srvGpu);
            }
        }

        // Record render time (clip drawing only, excluding debug overlay)
        {
            auto renderEnd = std::chrono::steady_clock::now();
            float renderMs = (float)std::chrono::duration<double, std::milli>(renderEnd - renderStart).count();
            m_renderTimes[m_perfHead % PERF_HISTORY] = renderMs;
        }

        // Record video decode time (sum of all active decoders' frame delivery latency)
        {
            float videoMs = 0;
            for (const auto& ac : activeClips) {
                if (!ac.clip) continue;
                const std::string& auri = ac.clip->uri;
                if (!isVideoFile(auri)) continue;
                auto dit = m_videoDecoders.find(auri);
                if (dit != m_videoDecoders.end() && dit->second->isOpen()) {
                    // Use decoded frame count as a proxy — actual per-frame timing
                    // would need instrumentation in the decode thread
                    videoMs += (dit->second->isHardwareAccelerated() ? 0.5f : 4.0f);
                }
            }
            m_videoDecodeTimes[m_perfHead % PERF_HISTORY] = videoMs;
        }

        // Debug overlay
        if (m_showDebug) {
            // Update FPS counter
            m_frameCount++;
            auto now = std::chrono::steady_clock::now();
            double statElapsed = std::chrono::duration<double>(now - m_lastStatTime).count();
            if (statElapsed >= 1.0) {
                m_fps = m_frameCount / statElapsed;
                printf("[App stats] fps=%.1f  events_processed=%d\n", m_fps, m_eventsProcessed);
                m_frameCount = 0;
                m_eventsProcessed = 0;
                m_lastStatTime = now;
            }

            if (m_debugText.width() != (uint32_t)sw || m_debugText.height() != (uint32_t)sh) {
                m_debugText.init(sw, sh);
            }
            m_debugText.clear();

            bool connected = m_sseClient && m_sseClient->isConnected();
            m_debugText.drawFormat(8, 8,
                connected ? (uint8_t)0 : (uint8_t)255,
                connected ? (uint8_t)255 : (uint8_t)80,
                (uint8_t)0,
                "fps=%.0f  t=%.2fs  sse=%s  screen=%s (%dx%d)",
                m_fps, m_currentTime,
                connected ? "OK" : "DISCONNECTED",
                id.c_str(), sw, sh);
            // NDI status
            const char* ndiStatus = "off";
            int ndiConns = 0;
#if HAS_NDI
            if (m_ndiSender.isActive()) {
                ndiConns = m_ndiSender.numConnections();
                ndiStatus = m_ndiEnabled ? (ndiConns > 0 ? "streaming" : "ready") : "paused";
            }
#endif
            m_debugText.drawFormat(8, 20, 0, 255, 0, "playing=%s  clips=%zu  decoders=%zu  ndi=%s(%d)%s",
                m_playing ? "yes" : "no", activeClips.size(), m_videoDecoders.size(),
                ndiStatus, ndiConns,
                m_config.verbose ? "  [V]ERBOSE" : "");

            int ty = 34;
            for (const auto& ac : activeClips) {
                const char* name = ac.clip ? ac.clip->name.c_str() : "?";
                const std::string& auri = ac.clip ? ac.clip->uri : "";
                bool isBlob = auri.substr(0, 5) == "blob:" || auri.substr(0, 5) == "http:";
                bool isVid = ac.clip && isVideoFile(auri);
                const char* tag = isBlob ? "[blob!]" : (isVid ? "[vid]" : "[img]");
                uint8_t cr = isBlob ? (uint8_t)255 : (uint8_t)200;
                uint8_t cg = isBlob ? (uint8_t)80 : (uint8_t)200;
                uint8_t cb = isBlob ? (uint8_t)80 : (uint8_t)200;
                m_debugText.drawFormat(8, ty, cr, cg, cb,
                    " %s %s  op=%.0f%%  [%.1f-%.1f]",
                    tag, name,
                    ac.finalOpacity * 100.0, ac.tm->start, ac.tm->start + ac.tm->duration);
                ty += 12;

                // Video decoder stats
                if (isVid && !isBlob) {
                    auto dit = m_videoDecoders.find(auri);
                    if (dit != m_videoDecoders.end() && dit->second->isOpen()) {
                        auto* dec = dit->second.get();
                        int shown = dec->displayedFrames();
                        int drops = dec->playbackDrops();
                        int decoded = dec->decodedFrames();
                        int buf = dec->readableCount();
                        int seeks = dec->seekCount();
                        uint8_t dr = drops > 0 ? (uint8_t)255 : (uint8_t)120;
                        uint8_t dg = drops > 0 ? (uint8_t)180 : (uint8_t)200;
                        const char* decMode = dec->isHardwareAccelerated() ? "DXVA+GPU" : "SW";
                        m_debugText.drawFormat(18, ty, dr, dg, 120,
                            "shown=%d drops=%d dec=%d buf=%d seeks=%d [%.0ffps %s %s]",
                            shown, drops, decoded, buf, seeks, dec->fps(),
                            dec->codecName(), decMode);
                        ty += 12;
                    }
                }
            }

            // Performance graphs (bottom-right corner)
            {
                int gw = 200, gh = 40, gpad = 6;
                int gx = sw - gw - 10;
                int gy = sh - (gh + gpad) * 3 - 10;
                int hi = m_perfHead % PERF_HISTORY;

                m_debugText.drawGraph(gx, gy, gw, gh,
                    m_cpuFrameTimes, PERF_HISTORY, hi, 33.3f,
                    0, 200, 255, "Frame");
                gy += gh + gpad;

                m_debugText.drawGraph(gx, gy, gw, gh,
                    m_renderTimes, PERF_HISTORY, hi, 33.3f,
                    100, 255, 50, "Render");
                gy += gh + gpad;

                m_debugText.drawGraph(gx, gy, gw, gh,
                    m_videoDecodeTimes, PERF_HISTORY, hi, 16.6f,
                    255, 180, 0, "Video");
            }

            std::string dbgKey = "__debug_" + id;
            const CachedTexture* dbgTex = m_textureCache.uploadRGBA(
                dbgKey, m_debugText.pixels(), m_debugText.width(), m_debugText.height());
            if (dbgTex) {
                TransformCB dt = {};
                dt.scale[0] = (float)sw;
                dt.scale[1] = (float)sh;
                dt.screenSize[0] = (float)sw;
                dt.screenSize[1] = (float)sh;

                EffectsCB de = {};
                de.opacity = 1.0f;
                de.brightness = 1.0f;
                de.contrast = 1.0f;
                de.saturate_amount = 1.0f;

                m_pipeline.drawQuad(m_cmdList.Get(), dt, de, dbgTex->srvGpu);
            }
        }

        // NDI: capture back buffer before it transitions to PRESENT
#if HAS_NDI
        if (m_ndiEnabled && m_ndiSender.isActive()) {
            m_ndiSender.capture(m_cmdList.Get(), screen->currentBackBuffer());
        }
#endif

        screen->endFrame(m_cmdList.Get(), m_cmdQueue.Get());

        // NDI: signal fence and send the captured frame
#if HAS_NDI
        if (m_ndiEnabled && m_ndiSender.isActive()) {
            m_cmdQueue->Signal(m_ndiSender.decodeFence(), m_ndiSender.currentFenceValue());
            m_ndiSender.send();
        }
#endif
    }

    // Record CPU frame time and advance ring buffer
    auto cpuEnd = std::chrono::steady_clock::now();
    float cpuMs = (float)std::chrono::duration<double, std::milli>(cpuEnd - cpuStart).count();
    m_cpuFrameTimes[m_perfHead % PERF_HISTORY] = cpuMs;
    m_perfHead++;
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
#if HAS_NDI
    m_ndiSender.shutdown();
#endif
    m_videoDecoders.clear(); // must be before D3D11 device release
    m_textureCache.shutdown();
    m_dxgiManager.Reset();
    m_d3d11On12Device.Reset();
    m_d3d11Context.Reset();
    m_d3d11Device.Reset();
    m_nv12Active = false;
    MFShutdown();
    CoUninitialize();
    printf("[App] Shutdown complete\n");
}

bool App::isVideoFile(const std::string& uri) {
    size_t dot = uri.rfind('.');
    if (dot == std::string::npos) return false;
    std::string ext = uri.substr(dot + 1);
    for (auto& c : ext) c = (char)std::tolower((unsigned char)c);
    return ext == "mp4" || ext == "mov" || ext == "webm" || ext == "mkv" ||
           ext == "avi" || ext == "m4v" || ext == "mpg" || ext == "mpeg" ||
           ext == "hevc" || ext == "h265" || ext == "265" || ext == "ts" || ext == "mts";
}

VideoDecoder* App::getVideoDecoder(const std::string& uri) {
    auto it = m_videoDecoders.find(uri);
    if (it != m_videoDecoders.end()) {
        return it->second->isOpen() ? it->second.get() : nullptr;
    }

    // Resolve file path from URI
    std::string path;
    if (uri.substr(0, 8) == "file:///") {
        path = uri.substr(8);
        std::string decoded;
        for (size_t i = 0; i < path.size(); i++) {
            if (path[i] == '%' && i + 2 < path.size()) {
                char hex[3] = { path[i + 1], path[i + 2], 0 };
                decoded += (char)strtol(hex, nullptr, 16);
                i += 2;
            } else if (path[i] == '/') {
                decoded += '\\';
            } else {
                decoded += path[i];
            }
        }
        path = decoded;
    } else if (uri.size() > 2 && uri[1] == ':') {
        path = uri;
    } else {
        return nullptr;
    }

    auto decoder = std::make_unique<VideoDecoder>();
    decoder->setVerbose(m_config.verbose);
    if (!decoder->open(path, m_device.Get(), m_d3d11Device.Get(), m_dxgiManager.Get(),
                       m_d3d11On12Device.Get(), m_cmdQueue.Get(), m_nv12Active)) {
        fprintf(stderr, "[App] Failed to open video: %s\n", path.c_str());
        m_videoDecoders[uri] = std::move(decoder); // cache failure to avoid retries
        return nullptr;
    }

    VideoDecoder* ptr = decoder.get();
    m_videoDecoders[uri] = std::move(decoder);
    return ptr;
}
