#pragma once
// Video decoding on macOS.
//
// AVFoundation demultiplexes; VideoToolbox decodes. Three paths, chosen once
// in open():
//   HAP:      passthrough samples -> Snappy -> BC blocks uploaded as the texture
//   NV12:     AVAssetReader decodes to IOSurface-backed CVPixelBuffers, whose
//             two planes become Metal textures with no copy
//   Software: AVAssetReader decodes to BGRA and the pixels are copied out
//             (headless thumbnail and probe runs, or no NV12 pipeline)
//
// Background thread decodes ahead into a small pool of frames (writeable ->
// readable). Render thread borrows the best frame for the current time. The
// dealer, seek and catch-up logic mirror win/video_decoder.cpp; only the
// source of frames differs.

#include "hap_decoder.h"
#include "objc_ref.h"
#include "pixel_format.h"
#include "render_constants.h"

#include <CoreVideo/CoreVideo.h>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

struct DecoderParams;

// Installed before decoding starts and immutable until the worker is joined.
struct DecoderSync {
    ObjcRef frameEvent;   // id<MTLSharedEvent>: the render timeline
};

// A frame in the decoder's pool. Move-only: the pixel buffer and its Metal
// plane textures are released exactly once.
struct VideoFrame {
    // GPU path: the decoded picture and its two plane textures (Y, UV). The
    // planes are CVMetalTextureRefs, which the SDK declares only for
    // Objective-C; they are the same CoreFoundation type as an image buffer.
    CVPixelBufferRef pixelBuffer = nullptr;
    CVImageBufferRef planeTex[2] = { nullptr, nullptr };

    // CPU path: BGRA8 pixels, or HAP's block-compressed texture data.
    std::vector<uint8_t> pixels;

    uint32_t width = 0;
    uint32_t height = 0;
    // Allocated size when the texture is larger than the picture; zero means
    // an exact fit. VideoToolbox output is already cropped, so these stay
    // zero here and exist for parity with the Windows frame.
    uint32_t codedWidth = 0;
    uint32_t codedHeight = 0;
    double timestamp = -1.0;
    bool nv12 = false;
    PixelFormat pixelFormat = PixelFormat::BGRA8;
    // Hap Q stores scaled YCoCg in its DXT5 blocks; the shader converts.
    bool ycocg = false;

    // Render timeline value at which the renderer finished sampling this
    // frame; zero means it was never handed out.
    uint64_t releaseFenceValue = 0;

    VideoFrame() = default;
    VideoFrame(const VideoFrame&) = delete;
    VideoFrame& operator=(const VideoFrame&) = delete;
    VideoFrame(VideoFrame&& o) noexcept { steal(o); }
    VideoFrame& operator=(VideoFrame&& o) noexcept {
        if (this != &o) { releaseGpu(); steal(o); }
        return *this;
    }
    ~VideoFrame() { releaseGpu(); }

    bool hasGpuTexture() const { return planeTex[0] != nullptr; }

    void releaseGpu() {
        for (auto& t : planeTex) { if (t) { CFRelease(t); t = nullptr; } }
        if (pixelBuffer) { CVPixelBufferRelease(pixelBuffer); pixelBuffer = nullptr; }
    }

private:
    void steal(VideoFrame& o) {
        pixelBuffer = o.pixelBuffer; o.pixelBuffer = nullptr;
        planeTex[0] = o.planeTex[0]; planeTex[1] = o.planeTex[1];
        o.planeTex[0] = o.planeTex[1] = nullptr;
        pixels = std::move(o.pixels);
        width = o.width; height = o.height;
        codedWidth = o.codedWidth; codedHeight = o.codedHeight;
        timestamp = o.timestamp;
        nv12 = o.nv12;
        pixelFormat = o.pixelFormat;
        ycocg = o.ycocg;
        releaseFenceValue = o.releaseFenceValue;
        o.width = o.height = 0;
        o.codedWidth = o.codedHeight = 0;
        o.timestamp = -1.0;
        o.nv12 = false;
        o.pixelFormat = PixelFormat::BGRA8;
        o.ycocg = false;
        o.releaseFenceValue = 0;
    }
};

class VideoDecoder {
public:
    ~VideoDecoder();

