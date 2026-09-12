#pragma once

#include <d3d12.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
#include <wincodec.h>
#include "pixel_format.h"
#include "dxgi_format.h"
#include <string>
#include <unordered_map>
#include <mutex>
#include <vector>

using Microsoft::WRL::ComPtr;

// Frames the CPU may be ahead of the GPU. Upload buffers and descriptor slots
// are ringed this many deep so neither is ever rewritten while a command list
// that references it is still executing.
static const int FRAMES_IN_FLIGHT = 3;

struct CachedTexture {
    ComPtr<ID3D12Resource> resource;

    // One upload buffer per in-flight frame. The frame's fence has already
    // passed by the time its slot is reused, so writing here is safe without
    // any per-texture fence or timed wait.
    ComPtr<ID3D12Resource> uploadBuffers[FRAMES_IN_FLIGHT];
    UINT64 uploadBufferSize = 0;   // all slots are reallocated when this changes

    // Descriptor slots. Uploaded textures keep a stable resource and need only
    // one; externally supplied textures (video frames) change resource every
    // frame, so they get a ring and never rewrite a descriptor the previous
    // frame's command list may still be reading.
    static const int MAX_PLANES = 2;   // [1] is the UV plane for NV12
    uint32_t srvSlots[FRAMES_IN_FLIGHT][MAX_PLANES] = {};
    ID3D12Resource* slotResource[FRAMES_IN_FLIGHT] = {};
    int ringCount = 1;
    int planes = 1;

    // Handles for the slot chosen this frame; valid until the next register call.
    D3D12_GPU_DESCRIPTOR_HANDLE srvGpu = {};
    D3D12_CPU_DESCRIPTOR_HANDLE srvCpu = {};
    D3D12_GPU_DESCRIPTOR_HANDLE srvGpuUV = {};
    D3D12_CPU_DESCRIPTOR_HANDLE srvCpuUV = {};

    uint32_t width = 0;
    uint32_t height = 0;
    DXGI_FORMAT format = DXGI_FORMAT_UNKNOWN;
    bool ready = false;
    bool isNV12 = false;

    // Frame bookkeeping for de-duplication and eviction
    uint64_t lastUploadFrame = 0;
    uint64_t lastReferencedFrame = 0;
};

// Retires GPU resources and descriptor slots only once the frame that used
// them has completed. App owns one of these per in-flight frame.
struct FrameGarbage {
    std::vector<ComPtr<ID3D12Object>> resources;
    std::vector<uint32_t> srvSlots;

    bool empty() const { return resources.empty() && srvSlots.empty(); }
    void clear() { resources.clear(); srvSlots.clear(); }
};

// TextureCache loads images from disk via WIC and uploads them to DX12 textures.
// Textures are cached by key.
//
// All per-frame uploads are recorded into the frame's command list (see
// beginFrame). The cache no longer owns a command allocator, fence or queue
// submission for those; it only keeps a private one-shot path for the
// blocking loads that happen outside the render loop.
class TextureCache {
public:
    bool init(ID3D12Device* device, ID3D12CommandQueue* cmdQueue);
    void shutdown();

    // Start recording into the frame's command list. `frameIndex` selects the
    // upload-buffer and descriptor slot for this frame; `frameCounter` is a
    // monotonically increasing frame number used for de-duplication and
    // eviction.
    void beginFrame(int frameIndex, uint64_t frameCounter, ID3D12GraphicsCommandList* cmdList,
                    FrameGarbage* garbage);

    // Get or load a texture. Returns nullptr if not yet loaded or failed.
    // `key` identifies the cache entry, `uri` says where to load it from — the
    // two differ for data: URIs, whose multi-megabyte string must not become a
    // map key that is hashed on every lookup.
    const CachedTexture* get(const std::string& key, const std::string& uri);
    const CachedTexture* get(const std::string& uri) { return get(uri, uri); }

    // Non-blocking lookup: returns the entry only if it is already resident.
    // The render thread uses this so a cold asset costs a skipped frame
    // instead of a synchronous WIC decode plus a blocking GPU upload.
    const CachedTexture* peek(const std::string& key);

    // True for an inline "data:" URI, whose bytes are already in memory and so
    // are decoded on the calling thread rather than queued to the loader.
    static bool isDataUri(const std::string& uri);

    // Upload raw pixels as a texture, keyed by a string ID.
    // If the key already exists and dimensions match, updates the existing texture in-place.
    // format: RGBA8, BGRA8, or a block-compressed format for HAP frames.
    // Returns nullptr on failure.
    //
    // Only the rows in [dirtyTop, dirtyBottom) are copied when the texture is
    // being reused; pass 0/height (the default) to copy everything.
    const CachedTexture* uploadPixels(const std::string& key, const uint8_t* pixels,
                                      uint32_t width, uint32_t height,
                                      PixelFormat format = PixelFormat::RGBA8,
                                      uint32_t dirtyTop = 0, uint32_t dirtyBottom = UINT32_MAX);

