#pragma once

#include <d3d12.h>
#include <d3d11.h>
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
    std::vector<uint8_t> pixels;  // BGRA8
    uint32_t width = 0;
    uint32_t height = 0;
    double timestamp = -1.0;
};

// Video decoder with background thread and frame dealer.
//
// Two decode paths:
//   DXVA (default): D3D11 device manager → GPU decode → readback to CPU
//   Software fallback: CPU decode via MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING
//
// Background thread decodes ahead into a small pool of frames (writeable → readable).
// Render thread borrows the best frame for the current time.
class VideoDecoder {
public:
    ~VideoDecoder();

    // Open with shared DXVA resources (preferred) or standalone
    bool open(const std::string& filePath,
              ID3D11Device* sharedDevice = nullptr,
              IMFDXGIDeviceManager* sharedManager = nullptr);
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

    ComPtr<IMFSourceReader> m_reader;
    uint32_t m_width = 0;
    uint32_t m_height = 0;
    double m_duration = 0;
    double m_fps = 30.0;
    double m_frameDuration = 1.0 / 30.0;

    // DXVA hardware decode resources (may be shared across decoders)
    ComPtr<ID3D11Device> m_d3d11Device;
    ComPtr<ID3D11DeviceContext> m_d3d11Ctx;
    ComPtr<IMFDXGIDeviceManager> m_dxgiManager;
    ComPtr<ID3D11Texture2D> m_staging;
    bool m_ownsD3D11 = false; // true if we created the device (must release)
    bool m_dxvaActive = false;

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
