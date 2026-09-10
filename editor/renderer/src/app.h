#pragma once

#include "event_queue.h"
#include "sse_client.h"
#include "status_reporter.h"
#include "scene.h"
#include "screen.h"
#include "render_pipeline.h"
#include "texture_cache.h"
#include "video_decoder.h"
#include "media_loader.h"
#include "audio_player.h"
#include "ndi_sender.h"
#include "debug_text.h"

#include <d3d12.h>
#include <d3d12sdklayers.h>
#include <d3d11.h>
#include <d3d11_4.h>
#include <d3d11on12.h>
#include <dxgi1_6.h>
#include <mfapi.h>
#include <mfidl.h>
#include <wrl/client.h>
#include <atomic>
#include <string>
#include <memory>
#include <unordered_map>

using Microsoft::WRL::ComPtr;

struct AppConfig {
    std::string host = "localhost";
    int port = 0;
    std::string screenId;  // initial screen (from CLI)
    std::string ndiScreenId;  // screen fed to NDI (defaults to screenId)
    int width = 1920;
    int height = 1080;
    bool verbose = false;
};

// Everything one in-flight frame owns. The command allocator may only be
// reset, and its retired resources released, once the GPU has passed this
// frame's fence value.
struct FrameContext {
    ComPtr<ID3D12CommandAllocator> alloc;
    UINT64 fenceValue = 0;
    FrameGarbage garbage;
};

// Main application: owns DX12 device, manages screens, runs render loop.
class App {
public:
    bool init(const AppConfig& config);
    int run();     // blocks until exit
    void shutdown();

private:
    void processEvents();
    void render();
    void handleScreenOpen(const std::string& screenId, int width, int height);
    void handleScreenClose(const std::string& screenId);

    // Frame lifecycle
    bool createFrameResources();
    void waitForFrame(int index);
    void waitForGpuIdle();
    bool createSyncFences();
    // Debug builds only: print anything the D3D12 debug layer has to say.
    // The debug layer writes to the debugger, which a sidecar process
    // launched from the editor has no way to show, so drain it to the log.
    void drainDebugMessages();

    // Media
    DecoderParams decoderParams() const;
    void prefetchMedia();
    void prefetchNearbyVideos();
    void drainLoader();
    void evictUnusedMedia();
    // Already-open decoder for a timeline item, or nullptr. Never blocks:
    // opening happens on the loader thread.
    VideoDecoder* findVideoDecoder(const std::string& key);
    AudioPlayer* getAudioPlayer(const std::string& key, const std::string& uri);
    static bool isVideoFile(const std::string& uri);
    // Cache key for a clip's texture. Data URIs are keyed by clip id so a
    // multi-megabyte string never becomes a map key hashed once per frame.
    static std::string textureKeyFor(const std::string& clipId, const std::string& uri);

    AppConfig m_config;

    // DX12 core
    ComPtr<IDXGIFactory4> m_factory;
    ComPtr<IDXGIAdapter1> m_adapter;
    ComPtr<ID3D12Device> m_device;
    ComPtr<ID3D12CommandQueue> m_cmdQueue;
    ComPtr<ID3D12GraphicsCommandList> m_cmdList;

    // Frame ring: one allocator, fence value and garbage list per in-flight
    // frame. Uploads, draws and presents all share this timeline, which is
    // what makes the texture cache's upload buffers and descriptor rings safe.
    FrameContext m_frames[FRAMES_IN_FLIGHT];
    ComPtr<ID3D12Fence> m_frameFence;
    HANDLE m_frameFenceEvent = nullptr;
    UINT64 m_nextFenceValue = 1;
    int m_frameIndex = 0;
    uint64_t m_frameCounter = 0;

    // Cross-API fences shared with the video decoders (see A4 in the review):
    //   m_frameFence / m_frameFence11 — D3D12 finished sampling a frame
    //   m_copyFence  / m_copyFence11  — D3D11 finished a decode copy
    ComPtr<ID3D11Fence> m_frameFence11;
    ComPtr<ID3D12Fence> m_copyFence;
    ComPtr<ID3D11Fence> m_copyFence11;
    std::atomic<UINT64> m_copyFenceCounter{0};

    // Shared D3D11 device for DXVA video decode (all decoders share this)
    // When D3D11On12 is active, this wraps the DX12 device for zero-copy video decode.
    ComPtr<ID3D11Device> m_d3d11Device;
    ComPtr<ID3D11DeviceContext> m_d3d11Context;
    ComPtr<ID3D11On12Device2> m_d3d11On12Device;  // non-null when D3D11On12 is active
    ComPtr<IMFDXGIDeviceManager> m_dxgiManager;
    bool m_nv12Active = false;  // true when D3D11On12 + NV12 path is available

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

    // Video decoders: keyed by timeline item id
    std::unordered_map<std::string, std::unique_ptr<VideoDecoder>> m_videoDecoders;

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

    // Debug overlay
    DebugText m_debugText;
    bool m_showDebug = true;

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

    ComPtr<ID3D12InfoQueue> m_infoQueue;

    bool m_running = false;
    int m_exitCode = 0;
};
