#pragma once

#include <d3d12.h>
#include <d3d11.h>
#include <d3d11_1.h>
#include <d3d11_4.h>  // ID3D11Fence, ID3D11DeviceContext4 (cross-API sync)
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

// Colour conversion parameters for the NV12 shader, read from the stream's
// MF_MT_VIDEO_NOMINAL_RANGE and MF_MT_YUV_MATRIX rather than hard-coded to
// BT.709 limited range (which made SD and full-range content look wrong).
struct ColorSpaceParams {
    float yOffset = 16.0f / 255.0f;
    float yScale = 255.0f / 219.0f;
    float cOffset = 128.0f / 255.0f;
    float cScale = 255.0f / 224.0f;
    float kr = 0.2126f;   // BT.709
    float kb = 0.0722f;
    float pad0 = 0.0f;
    float pad1 = 0.0f;
};

// A frame in the decoder's pool.
//
// Move-only with a destructor: frames used to leak their NT shared handle
// whenever one was dropped outside close().
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

    // Cross-API synchronisation (see App's frame fence and the decoder's copy fence)
    UINT64 copyFenceValue = 0;     // D3D11 copy into this frame completes at this value
    UINT64 releaseFenceValue = 0;  // D3D12 finished sampling it at this frame fence value

    VideoFrame() = default;
    VideoFrame(const VideoFrame&) = delete;
    VideoFrame& operator=(const VideoFrame&) = delete;
    VideoFrame(VideoFrame&& o) noexcept { steal(o); }
    VideoFrame& operator=(VideoFrame&& o) noexcept {
        if (this != &o) { closeHandle(); steal(o); }
        return *this;
    }
    ~VideoFrame() { closeHandle(); }

    bool hasGpuTexture() const { return d3d12Texture != nullptr; }

private:
    void closeHandle() {
        if (sharedHandle) { CloseHandle(sharedHandle); sharedHandle = nullptr; }
    }
    void steal(VideoFrame& o) {
        d3d12Texture = std::move(o.d3d12Texture);
        d3d11Shared = std::move(o.d3d11Shared);
        d3d11Source = std::move(o.d3d11Source);
        sharedHandle = o.sharedHandle;
        o.sharedHandle = nullptr;   // the moved-from frame must not close it
        pixels = std::move(o.pixels);
        width = o.width;
        height = o.height;
        timestamp = o.timestamp;
        nv12 = o.nv12;
        copyFenceValue = o.copyFenceValue;
        releaseFenceValue = o.releaseFenceValue;
        o.width = o.height = 0;
        o.timestamp = -1.0;
        o.nv12 = false;
        o.copyFenceValue = o.releaseFenceValue = 0;
    }
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

    // `currentFrameFence` is the value App will signal at the end of the frame
    // being built. The frame this call displaces is stamped with it so the
    // decode thread can wait for D3D12 to finish reading before overwriting.
    const VideoFrame* getFrameAtTime(double timeSeconds, UINT64 currentFrameFence = 0);

    // Shared fences for cross-API synchronisation. Both are owned by App:
    //   frameFence  — signalled by the D3D12 queue at end of frame
    //   copyFence   — signalled by D3D11 after a decode copy, waited on by D3D12
    void setSyncFences(ID3D12Fence* frameFence, ID3D11Fence* frameFence11,
                       ID3D12Fence* copyFence, ID3D11Fence* copyFence11,
                       std::atomic<UINT64>* copyFenceCounter);

    // Highest copy-fence value among frames handed out since the last call.
    UINT64 takePendingCopyFence() { return m_pendingCopyFence.exchange(0); }

    void setVerbose(bool v) { m_verbose = v; }

    uint32_t width() const { return m_width; }
    uint32_t height() const { return m_height; }
    double duration() const { return m_duration; }
    double fps() const { return m_fps; }
    bool isHardwareAccelerated() const { return m_dxvaActive; }
    const char* codecName() const { return m_codecName; }
    const ColorSpaceParams& colorSpace() const { return m_colorSpace; }

    // Smoothed cost of one readOneFrame() call, measured in the decode thread.
    double decodeMs() const { return m_decodeMs.load(); }

    // Stats
    int displayedFrames() const { return m_displayedFrames.load(); }
    int playbackDrops() const { return m_playbackDrops.load(); }
    int decodedFrames() const { return m_decodedFrames.load(); }
    int seekCount() const { return m_seekCount.load(); }
    int readableCount() const;

    // How the decoder is producing frames. Chosen once in open() and never
    // changed afterwards; the old per-frame `goto bgra_fallback` cleared
    // m_nv12Mode mid-stream while the reader kept emitting NV12, so the CPU
    // readback path then copied width*4 bytes per row out of an NV12 buffer.
    enum class Mode { NV12, DxvaRgb32, Software };

