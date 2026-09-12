#pragma once

#include "event_queue.h"
#include "sse_client.h"
#include "status_reporter.h"
#include "scene.h"
#include "screen.h"
#include "render_pipeline.h"
#include "render_constants.h"
#include "texture_cache.h"
#include "video_decoder.h"
#include "decoder_params.h"
#include "media_loader.h"
#include "audio_player.h"
#include "ndi_sender.h"
#include "debug_text.h"

#ifdef _WIN32
#include <d3d12.h>
#include <d3d12sdklayers.h>
#include <d3d11.h>
#include <d3d11_4.h>
#include <d3d11on12.h>
#include <dxgi1_6.h>
#include <mfapi.h>
#include <mfidl.h>
#include <wrl/client.h>
#else
#include "objc_ref.h"
#endif
#include <atomic>
#include <chrono>
#include <cstdint>
#include <string>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>

#ifdef _WIN32
using Microsoft::WRL::ComPtr;
#endif

struct AppConfig {
    std::string host = "localhost";
    int port = 0;
    std::string screenId;  // initial screen (from CLI)
    std::string ndiScreenId;  // screen fed to NDI (defaults to screenId)
    std::string token;        // sidecar session token, sent with every request
    int width = 1920;
    int height = 1080;
    ScreenPlacement placement;  // where the initial window goes
    bool verbose = false;
    // Whether this process plays the soundtrack. The editor launches one
    // process per screen and every one of them received the whole timeline,
    // so two native outputs meant two copies of the audio, independently
    // timed. The editor now names exactly one owner.
    bool audio = true;
    // Start with the diagnostics overlay shown. Off by default because it is
    // composited onto the output; F3 toggles it either way.
    bool overlay = false;
};

// Everything one in-flight frame owns. The frame's resources may only be
// reused, and its retired resources released, once the GPU has passed this
// frame's fence value.
struct FrameContext {
#ifdef _WIN32
    ComPtr<ID3D12CommandAllocator> alloc;
    UINT64 fenceValue = 0;
#else
    uint64_t fenceValue = 0;
#endif
    FrameGarbage garbage;
};

// Main application: owns the GPU device, manages screens, runs the render
// loop. The timeline, transport, media bookkeeping and overlay text are
// platform-neutral (app_common.cpp); device setup, frame submission and
// window management are per platform (win/app_win.cpp, mac/app_mac.mm).
class App {
public:
    bool init(const AppConfig& config);
    int run();     // blocks until exit
    void shutdown();

private:
    // --- Shared (app_common.cpp) -----------------------------------------
    void processEvents();
    // Apply the position this instant, when a transport anchor is driving.
    void advanceTransport();

    // Media
    void prefetchMedia();
    void prefetchNearbyVideos();
    void drainLoader();
    void evictUnusedMedia();
    void reconcileMedia();
    // Already-open decoder for a timeline item, or nullptr. Never blocks:
    // opening happens on the loader thread.
    VideoDecoder* findVideoDecoder(const std::string& key);
    AudioPlayer* getAudioPlayer(const std::string& key, const std::string& uri);
    static bool isVideoFile(const std::string& uri);
    // Cache key for a clip's texture. Data URIs are keyed by clip id so a
    // multi-megabyte string never becomes a map key hashed once per frame.
    static std::string textureKeyFor(const std::string& clipId, const std::string& uri);

    // Play, pause and re-seek the audio players for this frame's active
    // clips. Only the process the editor named as the audio owner does any
    // of this.
    void syncAudio(const std::vector<ActiveClip>& activeClips);
    // The quad a clip draws as on a screen: position, size and effects.
    void buildQuadConstants(const ActiveClip& ac, float screenOffX, float screenOffY,
                            int screenW, int screenH, uint32_t texW, uint32_t texH,
                            float colorMode, TransformCB& transform, EffectsCB& effects) const;
    // Rasterise the operator overlay for one screen into m_debugText.
    void drawDebugOverlay(const std::string& screenId, int screenW, int screenH,
                          const std::vector<ActiveClip>& activeClips);
    // Smoothed decode cost of every video active this frame.
    float activeVideoDecodeMs(const std::vector<ActiveClip>& activeClips) const;
    // Once per frame, after submission: fps, perf history, the stats line.
    void recordFrameStats(std::chrono::steady_clock::time_point cpuStart,
                          float renderMs, float videoMs);

    // --- Per platform ------------------------------------------------------
    void render();
    void handleScreenOpen(const std::string& screenId, int width, int height,
                          const ScreenPlacement& placement = {});
    void handleScreenClose(const std::string& screenId);
    void waitForFrame(int index);
    void waitForGpuIdle();
    DecoderParams decoderParams();
    // The garbage list of the frame being built, for resources retired now.
    FrameGarbage& currentGarbage();

#ifdef _WIN32
    bool createFrameResources();
    bool createSyncFences();
    // Debug builds only: print anything the D3D12 debug layer has to say.
    // The debug layer writes to the debugger, which a sidecar process
    // launched from the editor has no way to show, so drain it to the log.
    void drainDebugMessages();
#else
    bool createDevice();
    bool pumpEvents();   // Cocoa events; false once the app should exit
    void handleKey(unsigned short keyCode, const std::string& chars);
#endif

