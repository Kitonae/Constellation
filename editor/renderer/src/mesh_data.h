#pragma once

#include <d3d12.h>
#include <wrl/client.h>
#include <vector>
#include <string>
#include <cstdint>

using Microsoft::WRL::ComPtr;

struct MeshVertex {
    float position[3];
    float normal[3];
    float uv[2];
};

struct SubMesh {
    uint32_t indexOffset;
    uint32_t indexCount;
    float baseColor[4]; // RGBA from material
};

struct LoadedModel {
    std::vector<MeshVertex> vertices;
    std::vector<uint32_t> indices;
    std::vector<SubMesh> submeshes;
    float boundsMin[3];
    float boundsMax[3];
    bool valid = false;
};

struct GpuMesh {
    ComPtr<ID3D12Resource> vertexBuffer;
    ComPtr<ID3D12Resource> indexBuffer;
    D3D12_VERTEX_BUFFER_VIEW vbView = {};
    D3D12_INDEX_BUFFER_VIEW ibView = {};
    std::vector<SubMesh> submeshes;
    float boundsMin[3] = {};
    float boundsMax[3] = {};
    bool ready = false;
};
