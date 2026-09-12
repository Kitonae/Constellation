#pragma once

#include <d3d12.h>
#include <d3dcompiler.h>
#include <wrl/client.h>

#include "render_constants.h"

using Microsoft::WRL::ComPtr;

// Manages the DX12 pipeline state for rendering textured quads with effects.
// Two PSOs: BGRA (images, CPU-decoded video) and NV12 (GPU-decoded video).
class RenderPipeline {
public:
    bool init(ID3D12Device* device);

    void clearScreen(ID3D12GraphicsCommandList* cmdList,
                     D3D12_CPU_DESCRIPTOR_HANDLE rtv,
                     int width, int height,
                     float r, float g, float b, float a);

    // Set the SRV heap for texture binding
    void bindHeap(ID3D12GraphicsCommandList* cmdList, ID3D12DescriptorHeap* srvHeap);

    // Draw a textured quad with transform and effects (BGRA texture, 1 SRV)
    void drawQuad(ID3D12GraphicsCommandList* cmdList,
                  const TransformCB& transform,
                  const EffectsCB& effects,
                  D3D12_GPU_DESCRIPTOR_HANDLE textureSrv);

    // Draw a video quad with NV12 texture (2 SRVs: Y plane + UV plane)
    void drawVideoQuad(ID3D12GraphicsCommandList* cmdList,
                       const TransformCB& transform,
                       const EffectsCB& effects,
                       const ColorSpaceCB& colorSpace,
                       D3D12_GPU_DESCRIPTOR_HANDLE ySrv,
                       D3D12_GPU_DESCRIPTOR_HANDLE uvSrv);

    bool hasVideoPipeline() const { return m_videoPso != nullptr; }

    ID3D12RootSignature* rootSignature() const { return m_rootSignature.Get(); }

private:
    // BGRA pipeline (images + fallback video)
    ComPtr<ID3D12RootSignature> m_rootSignature;
    ComPtr<ID3D12PipelineState> m_pso;

    // NV12 video pipeline (2 SRVs: Y + UV)
    ComPtr<ID3D12RootSignature> m_videoRootSignature;
    ComPtr<ID3D12PipelineState> m_videoPso;

    ID3D12DescriptorHeap* m_boundHeap = nullptr;
    // Which PSO/root signature the command list currently has bound. Every
    // video quad used to switch to the NV12 pipeline and back again, so a run
    // of video clips paid two redundant state changes per draw. Draw order
    // cannot be sorted (alpha blending depends on it), so switch lazily
    // instead and only when the next draw actually needs the other pipeline.
    bool m_initialized = false;
    bool m_videoBound = false;
    void bindPipeline(ID3D12GraphicsCommandList* cmdList, bool video);
};
