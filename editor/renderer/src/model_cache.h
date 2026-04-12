#pragma once

#include "mesh_data.h"
#include <d3d12.h>
#include <string>
#include <unordered_map>
#include <memory>

// Caches loaded 3D models as GPU-ready vertex/index buffers, keyed by URI.
class ModelCache {
public:
    // Get a GPU mesh for the given URI, loading from disk if not cached.
    // Returns nullptr if the model couldn't be loaded.
    GpuMesh* getOrLoad(const std::string& uri, ID3D12Device* device);

    // Release all GPU resources.
    void shutdown();

private:
    bool uploadToGpu(const LoadedModel& model, GpuMesh& gpu, ID3D12Device* device);
    std::unordered_map<std::string, std::unique_ptr<GpuMesh>> m_cache;
};
