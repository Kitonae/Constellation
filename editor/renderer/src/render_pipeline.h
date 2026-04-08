#pragma once

#include <d3d12.h>
#include <d3dcompiler.h>
#include <wrl/client.h>

using Microsoft::WRL::ComPtr;

struct TransformCB {
    float position[2];   // world-space offset from center (pixels)
    float scale[2];      // pixel width/height of the quad
    float screenSize[2]; // viewport dimensions
    float _pad[2];
};

struct EffectsCB {
    float opacity;
    float blur_radius;
    float brightness;
    float contrast;
    float saturate_amount;
    float grayscale;
    float sepia;
    float hue_rotate_deg;
    float invert;
    float _pad[3];
};

// Manages the DX12 pipeline state for rendering textured quads with effects.
class RenderPipeline {
public:
    bool init(ID3D12Device* device);

    void clearScreen(ID3D12GraphicsCommandList* cmdList,
                     D3D12_CPU_DESCRIPTOR_HANDLE rtv,
                     int width, int height,
                     float r, float g, float b, float a);

    // Set the SRV heap for texture binding
    void bindHeap(ID3D12GraphicsCommandList* cmdList, ID3D12DescriptorHeap* srvHeap);

    // Draw a textured quad with transform and effects
    void drawQuad(ID3D12GraphicsCommandList* cmdList,
                  const TransformCB& transform,
                  const EffectsCB& effects,
                  D3D12_GPU_DESCRIPTOR_HANDLE textureSrv);

    ID3D12RootSignature* rootSignature() const { return m_rootSignature.Get(); }

private:
    ComPtr<ID3D12RootSignature> m_rootSignature;
    ComPtr<ID3D12PipelineState> m_pso;
    bool m_initialized = false;
};
