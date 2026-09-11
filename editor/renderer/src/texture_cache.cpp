#include "texture_cache.h"
#include "uri_util.h"
#include <cstdio>
#include <algorithm>
#include <vector>

#pragma comment(lib, "windowscodecs.lib")

namespace {

D3D12_RESOURCE_DESC texture2DDesc(uint32_t width, uint32_t height, DXGI_FORMAT format) {
    D3D12_RESOURCE_DESC d = {};
    d.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    d.Width = width;
    d.Height = height;
    d.DepthOrArraySize = 1;
    d.MipLevels = 1;
    d.Format = format;
    d.SampleDesc.Count = 1;
    d.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;
    d.Flags = D3D12_RESOURCE_FLAG_NONE;
    return d;
}

D3D12_RESOURCE_BARRIER transition(ID3D12Resource* res, D3D12_RESOURCE_STATES from,
                                  D3D12_RESOURCE_STATES to) {
    D3D12_RESOURCE_BARRIER b = {};
    b.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    b.Transition.pResource = res;
    b.Transition.StateBefore = from;
    b.Transition.StateAfter = to;
    b.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    return b;
}

ComPtr<ID3D12Resource> createUploadBuffer(ID3D12Device* device, UINT64 size) {
    D3D12_RESOURCE_DESC d = {};
    d.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    d.Width = size;
    d.Height = 1;
    d.DepthOrArraySize = 1;
    d.MipLevels = 1;
    d.Format = DXGI_FORMAT_UNKNOWN;
    d.SampleDesc.Count = 1;
    d.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;

    D3D12_HEAP_PROPERTIES heap = {};
    heap.Type = D3D12_HEAP_TYPE_UPLOAD;

    ComPtr<ID3D12Resource> buf;
    device->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_NONE, &d,
        D3D12_RESOURCE_STATE_GENERIC_READ, nullptr, IID_PPV_ARGS(&buf));
    return buf;
}

} // namespace

bool TextureCache::init(ID3D12Device* device, ID3D12CommandQueue* cmdQueue) {
    m_device = device;
    m_cmdQueue = cmdQueue;

    // Create WIC factory
    HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(&m_wicFactory));
    if (FAILED(hr)) {
        fprintf(stderr, "[TextureCache] Failed to create WIC factory: 0x%08x\n", hr);
        return false;
    }

    // Create SRV descriptor heap (shader-visible)
    D3D12_DESCRIPTOR_HEAP_DESC heapDesc = {};
    heapDesc.NumDescriptors = MAX_TEXTURES;
    heapDesc.Type = D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV;
    heapDesc.Flags = D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE;
    hr = device->CreateDescriptorHeap(&heapDesc, IID_PPV_ARGS(&m_srvHeap));
    if (FAILED(hr)) {
        fprintf(stderr, "[TextureCache] Failed to create SRV heap: 0x%08x\n", hr);
        return false;
    }
    m_srvDescriptorSize = device->GetDescriptorHandleIncrementSize(D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV);

    // One-shot upload path (blocking loads only)
    device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&m_uploadAlloc));
    device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, m_uploadAlloc.Get(), nullptr, IID_PPV_ARGS(&m_uploadCmdList));
    m_uploadCmdList->Close();

    device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&m_uploadFence));
    m_uploadEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);

    printf("[TextureCache] Initialized (max %u textures, %d frames in flight)\n",
        MAX_TEXTURES, FRAMES_IN_FLIGHT);
    return true;
}

void TextureCache::shutdown() {
    if (m_uploadEvent) {
        CloseHandle(m_uploadEvent);
        m_uploadEvent = nullptr;
    }
    m_cache.clear();
    m_freeSlots.clear();
    m_frameCmdList = nullptr;
}

void TextureCache::beginFrame(int frameIndex, uint64_t frameCounter,
                              ID3D12GraphicsCommandList* cmdList,
                              FrameGarbage* garbage) {
    m_frameIndex = frameIndex % FRAMES_IN_FLIGHT;
    m_frameCounter = frameCounter;
    m_frameCmdList = cmdList;
    m_frameGarbage = garbage;
}

void TextureCache::retireSlot(uint32_t slot) {
    if (m_frameGarbage) m_frameGarbage->srvSlots.push_back(slot);
    else m_freeSlots.push_back(slot);
}

void TextureCache::retireResource(const ComPtr<ID3D12Resource>& res) {
    if (res && m_frameGarbage) m_frameGarbage->resources.push_back(res);
}

