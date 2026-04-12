#include "model_cache.h"
#include "model_loader.h"
#include <cstdio>
#include <cstring>

GpuMesh* ModelCache::getOrLoad(const std::string& uri, ID3D12Device* device) {
    auto it = m_cache.find(uri);
    if (it != m_cache.end()) {
        return it->second->ready ? it->second.get() : nullptr;
    }

    // Load from disk
    std::string localPath = uriToLocalPath(uri);
    LoadedModel model = loadModel(localPath);
    if (!model.valid) {
        // Cache a failed entry so we don't retry every frame
        auto gpu = std::make_unique<GpuMesh>();
        m_cache[uri] = std::move(gpu);
        return nullptr;
    }

    auto gpu = std::make_unique<GpuMesh>();
    if (!uploadToGpu(model, *gpu, device)) {
        m_cache[uri] = std::move(gpu);
        return nullptr;
    }

    gpu->submeshes = std::move(model.submeshes);
    memcpy(gpu->boundsMin, model.boundsMin, sizeof(float) * 3);
    memcpy(gpu->boundsMax, model.boundsMax, sizeof(float) * 3);
    gpu->ready = true;

    GpuMesh* ptr = gpu.get();
    m_cache[uri] = std::move(gpu);
    return ptr;
}

bool ModelCache::uploadToGpu(const LoadedModel& model, GpuMesh& gpu, ID3D12Device* device) {
    // Vertex buffer
    UINT vbSize = (UINT)(model.vertices.size() * sizeof(MeshVertex));
    D3D12_HEAP_PROPERTIES heapProps = {};
    heapProps.Type = D3D12_HEAP_TYPE_UPLOAD;

    D3D12_RESOURCE_DESC bufDesc = {};
    bufDesc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    bufDesc.Width = vbSize;
    bufDesc.Height = 1;
    bufDesc.DepthOrArraySize = 1;
    bufDesc.MipLevels = 1;
    bufDesc.SampleDesc.Count = 1;
    bufDesc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;

    HRESULT hr = device->CreateCommittedResource(
        &heapProps, D3D12_HEAP_FLAG_NONE, &bufDesc,
        D3D12_RESOURCE_STATE_GENERIC_READ, nullptr,
        IID_PPV_ARGS(&gpu.vertexBuffer));
    if (FAILED(hr)) {
        printf("[ModelCache] Failed to create vertex buffer (0x%08x)\n", hr);
        return false;
    }

    void* mapped = nullptr;
    gpu.vertexBuffer->Map(0, nullptr, &mapped);
    memcpy(mapped, model.vertices.data(), vbSize);
    gpu.vertexBuffer->Unmap(0, nullptr);

    gpu.vbView.BufferLocation = gpu.vertexBuffer->GetGPUVirtualAddress();
    gpu.vbView.SizeInBytes = vbSize;
    gpu.vbView.StrideInBytes = sizeof(MeshVertex);

    // Index buffer
    UINT ibSize = (UINT)(model.indices.size() * sizeof(uint32_t));
    bufDesc.Width = ibSize;

    hr = device->CreateCommittedResource(
        &heapProps, D3D12_HEAP_FLAG_NONE, &bufDesc,
        D3D12_RESOURCE_STATE_GENERIC_READ, nullptr,
        IID_PPV_ARGS(&gpu.indexBuffer));
    if (FAILED(hr)) {
        printf("[ModelCache] Failed to create index buffer (0x%08x)\n", hr);
        return false;
    }

    gpu.indexBuffer->Map(0, nullptr, &mapped);
    memcpy(mapped, model.indices.data(), ibSize);
    gpu.indexBuffer->Unmap(0, nullptr);

    gpu.ibView.BufferLocation = gpu.indexBuffer->GetGPUVirtualAddress();
    gpu.ibView.SizeInBytes = ibSize;
    gpu.ibView.Format = DXGI_FORMAT_R32_UINT;

    printf("[ModelCache] Uploaded mesh: %u verts (%u bytes), %u indices (%u bytes)\n",
           (UINT)model.vertices.size(), vbSize, (UINT)model.indices.size(), ibSize);
    return true;
}

void ModelCache::shutdown() {
    m_cache.clear();
}
