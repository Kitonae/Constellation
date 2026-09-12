// The macOS half of App: Metal device, frame ring, Cocoa windows and the
// render loop. Everything platform-neutral is in app_common.cpp.

#include "app.h"
#include "uri_util.h"
#include "shaders_metallib.h"

#import <Cocoa/Cocoa.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>
#include <algorithm>
#include <cstdio>
#include <unistd.h>
#include <vector>

namespace {

// Key codes that do not depend on the keyboard layout.
constexpr unsigned short kKeyF3 = 99;
constexpr unsigned short kKeyF4 = 118;

// How long to wait for a frame before deciding the GPU is not coming back.
constexpr uint64_t kFrameWaitTimeoutMs = 4000;

// One clip resolved for this frame: what to sample and how. Resolved once,
// then drawn on every screen, so a clip shown on two screens is uploaded
// once per frame.
struct DrawItem {
    const ActiveClip* ac = nullptr;
    ObjcRef texture;
    ObjcRef textureUV;
    uint32_t width = 0;
    uint32_t height = 0;
    bool nv12 = false;
    float colorMode = 0.0f;
    ColorSpaceCB colorSpace;
};

} // namespace

bool App::createDevice() {
    id<MTLDevice> device = MTLCreateSystemDefaultDevice();
    if (!device) {
        fprintf(stderr, "[App] No Metal device\n");
        return false;
    }
    id<MTLCommandQueue> queue = [device newCommandQueue];
    if (!queue) {
        fprintf(stderr, "[App] Failed to create command queue\n");
        return false;
    }
    queue.label = @"render";
    id<MTLSharedEvent> event = [device newSharedEvent];
    if (!event) {
        fprintf(stderr, "[App] Failed to create the frame event\n");
        return false;
    }
    event.label = @"frame";

    dispatch_data_t blob = dispatch_data_create(g_shadersMetallib, g_shadersMetallib_size,
        nullptr, DISPATCH_DATA_DESTRUCTOR_DEFAULT);
    NSError* error = nil;
    id<MTLLibrary> library = [device newLibraryWithData:blob error:&error];
    if (!library) {
        fprintf(stderr, "[App] Failed to load shaders: %s\n",
            error ? error.localizedDescription.UTF8String : "unknown");
        return false;
    }

    m_bcSupported = device.supportsBCTextureCompression;
    m_device = retainObjc(device);
    m_queue = retainObjc(queue);
    m_frameEvent = retainObjc(event);
    m_library = retainObjc(library);
    printf("[App] Metal device: %s (BC textures %s)\n", device.name.UTF8String,
        m_bcSupported ? "supported" : "NOT supported");
    return true;
}

bool App::init(const AppConfig& config) {
    m_config = config;
    m_showDebug = config.overlay;

    @autoreleasepool {
        if (!createDevice()) return false;

        // Init render pipeline
        if (!m_pipeline.init(m_device, m_library)) {
            fprintf(stderr, "[App] Failed to init render pipeline\n");
            return false;
        }
        // Zero-copy video needs the NV12 pipeline to draw it.
        m_nv12Active = m_pipeline.hasVideoPipeline();

        // Init texture cache
        if (!m_textureCache.init(m_device, m_queue)) {
            fprintf(stderr, "[App] Failed to init texture cache\n");
            return false;
        }
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
        if (!m_ndiSender.init(m_device, ndiName, m_config.width, m_config.height, 60.0)) {
            printf("[App] NDI sender init failed (non-fatal)\n");
        }
    }
#endif

    m_lastStatTime = std::chrono::steady_clock::now();
    printf("[App] Initialized, connecting to %s:%d\n", m_config.host.c_str(), m_config.port);
    return true;
}

// Cocoa events for every window, without blocking: the render loop is the
// run loop, as PeekMessage is on Windows.
bool App::pumpEvents() {
    while (NSEvent* ev = [NSApp nextEventMatchingMask:NSEventMaskAny
                                            untilDate:[NSDate distantPast]
                                               inMode:NSDefaultRunLoopMode
                                              dequeue:YES]) {
        if (ev.type == NSEventTypeKeyDown) {
            if (!ev.isARepeat) {
                NSString* chars = ev.charactersIgnoringModifiers;
                handleKey(ev.keyCode, chars ? chars.lowercaseString.UTF8String : "");
            }
            // Not forwarded: a key the view does not handle would beep.
            continue;
        }
        [NSApp sendEvent:ev];
    }
    [NSApp updateWindows];
    return true;
}