// --- Descriptor allocation ---------------------------------------------

bool TextureCache::allocSlots(int count, uint32_t* out) {
    // Reuse evicted slots before growing the heap.
    for (int i = 0; i < count; i++) {
        if (!m_freeSlots.empty()) {
            out[i] = m_freeSlots.back();
            m_freeSlots.pop_back();
        } else if (m_nextSrvIndex < MAX_TEXTURES) {
            out[i] = m_nextSrvIndex++;
        } else {
            // Give back what we already took
            for (int j = 0; j < i; j++) m_freeSlots.push_back(out[j]);
            fprintf(stderr, "[TextureCache] Descriptor heap full (%u)\n", MAX_TEXTURES);
            return false;
        }
    }
    return true;
}

void TextureCache::releaseSlots(const std::vector<uint32_t>& slots) {
    for (uint32_t s : slots) m_freeSlots.push_back(s);
}

D3D12_CPU_DESCRIPTOR_HANDLE TextureCache::cpuHandle(uint32_t slot) const {
    D3D12_CPU_DESCRIPTOR_HANDLE h = m_srvHeap->GetCPUDescriptorHandleForHeapStart();
    h.ptr += (SIZE_T)slot * m_srvDescriptorSize;
    return h;
}

D3D12_GPU_DESCRIPTOR_HANDLE TextureCache::gpuHandle(uint32_t slot) const {
    D3D12_GPU_DESCRIPTOR_HANDLE h = m_srvHeap->GetGPUDescriptorHandleForHeapStart();
    h.ptr += (UINT64)slot * m_srvDescriptorSize;
    return h;
}

// --- Image loading ------------------------------------------------------

const CachedTexture* TextureCache::get(const std::string& key, const std::string& uri) {
    auto it = m_cache.find(key);
    if (it != m_cache.end()) {
        it->second.lastReferencedFrame = m_frameCounter;
        return it->second.ready ? &it->second : nullptr;
    }

    CachedTexture* tex = loadInto(key, uri);
    if (tex) {
        tex->lastReferencedFrame = m_frameCounter;
        return tex;
    }
    // Insert a failed placeholder so we don't retry every frame
    m_cache[key].lastReferencedFrame = m_frameCounter;
    return nullptr;
}

const CachedTexture* TextureCache::peek(const std::string& key) {
    auto it = m_cache.find(key);
    if (it == m_cache.end()) return nullptr;
    it->second.lastReferencedFrame = m_frameCounter;
    return it->second.ready ? &it->second : nullptr;
}

bool TextureCache::decodeImage(const std::string& uri, std::vector<uint8_t>& pixels,
                               uint32_t& width, uint32_t& height) {
    ComPtr<IWICBitmapDecoder> decoder;
    HRESULT hr = E_FAIL;
    std::vector<uint8_t> bytes;

    if (isDataUri(uri)) {
        bytes = decodeDataUri(uri);
        if (bytes.empty()) return false;
        ComPtr<IWICStream> stream;
        m_wicFactory->CreateStream(&stream);
        stream->InitializeFromMemory(bytes.data(), (DWORD)bytes.size());
        hr = m_wicFactory->CreateDecoderFromStream(stream.Get(), nullptr,
            WICDecodeMetadataCacheOnDemand, &decoder);
        if (FAILED(hr)) {
            fprintf(stderr, "[TextureCache] Failed to decode data URI: 0x%08x\n", hr);
            return false;
        }
    } else {
        std::string path = uriToPath(uri);
        if (path.empty()) return false;
        int wlen = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
        std::vector<wchar_t> wpath(wlen);
        MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, wpath.data(), wlen);
        hr = m_wicFactory->CreateDecoderFromFilename(wpath.data(), nullptr,
            GENERIC_READ, WICDecodeMetadataCacheOnDemand, &decoder);
        if (FAILED(hr)) {
            fprintf(stderr, "[TextureCache] Failed to decode %s: 0x%08x\n", path.c_str(), hr);
            return false;
        }
    }

    ComPtr<IWICBitmapFrameDecode> frame;
    if (FAILED(decoder->GetFrame(0, &frame))) return false;

    ComPtr<IWICFormatConverter> converter;
    if (FAILED(m_wicFactory->CreateFormatConverter(&converter))) return false;
    if (FAILED(converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppRGBA,
        WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeCustom))) return false;

    UINT w = 0, h = 0;
    converter->GetSize(&w, &h);
    if (w == 0 || h == 0) return false;

    UINT rowPitch = w * 4;
    pixels.resize((size_t)rowPitch * h);
    if (FAILED(converter->CopyPixels(nullptr, rowPitch, (UINT)pixels.size(), pixels.data())))
        return false;

    width = w;
    height = h;
    return true;
}

