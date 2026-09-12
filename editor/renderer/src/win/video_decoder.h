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
#include <memory>

#include "d3d12_video_decoder.h"
#include "hap_decoder.h"
#include "pixel_format.h"
#include "render_constants.h"

struct DecoderParams;

using Microsoft::WRL::ComPtr;

// Installed before decoding starts and immutable until the worker is joined.
struct DecoderSync {
    ComPtr<ID3D12Fence> frameFence;
    ComPtr<ID3D11Fence> copyFence11;
    std::atomic<UINT64>* copyFenceCounter = nullptr;
    std::mutex* copySignalMutex = nullptr;
};

// Colour conversion parameters (ColorSpaceParams, render_constants.h) are
// read from the stream's MF_MT_VIDEO_NOMINAL_RANGE and MF_MT_YUV_MATRIX rather
// than hard-coded to BT.709 limited range (which made SD and full-range
// content look wrong).

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
    // Allocated size of d3d12Texture when it is larger than the picture. H.264
    // codes whole macroblocks, so a 1080-line picture is decoded into a
    // 1088-line surface and the renderer has to know where to stop. Zero means
    // the texture is an exact fit.
    uint32_t codedWidth = 0;
    uint32_t codedHeight = 0;
    double timestamp = -1.0;
    bool nv12 = false;  // true if d3d12Texture is NV12 format

    // CPU frames: what the bytes in `pixels` are. BGRA for the software
    // paths; a block-compressed format for HAP, whose frames *are* texture
    // blocks and go up exactly as they arrived.
    PixelFormat pixelFormat = PixelFormat::BGRA8;
    // Hap Q stores scaled YCoCg in its DXT5 blocks; the shader converts.
    bool ycocg = false;

    // Cross-API synchronisation (see App's frame fence and the decoder's copy fence)
    UINT64 copyFenceValue = 0;     // D3D11 copy into this frame completes at this value
    UINT64 releaseFenceValue = 0;  // D3D12 finished sampling it at this frame fence value

    // D3D12 video decode: the decode queue runs ahead of the render queue, so
    // the render queue has to wait for this value before sampling the texture.
    ID3D12Fence* decodeFence = nullptr;   // borrowed from the decoder
    UINT64 decodeFenceValue = 0;

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
        codedWidth = o.codedWidth;
        codedHeight = o.codedHeight;
        timestamp = o.timestamp;
        nv12 = o.nv12;
        pixelFormat = o.pixelFormat;
        ycocg = o.ycocg;
        copyFenceValue = o.copyFenceValue;
        releaseFenceValue = o.releaseFenceValue;
        decodeFence = o.decodeFence;
        decodeFenceValue = o.decodeFenceValue;
        o.width = o.height = 0;
        o.codedWidth = o.codedHeight = 0;
        o.timestamp = -1.0;
        o.nv12 = false;
        o.pixelFormat = PixelFormat::BGRA8;
        o.ycocg = false;
        o.copyFenceValue = o.releaseFenceValue = 0;
        o.decodeFence = nullptr;
        o.decodeFenceValue = 0;
    }
};

// Video decoder with background thread and frame dealer.
//
// Six decode paths (best available is selected automatically):
//   HAP:                   MF demux only → Snappy → DXT/BC blocks uploaded as the texture
//   D3D12 video decode:    MF demux only → H264Parser → DecodeFrame → NV12 D3D12 texture
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
              bool nv12Mode = false,
              const DecoderSync& sync = {});
    // The same, with everything App supplies gathered in one struct. This
    // is the form the shared loader calls.
    bool open(const std::string& filePath, const DecoderParams& params);
    void close();
    bool isOpen() const { return m_reader != nullptr; }

    // `currentFrameFence` is the value App will signal at the end of the frame
    // being built. The frame this call displaces is stamped with it so the
    // decode thread can wait for D3D12 to finish reading before overwriting.
    const VideoFrame* getFrameAtTime(double timeSeconds, UINT64 currentFrameFence = 0);

    // Highest copy-fence value among frames handed out since the last call.
    UINT64 takePendingCopyFence() { return m_pendingCopyFence.exchange(0); }

    void setVerbose(bool v) { m_verbose = v; }

    uint32_t width() const { return m_width; }
    uint32_t height() const { return m_height; }
    double duration() const { return m_duration; }
    double fps() const { return m_fps; }
    bool isHardwareAccelerated() const { return m_dxvaActive; }
    /** Short label for the overlay: how the picture is being produced. */
    const char* accelLabel() const {
        return m_dxvaActive ? "DXVA+GPU" : (m_mode == Mode::Hap ? "TEXTURE" : "SW");
    }
    /** HAP: no decoder at all, the frames are the texture. */
    bool isTextureCodec() const { return m_mode == Mode::Hap; }
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
    enum class Mode { Hap, D3D12, NV12, DxvaRgb32, Software };

