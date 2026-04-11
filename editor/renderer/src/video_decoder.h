#pragma once

#include <d3d12.h>
#include <d3d11.h>
#include <d3d11_1.h>
#include <d3d11on12.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <string>
#include <vector>
#include <deque>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <atomic>
#include <cstdint>

using Microsoft::WRL::ComPtr;

struct VideoFrame {
    // GPU path (DXVA): shared DXGI texture accessible by both D3D11 and D3D12
    ComPtr<ID3D12Resource>   d3d12Texture;   // D3D12 side of shared texture
    ComPtr<ID3D11Texture2D>  d3d11Shared;    // D3D11 side of shared texture (Phase 1)
    ComPtr<ID3D11Texture2D>  d3d11Source;    // D3D11 source texture to return (Phase 2 NV12)
    HANDLE                   sharedHandle = nullptr;

    // Software fallback: CPU pixel buffer (used only when DXVA is unavailable)
    std::vector<uint8_t> pixels;  // BGRA8

    uint32_t width = 0;
    uint32_t height = 0;
    double timestamp = -1.0;
    bool nv12 = false;  // true if d3d12Texture is NV12 format

    bool hasGpuTexture() const { return d3d12Texture != nullptr; }
};

// Video decoder with background thread and frame dealer.
//
// Four decode paths (best available is selected automatically):
//   NV12 zero-copy:        D3D11On12 DXVA decode → UnwrapUnderlyingResource → NV12 D3D12 texture
//   DXVA + shared texture: D3D11 DXVA decode → GPU copy to shared DXGI texture → BGRA D3D12 SRV
//   DXVA + CPU readback:   D3D11 DXVA decode → staging → CPU readback (no D3D12 device)
//   Software fallback:     CPU decode via MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING
//
// Background thread decodes ahead into a small pool of frames (writeable → readable).
// Render thread borrows the best frame for the current time.
class VideoDecoder {
public:
    ~VideoDecoder();

    // Open with shared DXVA resources (preferred) or standalone.
    // d3d12Device enables GPU-shared textures (zero-copy decode path).
    // d3d11On12Device + d3d12Queue + nv12Mode enables NV12 zero-copy via UnwrapUnderlyingResource.
    bool open(const std::string& filePath,
              ID3D12Device* d3d12Device = nullptr,
              ID3D11Device* sharedDevice = nullptr,
              IMFDXGIDeviceManager* sharedManager = nullptr,
              ID3D11On12Device2* d3d11On12Device = nullptr,
              ID3D12CommandQueue* d3d12Queue = nullptr,
              bool nv12Mode = false);
    void close();
    bool isOpen() const { return m_reader != nullptr; }

    const VideoFrame* getFrameAtTime(double timeSeconds);

    void setVerbose(bool v) { m_verbose = v; }

    uint32_t width() const { return m_width; }
    uint32_t height() const { return m_height; }
    double duration() const { return m_duration; }
    double fps() const { return m_fps; }
    bool isHardwareAccelerated() const { return m_dxvaActive; }

    // Stats
    int displayedFrames() const { return m_displayedFrames.load(); }
    int playbackDrops() const { return m_playbackDrops.load(); }
    int decodedFrames() const { return m_decodedFrames.load(); }
    int seekCount() const { return m_seekCount.load(); }
    int readableCount() const;

private:
    bool initDXVA(IDXGIAdapter1* adapter);
    bool configureDecoder();
    bool readOneFrame(VideoFrame& dest);
    void decodeThread();
    bool createSharedTexture(VideoFrame& frame);

    ComPtr<IMFSourceReader> m_reader;
    uint32_t m_width = 0;
    uint32_t m_height = 0;
    double m_duration = 0;
    double m_fps = 30.0;
    double m_frameDuration = 1.0 / 30.0;

    // D3D12 device for shared texture creation (not owned, borrowed from App)
    ID3D12Device* m_d3d12Device = nullptr;
    ID3D12CommandQueue* m_d3d12Queue = nullptr;  // for UnwrapUnderlyingResource

    // DXVA hardware decode resources (may be shared across decoders)
    ComPtr<ID3D11Device> m_d3d11Device;
    ComPtr<ID3D11DeviceContext> m_d3d11Ctx;
    ComPtr<IMFDXGIDeviceManager> m_dxgiManager;
    ID3D11On12Device2* m_d3d11On12 = nullptr;  // borrowed from App
    ComPtr<ID3D11Texture2D> m_staging;  // only used for CPU readback fallback
    bool m_ownsD3D11 = false; // true if we created the device (must release)
    bool m_dxvaActive = false;
    bool m_gpuSharing = false; // true if shared DXGI textures are in use
    bool m_nv12Mode = false;   // true if NV12 zero-copy via D3D11On12

    // Frame dealer
    static constexpr int POOL_SIZE = 4;
    std::deque<VideoFrame> m_writeable;
    std::deque<VideoFrame> m_readable;
    mutable std::mutex m_dealerMu;
    VideoFrame m_display;

    // Decode thread
    std::thread m_thread;
    std::atomic<bool> m_running{false};
    std::atomic<double> m_targetTime{0.0};

    // Seek
    std::mutex m_seekMu;
    std::condition_variable m_seekCv;
    bool m_seekRequested = false;
    double m_seekTime = 0.0;
    std::atomic<bool> m_seekJustHappened{false};

    // Stats
    std::atomic<int> m_displayedFrames{0};
    std::atomic<int> m_playbackDrops{0};
    std::atomic<int> m_decodedFrames{0};
    std::atomic<int> m_seekCount{0};
    bool m_verbose = false;
};