CachedTexture* TextureCache::loadInto(const std::string& key, const std::string& uri) {
    std::vector<uint8_t> pixels;
    uint32_t width = 0, height = 0;
    if (!decodeImage(uri, pixels, width, height)) return nullptr;

    // Build the entry in place. The old code loaded into a temporary and then
    // copied it into the map, which left every image occupying two entries
    // (and two descriptor slots).
    CachedTexture& cached = m_cache[key];
    if (!blockingUpload(cached, pixels.data(), width, height, DXGI_FORMAT_R8G8B8A8_UNORM)) {
        m_cache.erase(key);
        return nullptr;
    }
    printf("[TextureCache] Loaded %.60s (%ux%u) -> SRV[%u]\n",
        uri.c_str(), width, height, cached.srvSlots[0][0]);
    return &cached;
}

// One-shot upload that waits for the GPU before returning. Used for image
// loads, which happen outside the render loop.
bool TextureCache::blockingUpload(CachedTexture& cached, const uint8_t* pixels,
                                  uint32_t width, uint32_t height, DXGI_FORMAT format) {
    std::lock_guard<std::mutex> lk(m_uploadMu);

    uint32_t slot = 0;
    if (!allocSlots(1, &slot)) return false;

    D3D12_RESOURCE_DESC texDesc = texture2DDesc(width, height, format);
    D3D12_HEAP_PROPERTIES defaultHeap = {};
    defaultHeap.Type = D3D12_HEAP_TYPE_DEFAULT;

    ComPtr<ID3D12Resource> texture;
    HRESULT hr = m_device->CreateCommittedResource(&defaultHeap, D3D12_HEAP_FLAG_NONE,
        &texDesc, D3D12_RESOURCE_STATE_COPY_DEST, nullptr, IID_PPV_ARGS(&texture));
    if (FAILED(hr)) {
        m_freeSlots.push_back(slot);
        fprintf(stderr, "[TextureCache] Failed to create texture: 0x%08x\n", hr);
        return false;
    }

    UINT64 uploadSize = 0;
    D3D12_PLACED_SUBRESOURCE_FOOTPRINT footprint;
    m_device->GetCopyableFootprints(&texDesc, 0, 1, 0, &footprint, nullptr, nullptr, &uploadSize);

    ComPtr<ID3D12Resource> uploadBuffer = createUploadBuffer(m_device, uploadSize);
    if (!uploadBuffer) {
        m_freeSlots.push_back(slot);
        return false;
    }

    UINT rowPitch = width * 4;
    void* mapped = nullptr;
    uploadBuffer->Map(0, nullptr, &mapped);
    for (UINT y = 0; y < height; y++) {
        memcpy((uint8_t*)mapped + y * footprint.Footprint.RowPitch, pixels + y * rowPitch, rowPitch);
    }
    uploadBuffer->Unmap(0, nullptr);

    m_uploadAlloc->Reset();
    m_uploadCmdList->Reset(m_uploadAlloc.Get(), nullptr);

    D3D12_TEXTURE_COPY_LOCATION dstLoc = {};
    dstLoc.pResource = texture.Get();
    dstLoc.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
    dstLoc.SubresourceIndex = 0;

    D3D12_TEXTURE_COPY_LOCATION srcLoc = {};
    srcLoc.pResource = uploadBuffer.Get();
    srcLoc.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
    srcLoc.PlacedFootprint = footprint;

    m_uploadCmdList->CopyTextureRegion(&dstLoc, 0, 0, 0, &srcLoc, nullptr);
    auto barrier = transition(texture.Get(), D3D12_RESOURCE_STATE_COPY_DEST,
                              D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE);
    m_uploadCmdList->ResourceBarrier(1, &barrier);
    m_uploadCmdList->Close();

    ID3D12CommandList* lists[] = { m_uploadCmdList.Get() };
    m_cmdQueue->ExecuteCommandLists(1, lists);

    m_uploadFenceValue++;
    m_cmdQueue->Signal(m_uploadFence.Get(), m_uploadFenceValue);
    if (m_uploadFence->GetCompletedValue() < m_uploadFenceValue) {
        m_uploadFence->SetEventOnCompletion(m_uploadFenceValue, m_uploadEvent);
        WaitForSingleObject(m_uploadEvent, INFINITE);
    }
    // The upload buffer is a local; the wait above guarantees the copy is done.

    D3D12_SHADER_RESOURCE_VIEW_DESC srvDesc = {};
    srvDesc.Format = format;
    srvDesc.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
    srvDesc.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
    srvDesc.Texture2D.MipLevels = 1;
    m_device->CreateShaderResourceView(texture.Get(), &srvDesc, cpuHandle(slot));

    cached.resource = texture;
    cached.ringCount = 1;
    cached.planes = 1;
    cached.srvSlots[0][0] = slot;
    cached.slotResource[0] = texture.Get();
    cached.srvGpu = gpuHandle(slot);
    cached.srvCpu = cpuHandle(slot);
    cached.width = width;
    cached.height = height;
    cached.format = format;
    cached.ready = true;
    cached.isNV12 = false;
    return true;
}

