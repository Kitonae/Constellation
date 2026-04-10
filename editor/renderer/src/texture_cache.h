#pragma once

#include <d3d12.h>
#include <dxgi1_6.h>
#include <wrl/client.h>
#include <wincodec.h>
#include <string>
#include <unordered_map>
#include <mutex>
#include <vector>

using Microsoft::WRL::ComPtr;

struct CachedTexture {
    ComPtr<ID3D12Resource> resource;
    ComPtr<ID3D12Resource> uploadBuffers[2];  // double-buffered for async upload
    int uploadIdx = 0;                        // which upload buffer to write next
    UINT64 uploadFenceVal = 0;                // fence value of last upload for this texture
    D3D12_GPU_DESCRIPTOR_HANDLE srvGpu;
    D3D12_CPU_DESCRIPTOR_HANDLE srvCpu;
    uint32_t width = 0;
    uint32_t height = 0;
    uint32_t heapIndex = 0;
    bool ready = false;
};

// TextureCache loads images from disk via WIC and uploads them to DX12 textures.
// Textures are cached by URI string.
class TextureCache {
public:
    bool init(ID3D12Device* device, ID3D12CommandQueue* cmdQueue);
    void shutdown();

    // Get or load a texture. Returns nullptr if not yet loaded or failed.
    // URI should be a file:/// path or absolute path.
    const CachedTexture* get(const std::string& uri);

    // Upload raw pixels as a texture, keyed by a string ID.
    // If the key already exists and dimensions match, updates the existing texture in-place.
    // format: DXGI_FORMAT_R8G8B8A8_UNORM or DXGI_FORMAT_B8G8R8A8_UNORM
    // Returns nullptr on failure.
    const CachedTexture* uploadPixels(const std::string& key, const uint8_t* pixels,
                                      uint32_t width, uint32_t height,
                                      DXGI_FORMAT format = DXGI_FORMAT_R8G8B8A8_UNORM);

    // Convenience: upload RGBA pixels
    const CachedTexture* uploadRGBA(const std::string& key, const uint8_t* pixels,
                                     uint32_t width, uint32_t height) {
        return uploadPixels(key, pixels, width, height, DXGI_FORMAT_R8G8B8A8_UNORM);
    }

    ID3D12DescriptorHeap* srvHeap() const { return m_srvHeap.Get(); }

private:
    CachedTexture* loadFromFile(const std::string& path);
    CachedTexture* loadFromMemory(const uint8_t* data, size_t size);
    std::string uriToPath(const std::string& uri) const;
    bool isDataUri(const std::string& uri) const;
    std::vector<uint8_t> decodeDataUri(const std::string& uri) const;
    void executeUpload();

    ID3D12Device* m_device = nullptr;
    ID3D12CommandQueue* m_cmdQueue = nullptr;
    ComPtr<IWICImagingFactory> m_wicFactory;

    // SRV heap (shader-visible)
    ComPtr<ID3D12DescriptorHeap> m_srvHeap;
    uint32_t m_srvDescriptorSize = 0;
    uint32_t m_nextSrvIndex = 0;
    static const uint32_t MAX_TEXTURES = 512;

    // Upload resources
    ComPtr<ID3D12CommandAllocator> m_uploadAlloc;
    ComPtr<ID3D12GraphicsCommandList> m_uploadCmdList;
    ComPtr<ID3D12Fence> m_uploadFence;
    HANDLE m_uploadEvent = nullptr;
    UINT64 m_uploadFenceValue = 0;

    std::unordered_map<std::string, CachedTexture> m_cache;
};