void App::handleKey(unsigned short keyCode, const std::string& chars) {
    if (chars == "v") {
        m_config.verbose = !m_config.verbose;
        for (auto& [key, dec] : m_videoDecoders) dec->setVerbose(m_config.verbose);
        printf("[App] Verbose %s\n", m_config.verbose ? "ON" : "OFF");
    }
    if (keyCode == kKeyF3) {
        m_showDebug = !m_showDebug;
        printf("[App] Debug overlay %s\n", m_showDebug ? "ON" : "OFF");
    }
    if (keyCode == kKeyF4) {
        m_ndiEnabled = !m_ndiEnabled;
        printf("[App] NDI output %s\n", m_ndiEnabled ? "ON" : "OFF");
    }
}

int App::run() {
    m_running = true;
    m_exitCode = 0;

    while (m_running) {
        @autoreleasepool {
            pumpEvents();
            if (!m_running) break;

            // Check if all windows are closed
            bool anyVisible = false;
            for (auto& [id, screen] : m_screens) {
                if (screen->isValid() && screen->isVisible()) {
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
                usleep(16000);
            }
        }
    }

    return m_exitCode;
}

void App::render() {
    auto cpuStart = std::chrono::steady_clock::now();

    // The value the frame event is signalled with at the end of this frame.
    // Frames displaced from a decoder are stamped with it so the decode
    // thread knows when the GPU has finished reading them.
    const uint64_t thisFrameFence = m_nextFenceValue;

    // Wait for the frame this slot last belonged to, then reclaim it. Every
    // upload buffer indexed by m_frameIndex is free again once this returns.
    waitForFrame(m_frameIndex);

    FrameContext& frame = m_frames[m_frameIndex];
    id<MTLCommandBuffer> cb = [objc<id<MTLCommandQueue>>(m_queue) commandBuffer];
    cb.label = @"frame";
    ObjcRef cbRef = retainObjc(cb);
    m_textureCache.beginFrame(m_frameIndex, m_frameCounter, cbRef, &frame.garbage);

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

    // Resolve pass: pick or upload each active clip's texture. This has to
    // finish before any render pass opens, because the uploads are blits and
    // Metal allows one encoder at a time on a command buffer.
    std::vector<DrawItem> items;
    items.reserve(activeClips.size());
    for (const auto& ac : activeClips) {
        if (!ac.clip || ac.clip->uri.empty()) continue;

        const std::string& uri = ac.clip->uri;

        // Skip blob: and http(s): URIs -- the native renderer can't access these
        if (isRemoteUri(uri)) {
            static int blobWarn = 0;
            if (blobWarn++ % 600 == 0)
                printf("[App] Skipping blob/http URI: %.80s (use Add New button for native renderer)\n", uri.c_str());
            continue;
        }

        DrawItem item;
        item.ac = &ac;
        const CachedTexture* tex = nullptr;
        // Filled in from the frame being drawn, not from the decoder, so
        // the values always describe this picture.
        float cropScaleX = 1.0f, cropScaleY = 1.0f;
        float cropMaxX = 1.0f, cropMaxY = 1.0f;

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
                // Zero-copy path: the decoded picture's two planes, as they are.
                ObjcRef y = retainObjc(CVMetalTextureGetTexture(frame2->planeTex[0]));
                ObjcRef uv = retainObjc(CVMetalTextureGetTexture(frame2->planeTex[1]));
                tex = m_textureCache.registerNV12(texKey, y, uv, frame2->width, frame2->height);
            } else if (!frame2->pixels.empty()) {
                // CPU frames: software-decoded BGRA, or HAP's block-
                // compressed texture data, which uploads as what it is.
                if (isBlockCompressed(frame2->pixelFormat) && !m_bcSupported) {
                    static int bcWarn = 0;
                    if (bcWarn++ % 600 == 0) printf("[App] HAP needs BC textures, which this GPU lacks\n");
                    continue;
                }
                tex = m_textureCache.uploadPixels(texKey, frame2->pixels.data(),
                    frame2->width, frame2->height, frame2->pixelFormat);
                item.colorMode = frame2->ycocg ? 1.0f : 0.0f;
            }

            if (!tex) {
                static int uMiss = 0;
                if (uMiss++ % 300 == 0) printf("[App] texture failed for %s (%ux%u)\n", texKey.c_str(), frame2->width, frame2->height);
                continue;
            }

            if (tex->isNV12) {
                const ColorSpaceParams& p = decoder->colorSpace();
                item.colorSpace.yOffset = p.yOffset; item.colorSpace.yScale = p.yScale;
                item.colorSpace.cOffset = p.cOffset; item.colorSpace.cScale = p.cScale;
                item.colorSpace.kr = p.kr; item.colorSpace.kb = p.kb;
                item.colorSpace.uvScaleX = cropScaleX; item.colorSpace.uvScaleY = cropScaleY;
                item.colorSpace.uvMaxX = cropMaxX; item.colorSpace.uvMaxY = cropMaxY;
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
        item.texture = tex->texture;
        item.textureUV = tex->textureUV;
        item.width = tex->width;
        item.height = tex->height;
        item.nv12 = tex->isNV12;
        items.push_back(std::move(item));
    }
    m_textureCache.flushUploads();

    float renderMs = 0;

    for (auto& [id, screen] : m_screens) {
        if (!screen->isValid()) continue;
        // An occluded window may have no drawable to give; skip it this frame.
        if (!screen->acquireDrawable()) continue;
        ObjcRef target = screen->drawableTexture();

        // Get screen node position offset (from scene tree)
        float screenOffX = 0, screenOffY = 0;
        const ScreenNode* screenNode = m_scene.getScreen(id);
        if (screenNode) {
            screenOffX = (float)screenNode->position.x;
            screenOffY = (float)screenNode->position.y;
        }

        auto renderStart = std::chrono::steady_clock::now();
        const int sw = screen->width();
        const int sh = screen->height();

        // Clear to black and draw each active clip as a textured quad
        if (m_pipeline.beginScreen(cbRef, target, sw, sh, true)) {
            for (const auto& item : items) {
                TransformCB transform;
                EffectsCB effects;
                buildQuadConstants(*item.ac, screenOffX, screenOffY, sw, sh, item.width, item.height,
                                   item.colorMode, transform, effects);
                if (item.nv12) {
                    m_pipeline.drawVideoQuad(transform, effects, item.colorSpace, item.texture, item.textureUV);
                } else {
                    m_pipeline.drawQuad(transform, effects, item.texture);
                }
            }
            m_pipeline.endScreen();
        }

        // Record render time (clip drawing only, excluding debug overlay)
        {
            auto renderEnd = std::chrono::steady_clock::now();
            renderMs += (float)std::chrono::duration<double, std::milli>(renderEnd - renderStart).count();
        }

        // NDI: capture the designated screen now, with the picture complete
        // and before the operator overlay is composited onto it.
#if HAS_NDI
        if (m_ndiEnabled && m_ndiSender.isActive() &&
            (m_ndiSender.sourceScreen().empty() || m_ndiSender.sourceScreen() == id)) {
            m_ndiSender.capture(cbRef, target, thisFrameFence);
        }
#endif

        // Debug overlay: rasterised on the CPU, uploaded (only the rows it
        // touched) and composited in a second pass that keeps the picture.
        if (m_showDebug) {
            drawDebugOverlay(id, sw, sh, activeClips);

            std::string dbgKey = "__debug_" + id;
            const CachedTexture* dbgTex = m_textureCache.uploadRGBA(
                dbgKey, m_debugText.pixels(), m_debugText.width(), m_debugText.height(),
                m_debugText.dirtyTop(), m_debugText.dirtyBottom());
            m_textureCache.flushUploads();
            if (dbgTex && m_pipeline.beginScreen(cbRef, target, sw, sh, false)) {
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

                m_pipeline.drawQuad(dt, de, dbgTex->texture);
                m_pipeline.endScreen();
            }
        }

        screen->present(cbRef);
    }

    // Close this frame: the event value retires its upload buffers and any
    // decoder frame stamped with it. A command buffer that fails is the
    // nearest thing Metal has to a removed device.
    [cb encodeSignalEvent:objc<id<MTLSharedEvent>>(m_frameEvent) value:thisFrameFence];
    std::atomic<bool>* gpuError = &m_gpuError;
    [cb addCompletedHandler:^(id<MTLCommandBuffer> done) {
        if (done.error) {
            fprintf(stderr, "[App] Command buffer failed: %s\n", done.error.localizedDescription.UTF8String);
            gpuError->store(true);
        }
    }];
    [cb commit];

#if HAS_NDI
    if (m_ndiEnabled && m_ndiSender.isActive()) {
        m_ndiSender.send(m_frameEvent);
    }
#endif

    frame.fenceValue = thisFrameFence;
    m_nextFenceValue++;

    // Evict before advancing: anything retired here was still in use by the
    // frame just submitted.
    evictUnusedMedia();

    m_frameIndex = (m_frameIndex + 1) % FRAMES_IN_FLIGHT;
    m_frameCounter++;
    m_debugText.clearDirty();

    const float videoMs = activeVideoDecodeMs(activeClips);

    if (m_gpuError.load()) {
        // A sidecar process is cheap to relaunch; full device re-creation is
        // not worth the complexity here.
        fprintf(stderr, "[App] GPU error, exiting\n");
        if (m_statusReporter && !m_config.screenId.empty()) {
            m_statusReporter->reportError(m_config.screenId, "GPU device removed");
            m_statusReporter->flush();
        }
        m_exitCode = 2;
        m_running = false;
    }

    recordFrameStats(cpuStart, renderMs, videoMs);
}

FrameGarbage& App::currentGarbage() {
    return m_frames[m_frameIndex].garbage;
}

// --- Frame lifecycle -----------------------------------------------------

void App::waitForFrame(int index) {
    FrameContext& f = m_frames[index];
    id<MTLSharedEvent> event = objc<id<MTLSharedEvent>>(m_frameEvent);
    if (f.fenceValue != 0 && event.signaledValue < f.fenceValue) {
        if (![event waitUntilSignaledValue:f.fenceValue timeoutMS:kFrameWaitTimeoutMs]) {
            fprintf(stderr, "[App] Frame %llu never completed\n", (unsigned long long)f.fenceValue);
            m_gpuError.store(true);
        }
    }
    // Safe now: nothing on the GPU still references this frame's work.
    f.garbage.clear();
}

void App::waitForGpuIdle() {
    if (!m_queue || !m_frameEvent) return;
    @autoreleasepool {
        uint64_t v = m_nextFenceValue++;
        id<MTLSharedEvent> event = objc<id<MTLSharedEvent>>(m_frameEvent);
        id<MTLCommandBuffer> cb = [objc<id<MTLCommandQueue>>(m_queue) commandBuffer];
        cb.label = @"idle";
        [cb encodeSignalEvent:event value:v];
        [cb commit];
        if (event.signaledValue < v) {
            [event waitUntilSignaledValue:v timeoutMS:kFrameWaitTimeoutMs];
        }
    }
    for (auto& f : m_frames) f.garbage.clear();
}

DecoderParams App::decoderParams() {
    DecoderParams p;
    p.device = m_device;
    p.nv12Mode = m_nv12Active;
    p.verbose = m_config.verbose;
    p.sync.frameEvent = m_frameEvent;
    return p;
}

// --- Screens ---------------------------------------------------------------

void App::handleScreenOpen(const std::string& screenId, int width, int height,
                           const ScreenPlacement& placement) {
    if (m_screens.count(screenId)) {
        printf("[App] Screen %s already open\n", screenId.c_str());
        return;
    }

    // Vsync goes to the screen this process was launched for, or failing
    // that to whichever opens first while none has it.
    const bool vsync = m_vsyncScreenId.empty() &&
        (screenId == m_config.screenId || m_config.screenId.empty() || m_screens.empty());

    auto screen = std::make_unique<Screen>(screenId, width, height, placement, m_device, vsync);

    if (screen->isValid()) {
        if (vsync) m_vsyncScreenId = screenId;
        m_screens[screenId] = std::move(screen);
        m_statusReporter->reportReady(screenId);
        printf("[App] Opened screen %s (%dx%d)\n", screenId.c_str(), width, height);
    } else {
        m_statusReporter->reportError(screenId, "Failed to create window");
    }
}

void App::handleScreenClose(const std::string& screenId) {
    // The GPU may still be presenting from this window's drawables.
    waitForGpuIdle();
    m_screens.erase(screenId);
    if (m_vsyncScreenId == screenId) m_vsyncScreenId.clear();
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
    @autoreleasepool {
        m_screens.clear();
#if HAS_NDI
        m_ndiSender.shutdown();
#endif
        m_audioPlayers.clear();
        m_videoDecoders.clear();
        m_textureCache.shutdown();
        m_library.reset();
        m_frameEvent.reset();
        m_queue.reset();
        m_device.reset();
    }
    printf("[App] Shutdown complete\n");
}