// --- Per-frame pixel upload ---------------------------------------------

const CachedTexture* TextureCache::uploadPixels(const std::string& key, const uint8_t* pixels,
                                                 uint32_t width, uint32_t height,
                                                 DXGI_FORMAT format,
                                                 uint32_t dirtyTop, uint32_t dirtyBottom) {
    if (!pixels || width == 0 || height == 0) return nullptr;
    if (!m_frameCmdList) {
        fprintf(stderr, "[TextureCache] uploadPixels outside a frame\n");
        return nullptr;
    }

    auto it = m_cache.find(key);
    bool reuse = (it != m_cache.end() && it->second.ready && !it->second.isNV12 &&
                  it->second.width == width && it->second.height == height &&
                  it->second.format == format);

    // Several screens ask for the same video texture in one frame. Copying it
    // more than once would also mean overwriting the upload buffer a queued
    // copy is still reading from, so do it at most once per frame.
    if (reuse && it->second.lastUploadFrame == m_frameCounter) {
        it->second.lastReferencedFrame = m_frameCounter;
        return &it->second;
    }

    CachedTexture& cached = m_cache[key];
    cached.lastReferencedFrame = m_frameCounter;

    D3D12_RESOURCE_DESC texDesc = texture2DDesc(width, height, format);
    UINT64 uploadSize = 0;
    D3D12_PLACED_SUBRESOURCE_FOOTPRINT footprint;
    m_device->GetCopyableFootprints(&texDesc, 0, 1, 0, &footprint, nullptr, nullptr, &uploadSize);

    if (!reuse) {
        // A key changing dimensions (swapping a clip's media for a different
        // resolution) must drop the old texture, the old descriptor slot AND
        // the old upload buffers — keeping undersized buffers made the row
        // memcpy below write past the end of the mapping.
        uint32_t slot = 0;
        if (cached.ready) {
            // Reuse the entry's first slot rather than leaking it, and retire
            // the rest through the frame's garbage: an in-flight command list
            // may still reference them.
            slot = cached.srvSlots[0][0];
            for (int r = 1; r < cached.ringCount; r++)
                for (int p = 0; p < cached.planes; p++)
                    retireSlot(cached.srvSlots[r][p]);
            if (cached.planes > 1) retireSlot(cached.srvSlots[0][1]);
            retireResource(cached.resource);
        } else if (!allocSlots(1, &slot)) {
            return nullptr;
        }

        D3D12_HEAP_PROPERTIES defaultHeap = {};
        defaultHeap.Type = D3D12_HEAP_TYPE_DEFAULT;
        ComPtr<ID3D12Resource> texture;
        HRESULT hr = m_device->CreateCommittedResource(&defaultHeap, D3D12_HEAP_FLAG_NONE,
            &texDesc, D3D12_RESOURCE_STATE_COPY_DEST, nullptr, IID_PPV_ARGS(&texture));
        if (FAILED(hr)) return nullptr;

        D3D12_SHADER_RESOURCE_VIEW_DESC srvDesc = {};
        srvDesc.Format = format;
        srvDesc.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
        srvDesc.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
        srvDesc.Texture2D.MipLevels = 1;
        m_device->CreateShaderResourceView(texture.Get(), &srvDesc, cpuHandle(slot));

        for (int i = 0; i < FRAMES_IN_FLIGHT; i++) {
            retireResource(cached.uploadBuffers[i]);
            cached.uploadBuffers[i].Reset();
        }
        cached.uploadBufferSize = 0;
        cached.resource = texture;
        cached.ringCount = 1;
        cached.planes = 1;
        cached.srvSlots[0][0] = slot;
        cached.slotResource[0] = texture.Get();
        cached.srvGpu = gpuHandle(slot);
        cached.srvCpu = cpuHandle(slot);
        cached.width = width;
        cached.height = height;
        cached.format = format;
        cached.isNV12 = false;
        cached.ready = true;
    }

    if (cached.uploadBufferSize != uploadSize) {
        for (int i = 0; i < FRAMES_IN_FLIGHT; i++) {
            retireResource(cached.uploadBuffers[i]);
            cached.uploadBuffers[i].Reset();
        }
        cached.uploadBufferSize = uploadSize;
    }
    ComPtr<ID3D12Resource>& uploadBuffer = cached.uploadBuffers[m_frameIndex];
    if (!uploadBuffer) {
        uploadBuffer = createUploadBuffer(m_device, uploadSize);
        if (!uploadBuffer) return nullptr;
        dirtyTop = 0;              // a fresh buffer holds nothing
        dirtyBottom = UINT32_MAX;
    }

    // A new texture must be filled completely regardless of the dirty hint.
    if (!reuse) { dirtyTop = 0; dirtyBottom = UINT32_MAX; }
    uint32_t top = (std::min)(dirtyTop, height);
    uint32_t bottom = (std::min)(dirtyBottom, height);
    if (bottom <= top) {
        // Nothing changed; the texture already holds the right content.
        cached.lastUploadFrame = m_frameCounter;
        return &cached;
    }

    const UINT rowPitch = width * 4;
    void* mapped = nullptr;
    // Map/Unmap with an empty read range: we only write.
    D3D12_RANGE noRead = { 0, 0 };
    if (FAILED(uploadBuffer->Map(0, &noRead, &mapped))) return nullptr;
    for (uint32_t y = top; y < bottom; y++) {
        memcpy((uint8_t*)mapped + (size_t)y * footprint.Footprint.RowPitch,
               pixels + (size_t)y * rowPitch, rowPitch);
    }
    // The last row occupies only width*4 bytes, so bottom*RowPitch can run
    // past the end of the buffer; clamp it (the range is only a hint).
    D3D12_RANGE written = { (SIZE_T)top * footprint.Footprint.RowPitch,
                            (SIZE_T)(std::min)((UINT64)bottom * footprint.Footprint.RowPitch, uploadSize) };
    uploadBuffer->Unmap(0, &written);

    // Record into the frame's command list — no private allocator, no fence,
    // no submit. The frame's own fence already guarantees this slot is free.
    if (reuse) {
        auto pre = transition(cached.resource.Get(),
                              D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE,
                              D3D12_RESOURCE_STATE_COPY_DEST);
        m_frameCmdList->ResourceBarrier(1, &pre);
    }

    D3D12_TEXTURE_COPY_LOCATION dstLoc = {};
    dstLoc.pResource = cached.resource.Get();
    dstLoc.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
    dstLoc.SubresourceIndex = 0;

    D3D12_TEXTURE_COPY_LOCATION srcLoc = {};
    srcLoc.pResource = uploadBuffer.Get();
    srcLoc.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
    srcLoc.PlacedFootprint = footprint;

    D3D12_BOX box = {};
    box.left = 0;
    box.top = top;
    box.front = 0;
    box.right = width;
    box.bottom = bottom;
    box.back = 1;
    m_frameCmdList->CopyTextureRegion(&dstLoc, 0, top, 0, &srcLoc, &box);

    auto post = transition(cached.resource.Get(), D3D12_RESOURCE_STATE_COPY_DEST,
                           D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE);
    m_frameCmdList->ResourceBarrier(1, &post);

    cached.lastUploadFrame = m_frameCounter;
    return &cached;
}

