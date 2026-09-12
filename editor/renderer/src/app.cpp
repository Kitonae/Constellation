#include "app.h"
#include "uri_util.h"
#include <cstdio>
#include <vector>
#include <chrono>
#include <objbase.h>
#include <mfapi.h>
#include <algorithm>
#include <cctype>
#include <unordered_set>

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

#ifdef _DEBUG
    if (SUCCEEDED(m_device.As(&m_infoQueue))) {
        printf("[App] D3D12 debug layer message queue attached\n");
    }
#endif

    // Create command queue
    D3D12_COMMAND_QUEUE_DESC queueDesc = {};
    queueDesc.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    if (FAILED(m_device->CreateCommandQueue(&queueDesc, IID_PPV_ARGS(&m_cmdQueue)))) {
        fprintf(stderr, "[App] Failed to create command queue\n");
        return false;
    }

    // Frame ring: one allocator per in-flight frame, plus the fence that
    // retires them. Screens used to own an allocator and fence each, which
    // left the texture cache's uploads outside any frame's synchronisation.
    if (!createFrameResources()) {
        fprintf(stderr, "[App] Failed to create frame resources\n");
        return false;
    }

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

    // Shared fences let the decode thread and the render queue order their
    // work against each other. Without copy fences, standalone D3D11 uses
    // CPU readback instead of publishing unsynchronised shared textures.
    createSyncFences();

    // Init texture cache
    if (!m_textureCache.init(m_device.Get(), m_cmdQueue.Get())) {
        fprintf(stderr, "[App] Failed to init texture cache\n");
        return false;
    }

    // Background loader for images and video decoders
    m_mediaLoader.start();

    // Start SSE client
    m_sseClient = std::make_unique<SSEClient>(m_eventQueue, m_config.host, m_config.port,
                                              m_config.screenId, m_config.token);
    m_sseClient->start();

    // Start status reporter
    m_statusReporter = std::make_unique<StatusReporter>(m_config.host, m_config.port, m_config.token);

    // Create initial window from CLI args
    if (!m_config.screenId.empty() && m_config.width > 0 && m_config.height > 0) {
        handleScreenOpen(m_config.screenId, m_config.width, m_config.height, m_config.placement);
    }

    // Initialize NDI sender
#if HAS_NDI
    {
        // One screen feeds NDI; capturing every screen interleaved two
        // different images into a single stream.
        if (m_config.ndiScreenId.empty()) m_config.ndiScreenId = m_config.screenId;
        m_ndiSender.setSourceScreen(m_config.ndiScreenId);
        std::string ndiName = "Constellation";
        if (!m_config.ndiScreenId.empty()) ndiName += " - " + m_config.ndiScreenId;
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
    m_exitCode = 0;

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
                    for (auto& [key, dec] : m_videoDecoders) dec->setVerbose(m_config.verbose);
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
        advanceTransport();
        render();

        // Throttle if no screens (idle wait)
        if (m_screens.empty()) {
            Sleep(16);
        }
    }

    return m_exitCode;
}

// Advance the playhead from the last anchor the shell sent.
//
// This is what makes the picture independent of everything upstream: between
// corrections the show runs on this machine's own monotonic clock, so a busy
// editor, a slow link or a dropped message costs nothing visible.
void App::advanceTransport() {
    if (!m_transportDriven || !m_playing) {
        return;
    }
    const auto elapsed = std::chrono::duration<double>(
        std::chrono::steady_clock::now() - m_transportAnchorAt).count();
    m_currentTime = m_transportAnchorTime + elapsed * m_transportRate;
}