private:
    friend struct RendererTestAccess;
    bool initDXVA(IDXGIAdapter1* adapter);
    bool tryOpen(const std::wstring& wpath, Mode mode);
    bool tryOpenD3D12(const std::wstring& wpath);
    bool tryOpenHap(const std::wstring& wpath);
    bool readHapFrame(VideoFrame& dest);
    bool probeNV12();
    bool probeD3D12();
    bool configureDecoder(Mode mode);
    bool configureCompressed();
    bool readD3D12Frame(VideoFrame& dest);
    void releaseD3D12Picture(VideoFrame& frame);
    void readColorSpace(IMFMediaType* type);
    void applySpsColorSpace(const H264SPS& sps);
    bool readOneFrame(VideoFrame& dest);
    void decodeThread();
    bool createSharedTexture(VideoFrame& frame);
    // Take a frame from the writeable pool, waiting for one if necessary.
    bool borrowFrame(VideoFrame& out);
    void recycle(VideoFrame&& f);
    bool writeNV12Frame(VideoFrame& dest, ID3D11Texture2D* src, UINT subIdx);
    void signalCopyDone(VideoFrame& frame);

    ComPtr<IMFSourceReader> m_reader;
    uint32_t m_width = 0;
    uint32_t m_height = 0;
    double m_duration = 0;
    double m_fps = 30.0;
    double m_frameDuration = 1.0 / 30.0;
    LONG m_defaultStride = 0;
    const char* m_codecName = "unknown";

    // D3D12 device for shared texture creation (not owned, borrowed from App)
    ID3D12Device* m_d3d12Device = nullptr;
    ID3D12CommandQueue* m_d3d12Queue = nullptr;  // for UnwrapUnderlyingResource

    // DXVA hardware decode resources (may be shared across decoders)
    ComPtr<ID3D11Device> m_d3d11Device;
    ComPtr<ID3D11DeviceContext> m_d3d11Ctx;
    ComPtr<IMFDXGIDeviceManager> m_dxgiManager;
    ID3D11On12Device2* m_d3d11On12 = nullptr;  // borrowed from App
    // D3D11On12 copies use the render queue, so they do not need a separate
    // copy-completion fence. Frame reuse still waits for retirement on the CPU.
    bool m_sharesRenderQueue = false;
    ComPtr<ID3D11Texture2D> m_staging;  // only used for CPU readback fallback
    bool m_ownsD3D11 = false; // true if we created the device (must release)
    bool m_dxvaAvailable = false; // a usable D3D11/DXVA device exists
    bool m_dxvaActive = false;
    bool m_gpuSharing = false; // true if shared DXGI textures are in use
    bool m_nv12Mode = false;   // true if NV12 zero-copy via D3D11On12
    Mode m_mode = Mode::Software;

    // D3D12 video decode. Owns the decoded pictures the frames point at, so
    // it must outlive every frame in the pool.
    std::unique_ptr<D3D12VideoDecoder> m_d3d12Decoder;
    std::vector<uint8_t> m_seqHeader;   // out-of-band SPS/PPS from the container

    // HAP: which variant the container declares. Frames say for themselves
    // what they hold; this is for the label and for refusing what the
    // renderer cannot show before a single sample is read.
    HapFormat m_hapFormat = HapFormat::Unknown;
    ColorSpaceParams m_colorSpace;

    DecoderSync m_sync;
    std::atomic<UINT64> m_pendingCopyFence{0};

    // Frame dealer
    // Enough for a decoder that hands frames back in presentation order. The
    // D3D12 path returns them in decode order and raises this to cover the
    // stream's reorder window; see tryOpenD3D12.
    static constexpr int POOL_SIZE = 4;
    int m_poolSize = POOL_SIZE;
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