// --- External (video) textures ------------------------------------------

const CachedTexture* TextureCache::registerExternal(const std::string& key,
                                                      ID3D12Resource* resource,
                                                      uint32_t width, uint32_t height,
                                                      DXGI_FORMAT format) {
    if (!resource || width == 0 || height == 0) return nullptr;

    auto it = m_cache.find(key);
    bool reuse = (it != m_cache.end() && it->second.ready && !it->second.isNV12 &&
                  it->second.width == width && it->second.height == height &&
                  it->second.format == format && it->second.ringCount == FRAMES_IN_FLIGHT);

    if (!reuse) {
        if (it != m_cache.end()) {
            // Reclaim whatever the stale entry held before rebuilding it.
            CachedTexture& old = it->second;
            if (old.ready) {
                for (int r = 0; r < old.ringCount; r++)
                    for (int p = 0; p < old.planes; p++)
                        retireSlot(old.srvSlots[r][p]);
            }
            m_cache.erase(it);
        }
        CachedTexture& fresh = m_cache[key];
        uint32_t slots[FRAMES_IN_FLIGHT] = {};
        if (!allocSlots(FRAMES_IN_FLIGHT, slots)) {
            m_cache.erase(key);
            return nullptr;
        }
        fresh.ringCount = FRAMES_IN_FLIGHT;
        fresh.planes = 1;
        for (int i = 0; i < FRAMES_IN_FLIGHT; i++) {
            fresh.srvSlots[i][0] = slots[i];
            fresh.slotResource[i] = nullptr;
        }
        fresh.width = width;
        fresh.height = height;
        fresh.format = format;
        fresh.isNV12 = false;
        fresh.ready = true;
    }

    CachedTexture& cached = m_cache[key];
    cached.resource = resource;
    cached.lastReferencedFrame = m_frameCounter;

    // Write into this frame's slot only, and only when it does not already
    // describe this resource. The old code rewrote a single descriptor every
    // frame while the previous frame's command list could still be reading it.
    uint32_t slot = cached.srvSlots[m_frameIndex][0];
    if (cached.slotResource[m_frameIndex] != resource) {
        D3D12_SHADER_RESOURCE_VIEW_DESC srvDesc = {};
        srvDesc.Format = format;
        srvDesc.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
        srvDesc.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
        srvDesc.Texture2D.MipLevels = 1;
        m_device->CreateShaderResourceView(resource, &srvDesc, cpuHandle(slot));
        cached.slotResource[m_frameIndex] = resource;
    }
    cached.srvGpu = gpuHandle(slot);
    cached.srvCpu = cpuHandle(slot);
    return &cached;
}

