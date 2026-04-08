#include "texture_cache.h"
#include <cstdio>
#include <algorithm>
#include <vector>

#pragma comment(lib, "windowscodecs.lib")

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

    // Create upload command list
    device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT, IID_PPV_ARGS(&m_uploadAlloc));
    device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, m_uploadAlloc.Get(), nullptr, IID_PPV_ARGS(&m_uploadCmdList));
    m_uploadCmdList->Close();

    device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&m_uploadFence));
    m_uploadEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);

    printf("[TextureCache] Initialized (max %u textures)\n", MAX_TEXTURES);
    return true;
}

void TextureCache::shutdown() {
    if (m_uploadEvent) {
        CloseHandle(m_uploadEvent);
        m_uploadEvent = nullptr;
    }
    m_cache.clear();
}

const CachedTexture* TextureCache::get(const std::string& uri) {
    auto it = m_cache.find(uri);
    if (it != m_cache.end()) {
        return it->second.ready ? &it->second : nullptr;
    }

    CachedTexture* tex = nullptr;

    if (isDataUri(uri)) {
        // Decode base64 data URI and load from memory
        auto bytes = decodeDataUri(uri);
        if (!bytes.empty()) {
            tex = loadFromMemory(bytes.data(), bytes.size());
        }
    } else {
        // Load from file path
        std::string path = uriToPath(uri);
        if (!path.empty()) {
            tex = loadFromFile(path);
        }
    }

    if (tex) {
        m_cache[uri] = *tex;
        return &m_cache[uri];
    }
    // Insert a failed placeholder so we don't retry
    m_cache[uri] = CachedTexture{};
    return nullptr;
}

std::string TextureCache::uriToPath(const std::string& uri) const {
    // Handle file:/// URIs
    if (uri.substr(0, 8) == "file:///") {
        std::string path = uri.substr(8);
        // URL decode
        std::string decoded;
        for (size_t i = 0; i < path.size(); i++) {
            if (path[i] == '%' && i + 2 < path.size()) {
                char hex[3] = { path[i + 1], path[i + 2], 0 };
                decoded += (char)strtol(hex, nullptr, 16);
                i += 2;
            } else if (path[i] == '/') {
                decoded += '\\';
            } else {
                decoded += path[i];
            }
        }
        return decoded;
    }
    // Handle file:// (no third slash, POSIX)
    if (uri.substr(0, 7) == "file://") {
        return uri.substr(7);
    }
    // Assume it's already a path
    if (uri.size() > 2 && uri[1] == ':') {
        return uri; // e.g. C:\path
    }
    return "";
}

