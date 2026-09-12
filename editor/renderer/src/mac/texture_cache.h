#pragma once
// Textures on Metal.
//
// The D3D12 cache rings descriptor slots and retires resources through the
// frame's garbage list because a descriptor or resource may still be read by
// an in-flight command list. Metal binds textures per draw and a committed
// command buffer retains everything it references, so neither mechanism is
// needed here: an entry owns its MTLTexture and drops it when evicted. The
// upload buffers are still ringed FRAMES_IN_FLIGHT deep, because a shared
// buffer must not be rewritten while a blit that reads it is in flight.

#include "objc_ref.h"
#include "pixel_format.h"

#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

// Frames the CPU may be ahead of the GPU.
static const int FRAMES_IN_FLIGHT = 3;

// Retirement list for resources still referenced by an in-flight frame. On
// Metal the command buffer keeps them alive, so this only exists to give the
// shared code the same shape as on Windows.
struct FrameGarbage {
    bool empty() const { return true; }
    void clear() {}
};

struct CachedTexture {
    ObjcRef texture;     // id<MTLTexture>: the picture, or the Y plane
    ObjcRef textureUV;   // id<MTLTexture>: the UV plane of an NV12 frame

    // One upload buffer per in-flight frame. The frame's event value has
    // already passed by the time its slot is reused, so writing here is safe
    // without any per-texture fence or timed wait.
    ObjcRef uploadBuffers[FRAMES_IN_FLIGHT];
    size_t uploadBufferSize = 0;   // all slots are reallocated when this changes

    uint32_t width = 0;
    uint32_t height = 0;
    PixelFormat format = PixelFormat::Unknown;
    bool ready = false;
    bool isNV12 = false;

    // Frame bookkeeping for de-duplication and eviction
    uint64_t lastUploadFrame = 0;
    uint64_t lastReferencedFrame = 0;
};

class TextureCache {
public:
    bool init(const ObjcRef& device, const ObjcRef& queue);
    void shutdown();

    // Start recording into the frame's command buffer. `frameIndex` selects
    // the upload-buffer slot for this frame; `frameCounter` is a monotonically
    // increasing frame number used for de-duplication and eviction.
    void beginFrame(int frameIndex, uint64_t frameCounter, const ObjcRef& commandBuffer,
                    FrameGarbage* garbage);

    // End the blit encoder the uploads were recorded into. Must be called
    // before a render encoder is opened on the same command buffer: Metal
    // allows one encoder at a time.
    void flushUploads();

    // Get or load a texture. Returns nullptr if not yet loaded or failed.
    const CachedTexture* get(const std::string& key, const std::string& uri);
    const CachedTexture* get(const std::string& uri) { return get(uri, uri); }

    // Non-blocking lookup: returns the entry only if it is already resident.
    const CachedTexture* peek(const std::string& key);

    static bool isDataUri(const std::string& uri);

    // Upload raw pixels as a texture, keyed by a string ID. If the key already
    // exists and dimensions match, updates the existing texture in place.
    // Only the rows in [dirtyTop, dirtyBottom) are copied when the texture is
    // being reused; pass 0/height (the default) to copy everything.
    const CachedTexture* uploadPixels(const std::string& key, const uint8_t* pixels,
                                      uint32_t width, uint32_t height,
                                      PixelFormat format = PixelFormat::RGBA8,
                                      uint32_t dirtyTop = 0, uint32_t dirtyBottom = UINT32_MAX);

    const CachedTexture* uploadRGBA(const std::string& key, const uint8_t* pixels,
                                     uint32_t width, uint32_t height,
                                     uint32_t dirtyTop = 0, uint32_t dirtyBottom = UINT32_MAX) {
        return uploadPixels(key, pixels, width, height, PixelFormat::RGBA8, dirtyTop, dirtyBottom);
    }

    // Register a texture the decoder owns (no upload needed).
    const CachedTexture* registerExternal(const std::string& key, const ObjcRef& texture,
                                           uint32_t width, uint32_t height,
                                           PixelFormat format = PixelFormat::BGRA8);

    // Register the two planes of an NV12 frame.
    const CachedTexture* registerNV12(const std::string& key, const ObjcRef& yTexture,
                                       const ObjcRef& uvTexture, uint32_t width, uint32_t height);

    // Drop cache entries not touched for `graceFrames` frames.
    void evictUnused(uint64_t frameCounter, uint64_t graceFrames, FrameGarbage& garbage,
                     std::vector<std::string>* evictedKeys = nullptr);
    void invalidate(const std::string& key, FrameGarbage& garbage);

    // Resident entries, for the overlay (the D3D12 build reports SRV slots).
    uint32_t usedSlots() const { return (uint32_t)m_cache.size(); }

private:
    CachedTexture* loadInto(const std::string& key, const std::string& uri);
    bool decodeImage(const std::string& uri, std::vector<uint8_t>& pixels,
                     uint32_t& width, uint32_t& height);
    bool blockingUpload(CachedTexture& cached, const uint8_t* pixels,
                        uint32_t width, uint32_t height, PixelFormat format);
    // The frame's blit encoder, opened on first use.
    ObjcRef blitEncoder();
    ObjcRef createTexture(uint32_t width, uint32_t height, PixelFormat format);

    ObjcRef m_device;   // id<MTLDevice>
    ObjcRef m_queue;    // id<MTLCommandQueue>

    // Current frame recording state (set by beginFrame)
    int m_frameIndex = 0;
    uint64_t m_frameCounter = 0;
    ObjcRef m_frameCmdBuf;   // id<MTLCommandBuffer>
    ObjcRef m_blit;          // id<MTLBlitCommandEncoder>, while open

    std::unordered_map<std::string, CachedTexture> m_cache;
};
