#pragma once

#include "mesh_data.h"
#include "math3d.h"
#include <d3d12.h>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;

struct ModelTransformCB {
    float mvp[16];       // row-major 4x4
    float model[16];     // row-major 4x4
    float cameraPos[4];  // xyz + pad
};

struct ModelMaterialCB {
    float baseColor[4];
    float opacity;
    float lightDir[3];
    float lightColor[3];
    float ambientIntensity;
    float _pad[3];
};

// Manages the DX12 pipeline for rendering 3D meshes with basic lighting.
// Parallel to RenderPipeline (2D quads) — shares the same device and command list.
class MeshRenderer {
public:
    bool init(ID3D12Device* device);
    bool isInitialized() const { return m_initialized; }

    // Ensure depth buffer matches screen dimensions
    void ensureDepthBuffer(ID3D12Device* device, int width, int height);

    // Clear the depth buffer at the start of a 3D pass
    void clearDepth(ID3D12GraphicsCommandList* cmdList);

    D3D12_CPU_DESCRIPTOR_HANDLE dsvHandle() const;

    // Bind the 3D pipeline (root signature + PSO + topology)
    void bind(ID3D12GraphicsCommandList* cmdList);

    // Draw one submesh of a GPU mesh
    void drawMesh(ID3D12GraphicsCommandList* cmdList,
                  const GpuMesh& mesh,
                  const SubMesh& submesh,
                  const ModelTransformCB& transform,
                  const ModelMaterialCB& material);

private:
    ComPtr<ID3D12RootSignature> m_rootSignature;
    ComPtr<ID3D12PipelineState> m_pso;

    // Depth buffer
    ComPtr<ID3D12Resource> m_depthBuffer;
    ComPtr<ID3D12DescriptorHeap> m_dsvHeap;
    int m_depthWidth = 0;
    int m_depthHeight = 0;

    bool m_initialized = false;
};