CachedTexture* TextureCache::loadFromFile(const std::string& path) {
    if (m_nextSrvIndex >= MAX_TEXTURES) {
        fprintf(stderr, "[TextureCache] Texture limit reached (%u)\n", MAX_TEXTURES);
        return nullptr;
    }

    // Convert path to wide string
    int wlen = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);
    std::vector<wchar_t> wpath(wlen);
    MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, wpath.data(), wlen);

    // Decode with WIC
    ComPtr<IWICBitmapDecoder> decoder;
    HRESULT hr = m_wicFactory->CreateDecoderFromFilename(wpath.data(), nullptr,
        GENERIC_READ, WICDecodeMetadataCacheOnDemand, &decoder);
    if (FAILED(hr)) {
        fprintf(stderr, "[TextureCache] Failed to decode %s: 0x%08x\n", path.c_str(), hr);
        return nullptr;
    }

    ComPtr<IWICBitmapFrameDecode> frame;
    decoder->GetFrame(0, &frame);

    // Convert to RGBA8
    ComPtr<IWICFormatConverter> converter;
    m_wicFactory->CreateFormatConverter(&converter);
    converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppRGBA,
        WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeCustom);

    UINT width, height;
    converter->GetSize(&width, &height);

    // Read pixel data
    UINT rowPitch = width * 4;
    UINT imageSize = rowPitch * height;
    std::vector<uint8_t> pixels(imageSize);
    converter->CopyPixels(nullptr, rowPitch, imageSize, pixels.data());

    // Create DX12 texture resource
    D3D12_RESOURCE_DESC texDesc = {};
    texDesc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    texDesc.Width = width;
    texDesc.Height = height;
    texDesc.DepthOrArraySize = 1;
    texDesc.MipLevels = 1;
    texDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    texDesc.SampleDesc.Count = 1;
    texDesc.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;
    texDesc.Flags = D3D12_RESOURCE_FLAG_NONE;

    D3D12_HEAP_PROPERTIES defaultHeap = {};
    defaultHeap.Type = D3D12_HEAP_TYPE_DEFAULT;

    ComPtr<ID3D12Resource> texture;
    hr = m_device->CreateCommittedResource(&defaultHeap, D3D12_HEAP_FLAG_NONE,
        &texDesc, D3D12_RESOURCE_STATE_COPY_DEST, nullptr, IID_PPV_ARGS(&texture));
    if (FAILED(hr)) {
        fprintf(stderr, "[TextureCache] Failed to create texture: 0x%08x\n", hr);
        return nullptr;
    }

    // Create upload buffer
    UINT64 uploadSize = 0;
    D3D12_PLACED_SUBRESOURCE_FOOTPRINT footprint;
    m_device->GetCopyableFootprints(&texDesc, 0, 1, 0, &footprint, nullptr, nullptr, &uploadSize);

    D3D12_RESOURCE_DESC uploadDesc = {};
    uploadDesc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    uploadDesc.Width = uploadSize;
    uploadDesc.Height = 1;
    uploadDesc.DepthOrArraySize = 1;
    uploadDesc.MipLevels = 1;
    uploadDesc.Format = DXGI_FORMAT_UNKNOWN;
    uploadDesc.SampleDesc.Count = 1;
    uploadDesc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;

    D3D12_HEAP_PROPERTIES uploadHeap = {};
    uploadHeap.Type = D3D12_HEAP_TYPE_UPLOAD;

    ComPtr<ID3D12Resource> uploadBuffer;
    m_device->CreateCommittedResource(&uploadHeap, D3D12_HEAP_FLAG_NONE,
        &uploadDesc, D3D12_RESOURCE_STATE_GENERIC_READ, nullptr, IID_PPV_ARGS(&uploadBuffer));

    // Copy pixels to upload buffer (respecting row pitch alignment)
    void* mapped = nullptr;
    uploadBuffer->Map(0, nullptr, &mapped);
    uint8_t* dst = (uint8_t*)mapped;
    for (UINT y = 0; y < height; y++) {
        memcpy(dst + y * footprint.Footprint.RowPitch, pixels.data() + y * rowPitch, rowPitch);
    }
    uploadBuffer->Unmap(0, nullptr);

    // Record upload commands
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

    // Transition to shader resource
    D3D12_RESOURCE_BARRIER barrier = {};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource = texture.Get();
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_DEST;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    m_uploadCmdList->ResourceBarrier(1, &barrier);

    m_uploadCmdList->Close();
    ID3D12CommandList* lists[] = { m_uploadCmdList.Get() };
    m_cmdQueue->ExecuteCommandLists(1, lists);

    // Wait for upload
    m_uploadFenceValue++;
    m_cmdQueue->Signal(m_uploadFence.Get(), m_uploadFenceValue);
    if (m_uploadFence->GetCompletedValue() < m_uploadFenceValue) {
        m_uploadFence->SetEventOnCompletion(m_uploadFenceValue, m_uploadEvent);
        WaitForSingleObject(m_uploadEvent, INFINITE);
    }

    // Create SRV
    uint32_t srvIndex = m_nextSrvIndex++;
    D3D12_CPU_DESCRIPTOR_HANDLE cpuHandle = m_srvHeap->GetCPUDescriptorHandleForHeapStart();
    cpuHandle.ptr += srvIndex * m_srvDescriptorSize;
    D3D12_GPU_DESCRIPTOR_HANDLE gpuHandle = m_srvHeap->GetGPUDescriptorHandleForHeapStart();
    gpuHandle.ptr += srvIndex * m_srvDescriptorSize;

    D3D12_SHADER_RESOURCE_VIEW_DESC srvDesc = {};
    srvDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    srvDesc.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
    srvDesc.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
    srvDesc.Texture2D.MipLevels = 1;
    m_device->CreateShaderResourceView(texture.Get(), &srvDesc, cpuHandle);

    printf("[TextureCache] Loaded %s (%ux%u) -> SRV[%u]\n", path.c_str(), width, height, srvIndex);

    auto& cached = m_cache[path];
    cached.resource = texture;
    cached.srvGpu = gpuHandle;
    cached.srvCpu = cpuHandle;
    cached.width = width;
    cached.height = height;
    cached.heapIndex = srvIndex;
    cached.ready = true;
    return &cached;
}