void App::processEvents() {
    auto events = m_eventQueue.drainAll();
    m_eventsProcessed += (int)events.size();
    for (auto& event : events) {
        if (event.type == "snapshot") {
            m_scene.loadSnapshot(event.data);
            reconcileMedia();
            // The snapshot lists every asset, so start loading them now
            // instead of at the first frame each clip becomes active.
            prefetchMedia();
            printf("[App] Snapshot loaded\n");
        } else if (event.type == "transport") {
            // The authoritative run state and position. Each message states
            // the whole transport and they are latest-wins on the wire, so a
            // message that lost a race would otherwise drag the show back.
            unsigned long long seq = event.data.value("seq", 0ull);
            if (m_transportDriven && seq != 0 && seq < m_transportSeq) {
                continue;
            }
            m_transportSeq = seq;
            m_transportAnchorTime = event.data.value("time", 0.0);
            double rate = event.data.value("rate", 1.0);
            m_transportRate = (rate > 0.0) ? rate : 1.0;
            m_transportAnchorAt = std::chrono::steady_clock::now();
            m_playing = event.data.value("playing", false);
            m_transportDriven = true;
            m_currentTime = m_transportAnchorTime;
        } else if (event.type == "time") {
            // Superseded once an anchor has arrived. Applying the corrections
            // meant for an older shell would make the picture step at the
            // correction rate instead of running smoothly.
            if (!m_transportDriven) {
                m_currentTime = event.timeValue;
            }
        } else if (event.type == "control") {
            std::string cmd = event.data.is_string() ? event.data.get<std::string>() : "";
            // Run state travels with the anchor when one is driving; this is
            // kept for a shell that sends only the older events.
            if (!m_transportDriven) {
                if (cmd == "play") {
                    m_playing = true;
                } else if (cmd == "pause") {
                    m_playing = false;
                } else if (cmd == "stop") {
                    m_playing = false;
                    m_currentTime = 0;
                }
            }
            printf("[App] Control: %s\n", cmd.c_str());
        } else if (event.type == "screen-open") {
            std::string sid = event.data.value("screenId", "");
            int w = event.data.value("width", 1920);
            int h = event.data.value("height", 1080);
            ScreenPlacement placement;
            if (event.data.contains("x") && event.data.contains("y")) {
                placement.positioned = true;
                placement.x = event.data.value("x", 0);
                placement.y = event.data.value("y", 0);
            }
            placement.borderless = event.data.value("borderless", false);
            if (!sid.empty()) {
                handleScreenOpen(sid, w, h, placement);
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

    // The value the queue will be signalled with at the end of this frame.
    // Frames displaced from a decoder are stamped with it so the decode
    // thread knows when D3D12 has finished reading them.
    const UINT64 thisFrameFence = m_nextFenceValue;

    // Wait for the frame this slot last belonged to, then reclaim it. Every
    // upload buffer and descriptor slot indexed by m_frameIndex is free again
    // once this returns.
    waitForFrame(m_frameIndex);

    FrameContext& frame = m_frames[m_frameIndex];
    m_cmdList->Reset(frame.alloc.Get(), nullptr);
    m_textureCache.beginFrame(m_frameIndex, m_frameCounter, m_cmdList.Get(), &frame.garbage);

    // Adopt anything the loader finished since last frame
    drainLoader();

    auto activeClips = m_scene.evaluate(m_currentTime);
    for (const auto& ac : activeClips) {
        // Only video clips own a decoder or audio player worth tracking.
        if (ac.tm && ac.clip && isVideoFile(ac.clip->uri)) {
            m_mediaLastUsed[ac.tm->id] = m_frameCounter;
        }
    }

    // Audio sync: play/pause/seek audio players for active video clips.
    //
    // Players are keyed by timeline item, not by URI: two clips of the same
    // file at different offsets need two players, and one shared player was
    // asked for two different positions every frame.
    //
    // Only the process the editor named as the audio owner does any of this;
    // every other screen's process leaves the soundtrack alone.
    if (m_config.audio) {
        std::unordered_set<std::string> activeAudioKeys;

        for (const auto& ac : activeClips) {
            if (!ac.clip || ac.clip->uri.empty()) continue;
            const std::string& uri = ac.clip->uri;
            if (!isVideoFile(uri)) continue;
            if (isRemoteUri(uri)) continue;   // https: used to slip through here

            const std::string& key = ac.tm->id;
            activeAudioKeys.insert(key);
            AudioPlayer* audio = getAudioPlayer(key, uri);
            if (!audio) continue;

            const double timeInClip = m_currentTime - ac.tm->start + ac.tm->inSeconds;

            if (m_playing) {
                // Sync: if audio drifts >200ms from expected position, seek
                double drift = std::abs(audio->currentTime() - timeInClip);
                if (drift > 0.2) {
                    audio->seek(timeInClip);
                    m_lastAudioSeek[key] = timeInClip;
                }
                // Re-issuing play() after end of stream restarted it every frame
                if (!audio->isPlaying() && !audio->atEnd()) audio->play();
            } else {
                if (audio->isPlaying()) audio->pause();
                // Scrub: seek only when the playhead actually moved. This used
                // to fire every paused frame, and AudioPlayer::seek blocked on
                // the mutex the audio thread holds across Stop/Reset.
                auto lastIt = m_lastAudioSeek.find(key);
                if (lastIt == m_lastAudioSeek.end() || std::abs(lastIt->second - timeInClip) > (1.0 / 60.0)) {
                    audio->seek(timeInClip);
                    m_lastAudioSeek[key] = timeInClip;
                }
            }
        }

        // Pause audio for clips no longer active
        for (auto& [key, player] : m_audioPlayers) {
            if (player->isPlaying() && activeAudioKeys.find(key) == activeAudioKeys.end()) {
                player->pause();
            }
        }

        m_wasPlaying = m_playing;
    }

    // Highest decode-copy fence value among the frames displayed this frame.
    // The render queue waits for it once, before executing.
    UINT64 waitCopyFence = 0;
    float renderMs = 0;
    float videoMs = 0;

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

        // Get screen node position offset (from scene tree)
        float screenOffX = 0, screenOffY = 0;
        const ScreenNode* screenNode = m_scene.getScreen(id);
        if (screenNode) {
            screenOffX = (float)screenNode->position.x;
            screenOffY = (float)screenNode->position.y;
        }

        // Draw each active clip as a textured quad
        auto renderStart = std::chrono::steady_clock::now();
        int sw = screen->width();
        int sh = screen->height();

        for (const auto& ac : activeClips) {
            if (!ac.clip || ac.clip->uri.empty()) continue;

            const std::string& uri = ac.clip->uri;

            // Skip blob: and http(s): URIs — native renderer can't access these
            if (isRemoteUri(uri)) {
                static int blobWarn = 0;
                if (blobWarn++ % 600 == 0)
                    printf("[App] Skipping blob/http URI: %.80s (use Add New button for native renderer)\n", uri.c_str());
                continue;
            }

            const CachedTexture* tex = nullptr;
            // Filled in from the frame being drawn, not from the decoder, so
            // the values always describe this picture.
            float cropScaleX = 1.0f, cropScaleY = 1.0f;
            float cropMaxX = 1.0f, cropMaxY = 1.0f;
            float colorMode = 0.0f;   // 1 when the texture holds Hap Q YCoCg

            if (isVideoFile(uri)) {
                // Decoders are keyed by timeline item so two clips of the same
                // file at different offsets each get their own, and they are
                // opened on the loader thread, never here.
                VideoDecoder* decoder = findVideoDecoder(ac.tm->id);
                if (!decoder) {
                    m_mediaLoader.requestVideo(ac.tm->id, uri, decoderParams());
                    continue;
                }

                // Source time, not timeline time: an item that starts its
                // media at in_seconds asks for that much further in.
                const double timeInClip = m_currentTime - ac.tm->start + ac.tm->inSeconds;
                const VideoFrame* frame2 = decoder->getFrameAtTime(timeInClip, thisFrameFence);
                if (!frame2) {
                    static int fMiss = 0;
                    if (fMiss++ % 300 == 0) printf("[App] No frame for %s at t=%.3f\n", ac.tm->id.c_str(), timeInClip);
                    continue;
                }

                UINT64 pending = decoder->takePendingCopyFence();
                if (pending > waitCopyFence) waitCopyFence = pending;

                // D3D12 video decode runs on its own queue, ahead of this
                // one. Nothing orders the two, so the render queue has to be
                // told to wait for the decode that produced this picture.
                if (frame2->decodeFence && frame2->decodeFenceValue > 0)
                    m_cmdQueue->Wait(frame2->decodeFence, frame2->decodeFenceValue);

                if (frame2->codedWidth > frame2->width && frame2->codedWidth > 0) {
                    cropScaleX = (float)frame2->width / (float)frame2->codedWidth;
                    cropMaxX = ((float)frame2->width - 0.5f) / (float)frame2->codedWidth;
                }
                if (frame2->codedHeight > frame2->height && frame2->codedHeight > 0) {
                    cropScaleY = (float)frame2->height / (float)frame2->codedHeight;
                    cropMaxY = ((float)frame2->height - 0.5f) / (float)frame2->codedHeight;
                }

                std::string texKey = "__video_" + ac.tm->id;

                if (frame2->nv12 && frame2->hasGpuTexture()) {
                    // NV12 zero-copy path: register NV12 texture with 2 SRVs (Y + UV)
                    tex = m_textureCache.registerNV12(texKey, frame2->d3d12Texture.Get(),
                        frame2->width, frame2->height);
                } else if (frame2->hasGpuTexture()) {
                    // Phase 1 GPU shared path: register BGRA texture directly
                    tex = m_textureCache.registerExternal(texKey, frame2->d3d12Texture.Get(),
                        frame2->width, frame2->height, DXGI_FORMAT_B8G8R8A8_UNORM);
                } else if (!frame2->pixels.empty()) {
                    // CPU frames: software-decoded BGRA, or HAP's block-
                    // compressed texture data, which uploads as what it is.
                    tex = m_textureCache.uploadPixels(texKey, frame2->pixels.data(),
                        frame2->width, frame2->height, frame2->pixelFormat);
                    colorMode = frame2->ycocg ? 1.0f : 0.0f;
                }

                if (!tex) {
                    static int uMiss = 0;
                    if (uMiss++ % 300 == 0) printf("[App] texture failed for %s (%ux%u)\n", texKey.c_str(), frame2->width, frame2->height);
                }
            } else {
                const std::string key = textureKeyFor(ac.clip->id, uri);
                tex = m_textureCache.peek(key);
                if (!tex) {
                    if (TextureCache::isDataUri(uri)) {
                        // Already in memory; decoding it here costs no I/O.
                        tex = m_textureCache.get(key, uri);
                    } else {
                        m_mediaLoader.requestImage(uri);
                        continue;
                    }
                }
            }

            if (!tex) continue;

            // Compute quad dimensions (scale 0 = natural size)
            float w = (ac.tm->scale.x > 0) ? (float)ac.tm->scale.x : (float)tex->width;
            float h = (ac.tm->scale.y > 0) ? (float)ac.tm->scale.y : (float)tex->height;

            TransformCB transform = {};
            transform.position[0] = (float)ac.tm->position.x - screenOffX;
            transform.position[1] = (float)ac.tm->position.y - screenOffY;
            transform.scale[0] = w;
            transform.scale[1] = h;
            transform.screenSize[0] = (float)sw;
            transform.screenSize[1] = (float)sh;

            EffectsCB effects = {};
            effects.opacity = (float)ac.finalOpacity;
            effects.brightness = 1.0f;
            effects.contrast = 1.0f;
            effects.saturate_amount = 1.0f;
            effects.colorMode = colorMode;

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
                ColorSpaceCB cs = {};
                VideoDecoder* dec = findVideoDecoder(ac.tm->id);
                if (dec) {
                    const ColorSpaceParams& p = dec->colorSpace();
                    cs.yOffset = p.yOffset; cs.yScale = p.yScale;
                    cs.cOffset = p.cOffset; cs.cScale = p.cScale;
                    cs.kr = p.kr; cs.kb = p.kb;
                }
                // Non-unit only for the D3D12 path, whose surfaces are
                // macroblock-aligned and so taller than the picture.
                cs.uvScaleX = cropScaleX; cs.uvScaleY = cropScaleY;
                cs.uvMaxX = cropMaxX; cs.uvMaxY = cropMaxY;
                m_pipeline.drawVideoQuad(m_cmdList.Get(), transform, effects, cs,
                    tex->srvGpu, tex->srvGpuUV);
            } else {
                m_pipeline.drawQuad(m_cmdList.Get(), transform, effects, tex->srvGpu);
            }
        }

        // Record render time (clip drawing only, excluding debug overlay)
        {
            auto renderEnd = std::chrono::steady_clock::now();
            renderMs += (float)std::chrono::duration<double, std::milli>(renderEnd - renderStart).count();
        }

        // NDI: capture the designated screen's back buffer now, with the
        // picture complete and before the operator overlay is composited
        // onto it. The feed used to carry frame graphs and filenames.
#if HAS_NDI
        if (m_ndiEnabled && m_ndiSender.isActive() &&
            (m_ndiSender.sourceScreen().empty() || m_ndiSender.sourceScreen() == id)) {
            m_ndiSender.capture(m_cmdList.Get(), screen->currentBackBuffer());
        }
#endif

        // Debug overlay
        if (m_showDebug) {
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
            m_debugText.drawFormat(8, 20, 0, 255, 0, "playing=%s  clips=%zu  decoders=%zu  srv=%u  ndi=%s(%d)%s",
                m_playing ? "yes" : "no", activeClips.size(), m_videoDecoders.size(),
                m_textureCache.usedSlots(), ndiStatus, ndiConns,
                m_config.verbose ? "  [V]ERBOSE" : "");

            int ty = 34;
            for (const auto& ac : activeClips) {
                const char* name = ac.clip ? ac.clip->name.c_str() : "?";
                const std::string& auri = ac.clip ? ac.clip->uri : "";
                bool isBlob = isRemoteUri(auri);
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
                    auto dit = m_videoDecoders.find(ac.tm->id);
                    if (dit != m_videoDecoders.end() && dit->second->isOpen()) {
                        auto* dec = dit->second.get();
                        int shown = dec->displayedFrames();
                        int drops = dec->playbackDrops();
                        int decoded = dec->decodedFrames();
                        int buf = dec->readableCount();
                        int seeks = dec->seekCount();
                        uint8_t dr = drops > 0 ? (uint8_t)255 : (uint8_t)120;
                        uint8_t dg = drops > 0 ? (uint8_t)180 : (uint8_t)200;
                        const char* decMode = dec->isHardwareAccelerated() ? "DXVA+GPU"
                                            : dec->isTextureCodec() ? "TEXTURE" : "SW";
                        m_debugText.drawFormat(18, ty, dr, dg, 120,
                            "shown=%d drops=%d dec=%d buf=%d seeks=%d [%.0ffps %.1fms %s %s]",
                            shown, drops, decoded, buf, seeks, dec->fps(), dec->decodeMs(),
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
                // drawGraph labels with history[hi]; m_perfHead is the slot
                // about to be written, so the newest sample is one behind it.
                int hi = (m_perfHead + PERF_HISTORY - 1) % PERF_HISTORY;

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

            // Upload only the rows the overlay actually touched. A full-screen
            // RGBA upload per screen per frame is ~8 MB of memcpy at 1080p and
            // inflated the frame times this overlay reports.
            std::string dbgKey = "__debug_" + id;
            const CachedTexture* dbgTex = m_textureCache.uploadRGBA(
                dbgKey, m_debugText.pixels(), m_debugText.width(), m_debugText.height(),
                m_debugText.dirtyTop(), m_debugText.dirtyBottom());
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

        screen->endFrame(m_cmdList.Get());
    }

    // Video decode cost, measured by the decode threads themselves
    for (const auto& ac : activeClips) {
        if (!ac.clip || !isVideoFile(ac.clip->uri)) continue;
        auto dit = m_videoDecoders.find(ac.tm->id);
        if (dit != m_videoDecoders.end() && dit->second->isOpen())
            videoMs += (float)dit->second->decodeMs();
    }
    m_renderTimes[m_perfHead % PERF_HISTORY] = renderMs;
    m_videoDecodeTimes[m_perfHead % PERF_HISTORY] = videoMs;

    // One submit for every screen, then one present each.
    m_cmdList->Close();

    // Order the D3D11 decode copies before anything that samples them.
    // Flush() only submits the copy; it does not wait for it.
    if (waitCopyFence && m_copyFence) {
        m_cmdQueue->Wait(m_copyFence.Get(), waitCopyFence);
    }

    ID3D12CommandList* lists[] = { m_cmdList.Get() };
    m_cmdQueue->ExecuteCommandLists(1, lists);

    // Present every screen. Only one waits for vsync: calling Present(1, 0)
    // on each in turn serialised them, halving the frame rate with two windows.
    bool syncTaken = false;
    bool deviceLost = false;
    for (auto& [id, screen] : m_screens) {
        if (!screen->isValid()) continue;
        bool primary = !syncTaken &&
            (m_config.screenId.empty() || id == m_config.screenId || m_screens.size() == 1);
        if (primary) syncTaken = true;
        if (!screen->present(primary ? 1 : 0)) deviceLost = true;
    }
    // Nothing matched the configured primary; give vsync to whoever is first.
    if (!syncTaken) {
        for (auto& [id, screen] : m_screens) {
            if (!screen->isValid()) continue;
            if (!screen->present(1)) deviceLost = true;
            break;
        }
    }

#if HAS_NDI
    if (m_ndiEnabled && m_ndiSender.isActive()) {
        m_cmdQueue->Signal(m_ndiSender.decodeFence(), m_ndiSender.currentFenceValue());
        m_ndiSender.send();
    }
#endif

    // Close this frame: the fence value retires its allocator, its garbage and
    // any decoder frame stamped with it.
    m_cmdQueue->Signal(m_frameFence.Get(), thisFrameFence);
    frame.fenceValue = thisFrameFence;
    m_nextFenceValue++;

    // Evict before advancing: anything retired here was still in use by the
    // frame just submitted, so it must be held by *that* frame's garbage list.
    evictUnusedMedia();

    m_frameIndex = (m_frameIndex + 1) % FRAMES_IN_FLIGHT;
    m_frameCounter++;
    m_debugText.clearDirty();

    if (deviceLost) {
        // A sidecar process is cheap to relaunch; full device re-creation is
        // not worth the complexity here.
        HRESULT reason = m_device ? m_device->GetDeviceRemovedReason() : E_FAIL;
        fprintf(stderr, "[App] Device removed (reason 0x%08x), exiting\n", reason);
        if (m_statusReporter && !m_config.screenId.empty()) {
            m_statusReporter->reportError(m_config.screenId, "GPU device removed");
            m_statusReporter->flush();
        }
        m_exitCode = 2;
        m_running = false;
    }

    // Frame stats: counted once per frame. Incrementing inside the screen
    // loop made the reported FPS scale with the number of open screens.
    m_frameCount++;
    {
        auto now = std::chrono::steady_clock::now();
        double statElapsed = std::chrono::duration<double>(now - m_lastStatTime).count();
        if (statElapsed >= 1.0) {
            m_fps = m_frameCount / statElapsed;
            printf("[App stats] fps=%.1f  events_processed=%d\n", m_fps, m_eventsProcessed);
            m_frameCount = 0;
            m_eventsProcessed = 0;
            m_lastStatTime = now;
        }
    }

    drainDebugMessages();

    // Record CPU frame time and advance ring buffer
    auto cpuEnd = std::chrono::steady_clock::now();
    float cpuMs = (float)std::chrono::duration<double, std::milli>(cpuEnd - cpuStart).count();
    m_cpuFrameTimes[m_perfHead % PERF_HISTORY] = cpuMs;
    m_perfHead++;
}

void App::drainDebugMessages() {
    if (!m_infoQueue) return;
    UINT64 count = m_infoQueue->GetNumStoredMessages();
    for (UINT64 i = 0; i < count; i++) {
        SIZE_T len = 0;
        if (FAILED(m_infoQueue->GetMessage(i, nullptr, &len)) || len == 0) continue;
        std::vector<char> buf(len);
        auto* msg = reinterpret_cast<D3D12_MESSAGE*>(buf.data());
        if (FAILED(m_infoQueue->GetMessage(i, msg, &len))) continue;
        const char* sev =
            msg->Severity == D3D12_MESSAGE_SEVERITY_CORRUPTION ? "CORRUPTION" :
            msg->Severity == D3D12_MESSAGE_SEVERITY_ERROR ? "ERROR" :
            msg->Severity == D3D12_MESSAGE_SEVERITY_WARNING ? "WARNING" : "INFO";
        if (msg->Severity <= D3D12_MESSAGE_SEVERITY_WARNING) {
            fprintf(stderr, "[D3D12 %s] %.*s\n", sev, (int)msg->DescriptionByteLength, msg->pDescription);
        }
    }
    m_infoQueue->ClearStoredMessages();
}

// --- Frame lifecycle -----------------------------------------------------

bool App::createFrameResources() {
    for (int i = 0; i < FRAMES_IN_FLIGHT; i++) {
        if (FAILED(m_device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,
                IID_PPV_ARGS(&m_frames[i].alloc)))) {
            return false;
        }
    }
    if (FAILED(m_device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT,
            m_frames[0].alloc.Get(), nullptr, IID_PPV_ARGS(&m_cmdList)))) {
        return false;
    }
    m_cmdList->Close();

    if (FAILED(m_device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&m_frameFence)))) {
        return false;
    }
    m_frameFenceEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    return m_frameFenceEvent != nullptr;
}

void App::waitForFrame(int index) {
    FrameContext& f = m_frames[index];
    if (f.fenceValue != 0 && m_frameFence->GetCompletedValue() < f.fenceValue) {
        m_frameFence->SetEventOnCompletion(f.fenceValue, m_frameFenceEvent);
        WaitForSingleObject(m_frameFenceEvent, INFINITE);
    }
    // Safe now: nothing on the GPU still references this frame's work.
    if (!f.garbage.srvSlots.empty()) {
        m_textureCache.releaseSlots(f.garbage.srvSlots);
    }
    f.garbage.clear();
    f.alloc->Reset();
}

void App::waitForGpuIdle() {
    if (!m_cmdQueue || !m_frameFence || !m_frameFenceEvent) return;
    UINT64 v = m_nextFenceValue++;
    m_cmdQueue->Signal(m_frameFence.Get(), v);
    if (m_frameFence->GetCompletedValue() < v) {
        m_frameFence->SetEventOnCompletion(v, m_frameFenceEvent);
        WaitForSingleObject(m_frameFenceEvent, INFINITE);
    }
    for (auto& f : m_frames) {
        if (!f.garbage.srvSlots.empty()) m_textureCache.releaseSlots(f.garbage.srvSlots);
        f.garbage.clear();
    }
}

// Share decode-copy completion with D3D12. Frame retirement is checked on the
// CPU, so the frame fence does not need a D3D11 counterpart.
bool App::createSyncFences() {
    if (!m_device || !m_d3d11Device) return false;

    ComPtr<ID3D11Device5> dev5;
    if (FAILED(m_d3d11Device.As(&dev5))) {
        printf("[App] ID3D11Device5 unavailable; decode/render fences disabled\n");
        return false;
    }

    auto share = [&](ComPtr<ID3D12Fence>& d12, ComPtr<ID3D11Fence>& d11) {
        if (FAILED(m_device->CreateFence(0, D3D12_FENCE_FLAG_SHARED, IID_PPV_ARGS(&d12))))
            return false;
        HANDLE h = nullptr;
        if (FAILED(m_device->CreateSharedHandle(d12.Get(), nullptr, GENERIC_ALL, nullptr, &h)))
            return false;
        HRESULT hr = dev5->OpenSharedFence(h, IID_PPV_ARGS(&d11));
        CloseHandle(h);
        return SUCCEEDED(hr);
    };

    if (!share(m_copyFence, m_copyFence11)) {
        printf("[App] Shared copy fence unavailable; standalone decode uses CPU readback\n");
        m_copyFence.Reset();
        m_copyFence11.Reset();
        return false;
    }
    printf("[App] Cross-API decode/render fences ready\n");
    return true;
}

// --- Media loading and eviction -----------------------------------------

DecoderParams App::decoderParams() {
    DecoderParams p;
    p.d3d12Device = m_device.Get();
    p.d3d11Device = m_d3d11Device.Get();
    p.dxgiManager = m_dxgiManager.Get();
    p.d3d11On12 = m_d3d11On12Device.Get();
    p.d3d12Queue = m_cmdQueue.Get();
    p.nv12Mode = m_nv12Active;
    p.verbose = m_config.verbose;
    p.sync.frameFence = m_frameFence;
    p.sync.copyFence11 = m_copyFence11;
    p.sync.copyFenceCounter = &m_copyFenceCounter;
    p.sync.copySignalMutex = &m_copySignalMutex;
    return p;
}

void App::reconcileMedia() {
    std::unordered_map<std::string, std::string> current;
    for (const auto& track : m_scene.tracks()) {
        for (const auto& tm : track.media) {
            const auto* clip = m_scene.getMedia(tm.clipId);
            if (clip && isVideoFile(clip->uri) && !isRemoteUri(clip->uri))
                current[tm.id] = clip->uri;
        }
    }
    bool waited = false;
    for (const auto& [key, uri] : m_videoUris) {
        auto it = current.find(key);
        if (it != current.end() && it->second == uri) continue;
        // Invalidate pending requests even if no decoder has arrived yet.
        m_mediaLoader.forget(key);
        if (!waited) {
            waitForGpuIdle();
            waited = true;
        }
        m_videoDecoders.erase(key);
        m_audioPlayers.erase(key);
        m_lastAudioSeek.erase(key);
        m_mediaLastUsed.erase(key);
        m_textureCache.invalidate("__video_" + key, m_frames[m_frameIndex].garbage);
    }
    m_videoUris = std::move(current);
}

// Ask the loader for everything the snapshot references. Images are cheap to
// hold, so all of them are requested; decoders are not, so only clips near
// the playhead are opened ahead of time. Either way nothing is decoded on the
// render thread the moment a clip becomes active.
void App::prefetchMedia() {
    for (const auto& [id, clip] : m_scene.allMedia()) {
        if (clip.uri.empty() || isRemoteUri(clip.uri)) continue;
        if (TextureCache::isDataUri(clip.uri)) continue;   // decoded inline
        if (!isVideoFile(clip.uri)) m_mediaLoader.requestImage(clip.uri);
    }
    prefetchNearbyVideos();
}

void App::prefetchNearbyVideos() {
    static constexpr double PREFETCH_SECONDS = 30.0;
    for (const auto& track : m_scene.tracks()) {
        for (const auto& tm : track.media) {
            if (tm.overlapping) continue;
            double end = tm.start + tm.duration;
            if (end < m_currentTime || tm.start > m_currentTime + PREFETCH_SECONDS) continue;
            const MediaClip* clip = m_scene.getMedia(tm.clipId);
            if (!clip || clip->uri.empty() || isRemoteUri(clip->uri)) continue;
            if (!isVideoFile(clip->uri)) continue;
            if (m_videoDecoders.count(tm.id)) continue;
            m_mediaLoader.requestVideo(tm.id, clip->uri, decoderParams());
        }
    }
}

void App::drainLoader() {
    prefetchNearbyVideos();

    for (auto& ready : m_mediaLoader.drainReady()) {
        if (ready.failed) {
            fprintf(stderr, "[App] Failed to load %.80s\n", ready.uri.c_str());
            continue;
        }
        if (ready.decoder) {
            auto it = m_videoUris.find(ready.key);
            if (it == m_videoUris.end() || it->second != ready.uri) continue;
            m_videoDecoders[ready.key] = std::move(ready.decoder);
            m_mediaLastUsed[ready.key] = m_frameCounter;
        } else if (!ready.rgba.empty()) {
            m_textureCache.uploadPixels(ready.key, ready.rgba.data(),
                ready.width, ready.height, DXGI_FORMAT_R8G8B8A8_UNORM);
        }
    }
}

void App::evictUnusedMedia() {
    // Roughly five seconds at 60 fps: long enough that scrubbing back and
    // forth over a cut does not thrash, short enough to bound the SRV heap.
    static constexpr uint64_t GRACE_FRAMES = 300;
    if (m_frameCounter < GRACE_FRAMES) return;
    if ((m_frameCounter % 60) != 0) return;   // once a second is plenty

    FrameGarbage& garbage = m_frames[m_frameIndex].garbage;
    std::vector<std::string> evicted;
    m_textureCache.evictUnused(m_frameCounter, GRACE_FRAMES, garbage, &evicted);
    for (const auto& key : evicted) m_mediaLoader.forget(key);

    for (auto it = m_mediaLastUsed.begin(); it != m_mediaLastUsed.end(); ) {
        if (it->second + GRACE_FRAMES >= m_frameCounter) { ++it; continue; }
        const std::string key = it->first;
        // Closing a decoder joins its thread and returns its GPU frames, so
        // the render queue must be past every frame that sampled them.
        auto dit = m_videoDecoders.find(key);
        if (dit != m_videoDecoders.end()) {
            waitForGpuIdle();
            m_videoDecoders.erase(dit);
        }
        m_audioPlayers.erase(key);
        m_lastAudioSeek.erase(key);
        m_mediaLoader.forget(key);
        it = m_mediaLastUsed.erase(it);
    }
}

VideoDecoder* App::findVideoDecoder(const std::string& key) {
    auto it = m_videoDecoders.find(key);
    if (it == m_videoDecoders.end()) return nullptr;
    return it->second->isOpen() ? it->second.get() : nullptr;
}

std::string App::textureKeyFor(const std::string& clipId, const std::string& uri) {
    // A data: URI can be megabytes long; hashing it on every map lookup, and
    // storing it as a key, is pure waste when the clip id already identifies it.
    return TextureCache::isDataUri(uri) ? ("__img_" + clipId) : uri;
}

void App::handleScreenOpen(const std::string& screenId, int width, int height,
                           const ScreenPlacement& placement) {
    if (m_screens.count(screenId)) {
        printf("[App] Screen %s already open\n", screenId.c_str());
        return;
    }

    auto screen = std::make_unique<Screen>(screenId, width, height, placement,
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
    // The GPU may still be presenting from this swap chain.
    waitForGpuIdle();
    m_screens.erase(screenId);
    printf("[App] Closed screen %s\n", screenId.c_str());
}

void App::shutdown() {
    m_running = false;
    if (m_sseClient) {
        m_sseClient->stop();
    }
    m_mediaLoader.stop();
    // Everything below releases GPU resources, so drain the queue first.
    waitForGpuIdle();
    if (m_frameFenceEvent) { CloseHandle(m_frameFenceEvent); m_frameFenceEvent = nullptr; }
    m_screens.clear();
#if HAS_NDI
    m_ndiSender.shutdown();
#endif
    m_audioPlayers.clear();
    m_videoDecoders.clear(); // must be before D3D11 device release
    m_textureCache.shutdown();
    m_dxgiManager.Reset();
    m_d3d11On12Device.Reset();
    m_d3d11Context.Reset();
    m_d3d11Device.Reset();
    m_nv12Active = false;
    m_copyFence11.Reset();
    m_copyFence.Reset();
    m_frameFence.Reset();
    for (auto& f : m_frames) { f.garbage.clear(); f.alloc.Reset(); }
    m_cmdList.Reset();
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

AudioPlayer* App::getAudioPlayer(const std::string& key, const std::string& uri) {
    auto it = m_audioPlayers.find(key);
    if (it != m_audioPlayers.end()) {
        return it->second->isOpen() ? it->second.get() : nullptr;
    }

    std::string path = uriToPath(uri);
    if (path.empty()) return nullptr;

    auto player = std::make_unique<AudioPlayer>();
    if (!player->open(path)) {
        m_audioPlayers[key] = std::move(player); // cache failure
        return nullptr;
    }

    AudioPlayer* ptr = player.get();
    m_audioPlayers[key] = std::move(player);
    return ptr;
}
