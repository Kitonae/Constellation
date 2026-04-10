#pragma once

#include "event_queue.h"
#include "sse_client.h"
#include "status_reporter.h"
#include "scene.h"
#include "screen.h"
#include "render_pipeline.h"
#include "texture_cache.h"
#include "video_decoder.h"
#include "debug_text.h"

#include <d3d12.h>
#include <d3d11.h>
#include <dxgi1_6.h>
#include <mfapi.h>
#include <mfidl.h>
#include <wrl/client.h>
#include <string>
#include <memory>
#include <unordered_map>

using Microsoft::WRL::ComPtr;

struct AppConfig {
    std::string host = "localhost";
    int port = 0;
    std::string screenId;  // initial screen (from CLI)
    int width = 1920;
    int height = 1080;
    bool verbose = false;
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

    // Get or create a video decoder for a media URI. Returns nullptr for non-video.
    VideoDecoder* getVideoDecoder(const std::string& uri);
    static bool isVideoFile(const std::string& uri);

    AppConfig m_config;

    // DX12 core
    ComPtr<IDXGIFactory4> m_factory;
    ComPtr<IDXGIAdapter1> m_adapter;
    ComPtr<ID3D12Device> m_device;
    ComPtr<ID3D12CommandQueue> m_cmdQueue;
    ComPtr<ID3D12GraphicsCommandList> m_cmdList;

    // Shared D3D11 device for DXVA video decode (all decoders share this)
    ComPtr<ID3D11Device> m_d3d11Device;
    ComPtr<IMFDXGIDeviceManager> m_dxgiManager;

    // Screens
    std::unordered_map<std::string, std::unique_ptr<Screen>> m_screens;

    // Pipeline & textures
    RenderPipeline m_pipeline;
    TextureCache m_textureCache;

    // Scene state
    Scene m_scene;
    double m_currentTime = 0;
    bool m_playing = false;

    // Video decoders: keyed by media URI
    std::unordered_map<std::string, std::unique_ptr<VideoDecoder>> m_videoDecoders;

    // Debug overlay
    DebugText m_debugText;
    bool m_showDebug = true;

    // Frame stats
    int m_frameCount = 0;
    int m_eventsProcessed = 0;
    double m_fps = 0;
    std::chrono::steady_clock::time_point m_lastStatTime;

    // Communication
    EventQueue m_eventQueue;
    std::unique_ptr<SSEClient> m_sseClient;
    std::unique_ptr<StatusReporter> m_statusReporter;

    bool m_running = false;
};