private:
    bool initDXVA(IDXGIAdapter1* adapter);
    bool tryOpen(const std::wstring& wpath, Mode mode);
    bool probeNV12();
    bool configureDecoder(Mode mode);
    void readColorSpace(IMFMediaType* type);
    bool readOneFrame(VideoFrame& dest);
    void decodeThread();
    bool createSharedTexture(VideoFrame& frame);
    // Take a frame from the writeable pool, waiting for one if necessary.
    bool borrowFrame(VideoFrame& out);
    void recycle(VideoFrame&& f);
    bool writeNV12Frame(VideoFrame& dest, ID3D11Texture2D* src, UINT subIdx);
    void waitForRenderRelease(VideoFrame& frame);
    void signalCopyDone(VideoFrame& frame);

    ComPtr<IMFSourceReader> m_reader;
    uint32_t m_width = 0;
    uint32_t m_height = 0;
    double m_duration = 0;
    double m_fps = 30.0;
    double m_frameDuration = 1.0 / 30.0;
    const char* m_codecName = "unknown";

    // D3D12 device for shared texture creation (not owned, borrowed from App)
    ID3D12Device* m_d3d12Device = nullptr;
    ID3D12CommandQueue* m_d3d12Queue = nullptr;  // for UnwrapUnderlyingResource

    // DXVA hardware decode resources (may be shared across decoders)
    ComPtr<ID3D11Device> m_d3d11Device;
    ComPtr<ID3D11DeviceContext> m_d3d11Ctx;
    ComPtr<IMFDXGIDeviceManager> m_dxgiManager;
    ID3D11On12Device2* m_d3d11On12 = nullptr;  // borrowed from App
    // True when the D3D11 device submits to the same D3D12 queue we render
    // on (i.e. it is the D3D11On12 device). In that configuration in-order
    // execution already orders decode copies against sampling, and inserting
    // a GPU wait for a fence that same queue signals *later* deadlocks it.
    bool m_sharesRenderQueue = false;
    ComPtr<ID3D11Texture2D> m_staging;  // only used for CPU readback fallback
    bool m_ownsD3D11 = false; // true if we created the device (must release)
    bool m_dxvaAvailable = false; // a usable D3D11/DXVA device exists
    bool m_dxvaActive = false;
    bool m_gpuSharing = false; // true if shared DXGI textures are in use
    bool m_nv12Mode = false;   // true if NV12 zero-copy via D3D11On12
    Mode m_mode = Mode::Software;
    ColorSpaceParams m_colorSpace;

    // Cross-API fences (borrowed from App; may all be null)
    ID3D12Fence* m_frameFence = nullptr;
    ComPtr<ID3D11Fence> m_frameFence11;
    ComPtr<ID3D11Fence> m_copyFence11;
    ID3D12Fence* m_copyFence = nullptr;
    std::atomic<UINT64>* m_copyFenceCounter = nullptr;
    std::atomic<UINT64> m_pendingCopyFence{0};

    // Frame dealer
    static constexpr int POOL_SIZE = 4;
    std::deque<VideoFrame> m_writeable;
    std::deque<VideoFrame> m_readable;
    mutable std::mutex m_dealerMu;
    // Signalled whenever a frame is returned to m_writeable, so the decode
    // thread can wait for one instead of polling every 2 ms.
    std::condition_variable m_writeableCv;
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
    std::atomic<double> m_decodeMs{0.0};
    bool m_verbose = false;
};