const CachedTexture* TextureCache::registerNV12(const std::string& key,
                                                  ID3D12Resource* resource,
                                                  uint32_t width, uint32_t height) {
    if (!resource || width == 0 || height == 0) return nullptr;

    auto it = m_cache.find(key);
    bool reuse = (it != m_cache.end() && it->second.ready && it->second.isNV12 &&
                  it->second.width == width && it->second.height == height &&
                  it->second.ringCount == FRAMES_IN_FLIGHT);

    if (!reuse) {
        if (it != m_cache.end()) {
            CachedTexture& old = it->second;
            if (old.ready) {
                for (int r = 0; r < old.ringCount; r++)
                    for (int p = 0; p < old.planes; p++)
                        retireSlot(old.srvSlots[r][p]);
            }
            m_cache.erase(it);
        }
        CachedTexture& fresh = m_cache[key];
        uint32_t slots[FRAMES_IN_FLIGHT * 2] = {};
        if (!allocSlots(FRAMES_IN_FLIGHT * 2, slots)) {
            m_cache.erase(key);
            return nullptr;
        }
        fresh.ringCount = FRAMES_IN_FLIGHT;
        fresh.planes = 2;
        for (int i = 0; i < FRAMES_IN_FLIGHT; i++) {
            fresh.srvSlots[i][0] = slots[i * 2];
            fresh.srvSlots[i][1] = slots[i * 2 + 1];
            fresh.slotResource[i] = nullptr;
        }
        fresh.width = width;
        fresh.height = height;
        fresh.format = DXGI_FORMAT_NV12;
        fresh.isNV12 = true;
        fresh.ready = true;
    }

    CachedTexture& cached = m_cache[key];
    cached.resource = resource;
    cached.lastReferencedFrame = m_frameCounter;

    uint32_t ySlot = cached.srvSlots[m_frameIndex][0];
    uint32_t uvSlot = cached.srvSlots[m_frameIndex][1];
    if (cached.slotResource[m_frameIndex] != resource) {
        // Y plane: R8_UNORM, PlaneSlice=0
        D3D12_SHADER_RESOURCE_VIEW_DESC ySrv = {};
        ySrv.Format = DXGI_FORMAT_R8_UNORM;
        ySrv.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
        ySrv.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
        ySrv.Texture2D.MipLevels = 1;
        ySrv.Texture2D.PlaneSlice = 0;
        m_device->CreateShaderResourceView(resource, &ySrv, cpuHandle(ySlot));

        // UV plane: R8G8_UNORM, PlaneSlice=1
        D3D12_SHADER_RESOURCE_VIEW_DESC uvSrv = {};
        uvSrv.Format = DXGI_FORMAT_R8G8_UNORM;
        uvSrv.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
        uvSrv.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
        uvSrv.Texture2D.MipLevels = 1;
        uvSrv.Texture2D.PlaneSlice = 1;
        m_device->CreateShaderResourceView(resource, &uvSrv, cpuHandle(uvSlot));

        cached.slotResource[m_frameIndex] = resource;
    }
    cached.srvGpu = gpuHandle(ySlot);
    cached.srvCpu = cpuHandle(ySlot);
    cached.srvGpuUV = gpuHandle(uvSlot);
    cached.srvCpuUV = cpuHandle(uvSlot);
    return &cached;
}