    AppConfig m_config;

#ifdef _WIN32
    // DX12 core
    ComPtr<IDXGIFactory4> m_factory;
    ComPtr<IDXGIAdapter1> m_adapter;
    ComPtr<ID3D12Device> m_device;
    ComPtr<ID3D12CommandQueue> m_cmdQueue;
    ComPtr<ID3D12GraphicsCommandList> m_cmdList;

    ComPtr<ID3D12Fence> m_frameFence;
    HANDLE m_frameFenceEvent = nullptr;

    // D3D11 copy completion is shared with the render queue. Decoders check
    // m_frameFence on the CPU before reusing a texture sampled by D3D12.
    ComPtr<ID3D12Fence> m_copyFence;
    ComPtr<ID3D11Fence> m_copyFence11;
    std::atomic<UINT64> m_copyFenceCounter{0};
    std::mutex m_copySignalMutex;

    // Shared D3D11 device for DXVA video decode (all decoders share this)
    // When D3D11On12 is active, this wraps the DX12 device for zero-copy video decode.
    ComPtr<ID3D11Device> m_d3d11Device;
    ComPtr<ID3D11DeviceContext> m_d3d11Context;
    ComPtr<ID3D11On12Device2> m_d3d11On12Device;  // non-null when D3D11On12 is active
    ComPtr<IMFDXGIDeviceManager> m_dxgiManager;

    ComPtr<ID3D12InfoQueue> m_infoQueue;
#else
    // Metal core. Objective-C objects behind plain C++ handles so this header
    // stays C++; app_mac.mm bridges them.
    ObjcRef m_device;       // id<MTLDevice>
    ObjcRef m_queue;        // id<MTLCommandQueue>
    ObjcRef m_frameEvent;   // id<MTLSharedEvent>: the frame fence
    ObjcRef m_library;      // id<MTLLibrary>
    // A command buffer that completed with an error. Metal has no
    // device-removed reason; this is the nearest equivalent.
    std::atomic<bool> m_gpuError{false};
    bool m_bcSupported = true;
    // The one screen whose layer waits for vsync; the others present as soon
    // as they can, so two windows do not halve the frame rate.
    std::string m_vsyncScreenId;
#endif

    // Frame ring: one context, fence value and garbage list per in-flight
    // frame. Uploads, draws and presents all share this timeline, which is
    // what makes the texture cache's upload buffers safe.
    FrameContext m_frames[FRAMES_IN_FLIGHT];
    uint64_t m_nextFenceValue = 1;
    int m_frameIndex = 0;
    uint64_t m_frameCounter = 0;
    bool m_nv12Active = false;  // true when a zero-copy NV12 path is available

    // Screens
    std::unordered_map<std::string, std::unique_ptr<Screen>> m_screens;

    // Pipeline & textures
    RenderPipeline m_pipeline;
    TextureCache m_textureCache;
    MediaLoader m_mediaLoader;

    // Scene state
    Scene m_scene;
    double m_currentTime = 0;
    bool m_playing = false;

    // Transport.
    //
    // The editor used to send a position per frame and this process did
    // nothing but store it, so the picture here advanced at the editor
    // window's paint rate and stalled when that window was occluded. The
    // shell now sends an anchor instead, and the position between anchors is
    // computed here from this machine's own monotonic clock.
    //
    // m_transportDriven records that at least one anchor has arrived. Until
    // one does, the older "time" and "control" events still apply, so this
    // build keeps working against a shell that predates them.
    bool m_transportDriven = false;
    double m_transportAnchorTime = 0;
    double m_transportRate = 1.0;
    unsigned long long m_transportSeq = 0;
    std::chrono::steady_clock::time_point m_transportAnchorAt{};

    // Video decoders: keyed by timeline item id
    std::unordered_map<std::string, std::unique_ptr<VideoDecoder>> m_videoDecoders;
    std::unordered_map<std::string, std::string> m_videoUris;

    // Audio players: keyed by timeline item id (for videos with audio)
    std::unordered_map<std::string, std::unique_ptr<AudioPlayer>> m_audioPlayers;
    bool m_wasPlaying = false;  // track play state for audio sync
    // Last position each player was scrubbed to, so a paused frame that did
    // not move the playhead does not re-issue a blocking seek.
    std::unordered_map<std::string, double> m_lastAudioSeek;
    // Frame each decoder/player was last needed, for eviction.
    std::unordered_map<std::string, uint64_t> m_mediaLastUsed;

    // NDI output
    NDISender m_ndiSender;
    bool m_ndiEnabled = true;

    // Debug overlay. Off by default: it is composited onto the output, so it
    // reached the audience -- and the NDI feed -- on every new screen until
    // someone pressed F3.
    DebugText m_debugText;
    bool m_showDebug = false;

    // Frame stats
    int m_frameCount = 0;
    int m_eventsProcessed = 0;
    double m_fps = 0;
    std::chrono::steady_clock::time_point m_lastStatTime;

    // Performance graph history (ring buffers, CPU-side only)
    static constexpr int PERF_HISTORY = 120;  // ~2 seconds at 60fps
    float m_cpuFrameTimes[PERF_HISTORY] = {};
    float m_renderTimes[PERF_HISTORY] = {};     // CPU time spent in render()
    float m_videoDecodeTimes[PERF_HISTORY] = {};
    int m_perfHead = 0;

    // Communication
    EventQueue m_eventQueue;
    std::unique_ptr<SSEClient> m_sseClient;
    std::unique_ptr<StatusReporter> m_statusReporter;

    bool m_running = false;
    int m_exitCode = 0;
};