CachedTexture* TextureCache::loadFromMemory(const uint8_t* data, size_t size) {
    if (m_nextSrvIndex >= MAX_TEXTURES) return nullptr;

    // Create WIC stream from memory
    ComPtr<IWICStream> stream;
    m_wicFactory->CreateStream(&stream);
    stream->InitializeFromMemory(const_cast<uint8_t*>(data), (DWORD)size);

    ComPtr<IWICBitmapDecoder> decoder;
    HRESULT hr = m_wicFactory->CreateDecoderFromStream(stream.Get(), nullptr,
        WICDecodeMetadataCacheOnDemand, &decoder);
    if (FAILED(hr)) {
        fprintf(stderr, "[TextureCache] Failed to decode data URI: 0x%08x\n", hr);
        return nullptr;
    }

    ComPtr<IWICBitmapFrameDecode> frame;
    decoder->GetFrame(0, &frame);

    ComPtr<IWICFormatConverter> converter;
    m_wicFactory->CreateFormatConverter(&converter);
    converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppRGBA,
        WICBitmapDitherTypeNone, nullptr, 0.0, WICBitmapPaletteTypeCustom);

    UINT width, height;
    converter->GetSize(&width, &height);

    UINT rowPitch = width * 4;
    UINT imageSize = rowPitch * height;
    std::vector<uint8_t> pixels(imageSize);
    converter->CopyPixels(nullptr, rowPitch, imageSize, pixels.data());

    // Create DX12 texture (same as loadFromFile)
    D3D12_RESOURCE_DESC texDesc = {};
    texDesc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    texDesc.Width = width;
    texDesc.Height = height;
    texDesc.DepthOrArraySize = 1;
    texDesc.MipLevels = 1;
    texDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    texDesc.SampleDesc.Count = 1;

    D3D12_HEAP_PROPERTIES defaultHeap = {};
    defaultHeap.Type = D3D12_HEAP_TYPE_DEFAULT;

    ComPtr<ID3D12Resource> texture;
    hr = m_device->CreateCommittedResource(&defaultHeap, D3D12_HEAP_FLAG_NONE,
        &texDesc, D3D12_RESOURCE_STATE_COPY_DEST, nullptr, IID_PPV_ARGS(&texture));
    if (FAILED(hr)) return nullptr;

    UINT64 uploadSize = 0;
    D3D12_PLACED_SUBRESOURCE_FOOTPRINT footprint;
    m_device->GetCopyableFootprints(&texDesc, 0, 1, 0, &footprint, nullptr, nullptr, &uploadSize);

    D3D12_RESOURCE_DESC uploadDesc = {};
    uploadDesc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    uploadDesc.Width = uploadSize;
    uploadDesc.Height = 1;
    uploadDesc.DepthOrArraySize = 1;
    uploadDesc.MipLevels = 1;
    uploadDesc.Format = DXGI_FORMAT_UNKNOWN;
    uploadDesc.SampleDesc.Count = 1;
    uploadDesc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;

    D3D12_HEAP_PROPERTIES uploadHeap = {};
    uploadHeap.Type = D3D12_HEAP_TYPE_UPLOAD;

    ComPtr<ID3D12Resource> uploadBuffer;
    m_device->CreateCommittedResource(&uploadHeap, D3D12_HEAP_FLAG_NONE,
        &uploadDesc, D3D12_RESOURCE_STATE_GENERIC_READ, nullptr, IID_PPV_ARGS(&uploadBuffer));

    void* mapped = nullptr;
    uploadBuffer->Map(0, nullptr, &mapped);
    uint8_t* dst = (uint8_t*)mapped;
    for (UINT y = 0; y < height; y++) {
        memcpy(dst + y * footprint.Footprint.RowPitch, pixels.data() + y * rowPitch, rowPitch);
    }
    uploadBuffer->Unmap(0, nullptr);

    m_uploadAlloc->Reset();
    m_uploadCmdList->Reset(m_uploadAlloc.Get(), nullptr);

    D3D12_TEXTURE_COPY_LOCATION dstLoc = {};
    dstLoc.pResource = texture.Get();
    dstLoc.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;

    D3D12_TEXTURE_COPY_LOCATION srcLoc = {};
    srcLoc.pResource = uploadBuffer.Get();
    srcLoc.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
    srcLoc.PlacedFootprint = footprint;

    m_uploadCmdList->CopyTextureRegion(&dstLoc, 0, 0, 0, &srcLoc, nullptr);

    D3D12_RESOURCE_BARRIER barrier = {};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource = texture.Get();
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_DEST;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
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

    uint32_t srvIndex = m_nextSrvIndex++;
    D3D12_CPU_DESCRIPTOR_HANDLE cpuHandle = m_srvHeap->GetCPUDescriptorHandleForHeapStart();
    cpuHandle.ptr += srvIndex * m_srvDescriptorSize;
    D3D12_GPU_DESCRIPTOR_HANDLE gpuHandle = m_srvHeap->GetGPUDescriptorHandleForHeapStart();
    gpuHandle.ptr += srvIndex * m_srvDescriptorSize;

    D3D12_SHADER_RESOURCE_VIEW_DESC srvDesc = {};
    srvDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    srvDesc.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
    srvDesc.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
    srvDesc.Texture2D.MipLevels = 1;
    m_device->CreateShaderResourceView(texture.Get(), &srvDesc, cpuHandle);

    printf("[TextureCache] Loaded data URI (%ux%u) -> SRV[%u]\n", width, height, srvIndex);

    // Store in temp key
    static int dataUriCounter = 0;
    std::string key = "__datauri_" + std::to_string(dataUriCounter++);
    auto& cached = m_cache[key];
    cached.resource = texture;
    cached.srvGpu = gpuHandle;
    cached.srvCpu = cpuHandle;
    cached.width = width;
    cached.height = height;
    cached.heapIndex = srvIndex;
    cached.ready = true;
    return &cached;
}

bool TextureCache::isDataUri(const std::string& uri) const {
    return uri.size() > 5 && uri.substr(0, 5) == "data:";
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
