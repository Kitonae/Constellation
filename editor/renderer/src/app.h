#pragma once

#include "event_queue.h"
#include "sse_client.h"
#include "status_reporter.h"
#include "scene.h"
#include "screen.h"
#include "render_pipeline.h"
#include "texture_cache.h"

#include <d3d12.h>
#include <dxgi1_6.h>
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

    AppConfig m_config;

    // DX12 core
    ComPtr<IDXGIFactory4> m_factory;
    ComPtr<ID3D12Device> m_device;
    ComPtr<ID3D12CommandQueue> m_cmdQueue;
    ComPtr<ID3D12GraphicsCommandList> m_cmdList;

    // Screens
    std::unordered_map<std::string, std::unique_ptr<Screen>> m_screens;

    // Pipeline & textures
    RenderPipeline m_pipeline;
    TextureCache m_textureCache;

    // Scene state
    Scene m_scene;
    double m_currentTime = 0;
    bool m_playing = false;

    // Communication
    EventQueue m_eventQueue;
    std::unique_ptr<SSEClient> m_sseClient;
    std::unique_ptr<StatusReporter> m_statusReporter;

    bool m_running = false;
};
