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

// YUV -> RGB conversion parameters for the NV12 shader. Read from the
// stream's nominal range and matrix instead of assuming BT.709 limited range.
struct ColorSpaceCB {
    float yOffset = 16.0f / 255.0f;
    float yScale = 255.0f / 219.0f;
    float cOffset = 128.0f / 255.0f;
    float cScale = 255.0f / 224.0f;
    float kr = 0.2126f;
    float kb = 0.0722f;
    // Visible size over allocated size. The D3D12 decode path writes into a
    // macroblock-aligned surface, so the shader has to stop short of the
    // padding rows; every other path hands back an exact fit and leaves this
    // at one.
    float uvScaleX = 1.0f;
    float uvScaleY = 1.0f;
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