    // Convenience: upload RGBA pixels
    const CachedTexture* uploadRGBA(const std::string& key, const uint8_t* pixels,
                                     uint32_t width, uint32_t height,
                                     uint32_t dirtyTop = 0, uint32_t dirtyBottom = UINT32_MAX) {
        return uploadPixels(key, pixels, width, height, PixelFormat::RGBA8, dirtyTop, dirtyBottom);
    }

    // Register an external D3D12 resource as a texture (no upload needed).
    // Used for shared DXGI textures from the video decoder.
    // The resource must already be in a GPU-readable state (COMMON or PIXEL_SHADER_RESOURCE).
    const CachedTexture* registerExternal(const std::string& key, ID3D12Resource* resource,
                                           uint32_t width, uint32_t height,
                                           DXGI_FORMAT format = DXGI_FORMAT_B8G8R8A8_UNORM);

    // Register an NV12 D3D12 resource with 2 SRVs (Y plane + UV plane).
    // Used for zero-copy video decode via D3D11On12.
    const CachedTexture* registerNV12(const std::string& key, ID3D12Resource* resource,
                                       uint32_t width, uint32_t height);

    // Drop cache entries not touched for `graceFrames` frames. Their resources
    // and descriptor slots go into `garbage`, to be released once the current
    // frame's fence passes. Without this the 512-slot SRV heap filled up as
    // soon as enough distinct timeline items had been seen.
    void evictUnused(uint64_t frameCounter, uint64_t graceFrames, FrameGarbage& garbage,
                     std::vector<std::string>* evictedKeys = nullptr);

    // Return descriptor slots retired by evictUnused to the free list.
    void releaseSlots(const std::vector<uint32_t>& slots);
    void invalidate(const std::string& key, FrameGarbage& garbage);

    ID3D12DescriptorHeap* srvHeap() const { return m_srvHeap.Get(); }
    uint32_t usedSlots() const { return m_nextSrvIndex - (uint32_t)m_freeSlots.size(); }

private:
    CachedTexture* loadInto(const std::string& key, const std::string& uri);
    bool decodeImage(const std::string& uri, std::vector<uint8_t>& pixels,
                     uint32_t& width, uint32_t& height);
    bool blockingUpload(CachedTexture& cached, const uint8_t* pixels,
                        uint32_t width, uint32_t height, DXGI_FORMAT format);
    std::vector<uint8_t> decodeDataUri(const std::string& uri) const;

    // Descriptor allocation
    bool allocSlots(int count, uint32_t* out);
    D3D12_CPU_DESCRIPTOR_HANDLE cpuHandle(uint32_t slot) const;
    D3D12_GPU_DESCRIPTOR_HANDLE gpuHandle(uint32_t slot) const;

    ID3D12Device* m_device = nullptr;
    ID3D12CommandQueue* m_cmdQueue = nullptr;
    ComPtr<IWICImagingFactory> m_wicFactory;

    // SRV heap (shader-visible)
    ComPtr<ID3D12DescriptorHeap> m_srvHeap;
    uint32_t m_srvDescriptorSize = 0;
    uint32_t m_nextSrvIndex = 0;
    std::vector<uint32_t> m_freeSlots;   // consulted before m_nextSrvIndex++
    static const uint32_t MAX_TEXTURES = 512;

    // Current frame recording state (set by beginFrame)
    int m_frameIndex = 0;
    uint64_t m_frameCounter = 0;
    ID3D12GraphicsCommandList* m_frameCmdList = nullptr;
    FrameGarbage* m_frameGarbage = nullptr;

    // Retire a slot through the current frame's garbage when one exists, so a
    // descriptor is never handed out again while an in-flight command list may
    // still be reading it.
    void retireSlot(uint32_t slot);
    void retireResource(const ComPtr<ID3D12Resource>& res);

    // One-shot blocking upload path, used only by the loaders that run outside
    // the render loop. It waits on its own fence before returning, so the
    // allocator is always idle by the time it is reset again.
    ComPtr<ID3D12CommandAllocator> m_uploadAlloc;
    ComPtr<ID3D12GraphicsCommandList> m_uploadCmdList;
    ComPtr<ID3D12Fence> m_uploadFence;
    HANDLE m_uploadEvent = nullptr;
    UINT64 m_uploadFenceValue = 0;
    std::mutex m_uploadMu;

    std::unordered_map<std::string, CachedTexture> m_cache;
};