    // Open with what App supplies: a Metal device for zero-copy frames and
    // the frame event that retires them. Without a device the decoder
    // produces CPU frames, which is what the headless modes need.
    bool open(const std::string& filePath, const DecoderParams& params);
    bool open(const std::string& filePath);
    void close();
    bool isOpen() const { return m_open; }

    // `currentFrameFence` is the render timeline value App will signal at the
    // end of the frame being built. The frame this call displaces is stamped
    // with it so the decode thread can wait for the GPU to finish reading
    // before overwriting.
    const VideoFrame* getFrameAtTime(double timeSeconds, uint64_t currentFrameFence = 0);

    // Windows orders D3D11 decode copies against the render queue with this;
    // nothing here needs it, so there is never anything to wait for.
    uint64_t takePendingCopyFence() { return 0; }

    void setVerbose(bool v) { m_verbose = v; }

    uint32_t width() const { return m_width; }
    uint32_t height() const { return m_height; }
    double duration() const { return m_duration; }
    double fps() const { return m_fps; }
    bool isHardwareAccelerated() const { return m_hardware; }
    /** HAP: no decoder at all, the frames are the texture. */
    bool isTextureCodec() const { return m_mode == Mode::Hap; }
    const char* codecName() const { return m_codecName.c_str(); }
    /** Short label for the overlay: how the picture is being produced. */
    const char* accelLabel() const {
        return m_mode == Mode::Hap ? "TEXTURE" : (m_mode == Mode::NV12 ? "VT+NV12" : "SW");
    }
    const ColorSpaceParams& colorSpace() const { return m_colorSpace; }

    // Smoothed cost of one readOneFrame() call, measured in the decode thread.
    double decodeMs() const { return m_decodeMs.load(); }

    // Stats
    int displayedFrames() const { return m_displayedFrames.load(); }
    int playbackDrops() const { return m_playbackDrops.load(); }
    int decodedFrames() const { return m_decodedFrames.load(); }
    int seekCount() const { return m_seekCount.load(); }
    int readableCount() const;

    enum class Mode { Hap, NV12, Software };

private:
    friend struct RendererTestAccess;

    bool loadAsset(const std::string& filePath);
    bool tryOpen(Mode mode);
    // (Re)create the asset reader positioned at `startSeconds`. AVAssetReader
    // cannot seek, so every seek is a new reader.
    bool createReader(double startSeconds);
    void destroyReader();
    bool readOneFrame(VideoFrame& dest);
    bool readHapFrame(VideoFrame& dest);
    bool readDecodedFrame(VideoFrame& dest);
    void readColorSpace(const void* formatDescription);   // CMFormatDescriptionRef
    void applyFrameColorSpace(CVPixelBufferRef pb);
    void decodeThread();
    // Take a frame from the writeable pool, waiting for one if necessary.
    bool borrowFrame(VideoFrame& out);
    void recycle(VideoFrame&& f);
    uint64_t completedFrameValue() const;

    // AVFoundation objects, owned through ObjcRef so this header stays C++.
    ObjcRef m_asset;    // AVURLAsset*
    ObjcRef m_track;    // AVAssetTrack*
    ObjcRef m_reader;   // AVAssetReader*
    ObjcRef m_output;   // AVAssetReaderTrackOutput*
    ObjcRef m_outputSettings;   // NSDictionary*, nil for passthrough
    ObjcRef m_device;   // id<MTLDevice>, may be empty
    void* m_textureCache = nullptr;   // CVMetalTextureCacheRef
    bool m_open = false;

    uint32_t m_width = 0;
    uint32_t m_height = 0;
    double m_duration = 0;
    double m_fps = 30.0;
    double m_frameDuration = 1.0 / 30.0;
    std::string m_codecName = "unknown";
    uint32_t m_subtype = 0;      // container codec fourcc
    bool m_fullRange = false;
    bool m_hardware = false;
    bool m_frameColorSpaceRead = false;
    Mode m_mode = Mode::Software;

    HapFormat m_hapFormat = HapFormat::Unknown;
    ColorSpaceParams m_colorSpace;

    DecoderSync m_sync;

    // Frame dealer
    static constexpr int POOL_SIZE = 4;
    int m_poolSize = POOL_SIZE;
    std::deque<VideoFrame> m_writeable;
    std::deque<VideoFrame> m_readable;
    mutable std::mutex m_dealerMu;
    // Signalled whenever a frame is returned to m_writeable, so the decode
    // thread can wait for one instead of polling.
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