// --- Eviction ------------------------------------------------------------

void TextureCache::invalidate(const std::string& key, FrameGarbage& garbage) {
    auto it = m_cache.find(key);
    if (it == m_cache.end()) return;
    const auto& t = it->second;
    if (t.ready) {
        for (int r = 0; r < t.ringCount; ++r)
            for (int p = 0; p < t.planes; ++p)
                garbage.srvSlots.push_back(t.srvSlots[r][p]);
    }
    if (t.resource) garbage.resources.push_back(t.resource);
    for (const auto& upload : t.uploadBuffers)
        if (upload) garbage.resources.push_back(upload);
    m_cache.erase(it);
}

void TextureCache::evictUnused(uint64_t frameCounter, uint64_t graceFrames,
                               FrameGarbage& garbage,
                               std::vector<std::string>* evictedKeys) {
    for (auto it = m_cache.begin(); it != m_cache.end(); ) {
        CachedTexture& t = it->second;
        if (t.lastReferencedFrame + graceFrames >= frameCounter) { ++it; continue; }

        if (t.ready) {
            for (int r = 0; r < t.ringCount; r++)
                for (int p = 0; p < t.planes; p++)
                    garbage.srvSlots.push_back(t.srvSlots[r][p]);
        }
        // The GPU may still be reading these; hand them to the frame's
        // garbage list rather than releasing here.
        if (t.resource) garbage.resources.push_back(t.resource);
        for (int i = 0; i < FRAMES_IN_FLIGHT; i++) {
            if (t.uploadBuffers[i]) garbage.resources.push_back(t.uploadBuffers[i]);
        }
        if (evictedKeys) evictedKeys->push_back(it->first);
        it = m_cache.erase(it);
    }
}

// --- Data URIs -----------------------------------------------------------

bool TextureCache::isDataUri(const std::string& uri) {
    return uri.size() > 5 && uri.compare(0, 5, "data:") == 0;
}

// Base64 decode table
static const int b64table[256] = {
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,62,-1,-1,-1,63,
    52,53,54,55,56,57,58,59,60,61,-1,-1,-1,-1,-1,-1,
    -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9,10,11,12,13,14,
    15,16,17,18,19,20,21,22,23,24,25,-1,-1,-1,-1,-1,
    -1,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,
    41,42,43,44,45,46,47,48,49,50,51,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
    -1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,
};

std::vector<uint8_t> TextureCache::decodeDataUri(const std::string& uri) const {
    // Find the base64 data after "data:...;base64,"
    size_t comma = uri.find(',');
    if (comma == std::string::npos) return {};

    const char* src = uri.c_str() + comma + 1;
    size_t srcLen = uri.size() - comma - 1;

    std::vector<uint8_t> out;
    out.reserve(srcLen * 3 / 4);

    uint32_t buf = 0;
    int bits = 0;
    for (size_t i = 0; i < srcLen; i++) {
        unsigned char c = (unsigned char)src[i];
        if (c == '=' || c == '\n' || c == '\r' || c == ' ') continue;
        int val = b64table[c];
        if (val < 0) continue;
        buf = (buf << 6) | val;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back((uint8_t)(buf >> bits));
        }
    }

    return out;
}
