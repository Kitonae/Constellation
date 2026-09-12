// The Windows half of App: D3D12 device, frame ring, screens and the render
// loop. Everything platform-neutral is in app_common.cpp.

#include "app.h"
#include "uri_util.h"
#include <cstdio>
#include <vector>
#include <chrono>
#include <objbase.h>
#include <mfapi.h>
#include <algorithm>

bool App::init(const AppConfig& config) {
    m_config = config;
    m_showDebug = config.overlay;

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

    syncAudio(activeClips);

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

            TransformCB transform;
            EffectsCB effects;
            buildQuadConstants(ac, screenOffX, screenOffY, sw, sh, tex->width, tex->height,
                               colorMode, transform, effects);

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
            drawDebugOverlay(id, sw, sh, activeClips);

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

    videoMs = activeVideoDecodeMs(activeClips);

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

    drainDebugMessages();

    recordFrameStats(cpuStart, renderMs, videoMs);
}

FrameGarbage& App::currentGarbage() {
    return m_frames[m_frameIndex].garbage;
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

