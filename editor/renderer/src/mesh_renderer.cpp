#include "mesh_renderer.h"
#include <cstdio>
#include <cstring>

#ifdef SHADERS_COMPILE_AT_RUNTIME
#include <d3dcompiler.h>
#else
#include "model_vs.h"
#include "model_ps.h"
#endif

bool MeshRenderer::init(ID3D12Device* device) {
    // --- Root signature ---
    // [0] 36 DWORDs root constants (b0, VS) — ModelTransformCB
    // [1] 16 DWORDs root constants (b1, PS) — ModelMaterialCB
    D3D12_ROOT_PARAMETER rootParams[2] = {};

    rootParams[0].ParameterType = D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS;
    rootParams[0].Constants.ShaderRegister = 0;
    rootParams[0].Constants.RegisterSpace = 0;
    rootParams[0].Constants.Num32BitValues = 36; // 2 matrices (32) + cameraPos (4)
    rootParams[0].ShaderVisibility = D3D12_SHADER_VISIBILITY_VERTEX;

    rootParams[1].ParameterType = D3D12_ROOT_PARAMETER_TYPE_32BIT_CONSTANTS;
    rootParams[1].Constants.ShaderRegister = 1;
    rootParams[1].Constants.RegisterSpace = 0;
    rootParams[1].Constants.Num32BitValues = 16; // baseColor(4) + opacity(1) + lightDir(3) + lightColor(3) + ambient(1) + pad(4)
    rootParams[1].ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;

    D3D12_ROOT_SIGNATURE_DESC rsDesc = {};
    rsDesc.NumParameters = 2;
    rsDesc.pParameters = rootParams;
    rsDesc.Flags = D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT;

    ComPtr<ID3DBlob> sigBlob, errorBlob;
    HRESULT hr = D3D12SerializeRootSignature(&rsDesc, D3D_ROOT_SIGNATURE_VERSION_1, &sigBlob, &errorBlob);
    if (FAILED(hr)) {
        printf("[MeshRenderer] Root signature serialization failed: %s\n",
               errorBlob ? (char*)errorBlob->GetBufferPointer() : "unknown");
        return false;
    }

    hr = device->CreateRootSignature(0, sigBlob->GetBufferPointer(), sigBlob->GetBufferSize(),
                                     IID_PPV_ARGS(&m_rootSignature));
    if (FAILED(hr)) {
        printf("[MeshRenderer] CreateRootSignature failed (0x%08x)\n", hr);
        return false;
    }

    // --- PSO ---
    D3D12_INPUT_ELEMENT_DESC inputLayout[] = {
        { "POSITION", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 0,  D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0 },
        { "NORMAL",   0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 12, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0 },
        { "TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT,    0, 24, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0 },
    };

    D3D12_GRAPHICS_PIPELINE_STATE_DESC psoDesc = {};
    psoDesc.pRootSignature = m_rootSignature.Get();
    psoDesc.InputLayout = { inputLayout, _countof(inputLayout) };

#ifdef SHADERS_COMPILE_AT_RUNTIME
    // Runtime compilation fallback
    ComPtr<ID3DBlob> vsBlob, psBlob, err;
    D3DCompileFromFile(L"shaders/model_vs.hlsl", nullptr, nullptr, "VSMain", "vs_5_0", 0, 0, &vsBlob, &err);
    if (!vsBlob) { printf("[MeshRenderer] VS compile failed: %s\n", err ? (char*)err->GetBufferPointer() : ""); return false; }
    D3DCompileFromFile(L"shaders/model_ps.hlsl", nullptr, nullptr, "PSMain", "ps_5_0", 0, 0, &psBlob, &err);
    if (!psBlob) { printf("[MeshRenderer] PS compile failed: %s\n", err ? (char*)err->GetBufferPointer() : ""); return false; }
    psoDesc.VS = { vsBlob->GetBufferPointer(), vsBlob->GetBufferSize() };
    psoDesc.PS = { psBlob->GetBufferPointer(), psBlob->GetBufferSize() };
#else
    psoDesc.VS = { g_modelVS, sizeof(g_modelVS) };
    psoDesc.PS = { g_modelPS, sizeof(g_modelPS) };
#endif

    // Rasterizer
    psoDesc.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
    psoDesc.RasterizerState.CullMode = D3D12_CULL_MODE_BACK;
    psoDesc.RasterizerState.FrontCounterClockwise = FALSE;
    psoDesc.RasterizerState.DepthClipEnable = TRUE;

    // Blend (alpha)
    psoDesc.BlendState.RenderTarget[0].BlendEnable = TRUE;
    psoDesc.BlendState.RenderTarget[0].SrcBlend = D3D12_BLEND_ONE; // premultiplied
    psoDesc.BlendState.RenderTarget[0].DestBlend = D3D12_BLEND_INV_SRC_ALPHA;
    psoDesc.BlendState.RenderTarget[0].BlendOp = D3D12_BLEND_OP_ADD;
    psoDesc.BlendState.RenderTarget[0].SrcBlendAlpha = D3D12_BLEND_ONE;
    psoDesc.BlendState.RenderTarget[0].DestBlendAlpha = D3D12_BLEND_INV_SRC_ALPHA;
    psoDesc.BlendState.RenderTarget[0].BlendOpAlpha = D3D12_BLEND_OP_ADD;
    psoDesc.BlendState.RenderTarget[0].RenderTargetWriteMask = D3D12_COLOR_WRITE_ENABLE_ALL;

    // Depth-stencil
    psoDesc.DepthStencilState.DepthEnable = TRUE;
    psoDesc.DepthStencilState.DepthWriteMask = D3D12_DEPTH_WRITE_MASK_ALL;
    psoDesc.DepthStencilState.DepthFunc = D3D12_COMPARISON_FUNC_LESS;
    psoDesc.DSVFormat = DXGI_FORMAT_D32_FLOAT;

    psoDesc.SampleMask = UINT_MAX;
    psoDesc.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    psoDesc.NumRenderTargets = 1;
    psoDesc.RTVFormats[0] = DXGI_FORMAT_R8G8B8A8_UNORM;
    psoDesc.SampleDesc.Count = 1;

    hr = device->CreateGraphicsPipelineState(&psoDesc, IID_PPV_ARGS(&m_pso));
    if (FAILED(hr)) {
        printf("[MeshRenderer] CreateGraphicsPipelineState failed (0x%08x)\n", hr);
        return false;
    }

    // --- DSV heap ---
    D3D12_DESCRIPTOR_HEAP_DESC dsvHeapDesc = {};
    dsvHeapDesc.NumDescriptors = 1;
    dsvHeapDesc.Type = D3D12_DESCRIPTOR_HEAP_TYPE_DSV;
    hr = device->CreateDescriptorHeap(&dsvHeapDesc, IID_PPV_ARGS(&m_dsvHeap));
    if (FAILED(hr)) {
        printf("[MeshRenderer] CreateDescriptorHeap (DSV) failed (0x%08x)\n", hr);
        return false;
    }

    m_initialized = true;
    printf("[MeshRenderer] Initialized\n");
    return true;
}

void MeshRenderer::ensureDepthBuffer(ID3D12Device* device, int width, int height) {
    if (m_depthWidth == width && m_depthHeight == height && m_depthBuffer) return;

    m_depthBuffer.Reset();
    m_depthWidth = width;
    m_depthHeight = height;

    D3D12_HEAP_PROPERTIES heapProps = {};
    heapProps.Type = D3D12_HEAP_TYPE_DEFAULT;

    D3D12_RESOURCE_DESC depthDesc = {};
    depthDesc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    depthDesc.Width = width;
    depthDesc.Height = height;
    depthDesc.DepthOrArraySize = 1;
    depthDesc.MipLevels = 1;
    depthDesc.Format = DXGI_FORMAT_D32_FLOAT;
    depthDesc.SampleDesc.Count = 1;
    depthDesc.Flags = D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL;

    D3D12_CLEAR_VALUE clearVal = {};
    clearVal.Format = DXGI_FORMAT_D32_FLOAT;
    clearVal.DepthStencil.Depth = 1.0f;

    HRESULT hr = device->CreateCommittedResource(
        &heapProps, D3D12_HEAP_FLAG_NONE, &depthDesc,
        D3D12_RESOURCE_STATE_DEPTH_WRITE, &clearVal,
        IID_PPV_ARGS(&m_depthBuffer));
    if (FAILED(hr)) {
        printf("[MeshRenderer] Failed to create depth buffer %dx%d (0x%08x)\n", width, height, hr);
        return;
    }

    D3D12_DEPTH_STENCIL_VIEW_DESC dsvDesc = {};
    dsvDesc.Format = DXGI_FORMAT_D32_FLOAT;
    dsvDesc.ViewDimension = D3D12_DSV_DIMENSION_TEXTURE2D;
    device->CreateDepthStencilView(m_depthBuffer.Get(), &dsvDesc, m_dsvHeap->GetCPUDescriptorHandleForHeapStart());
}

void MeshRenderer::clearDepth(ID3D12GraphicsCommandList* cmdList) {
    if (!m_depthBuffer) return;
    cmdList->ClearDepthStencilView(dsvHandle(), D3D12_CLEAR_FLAG_DEPTH, 1.0f, 0, 0, nullptr);
}

D3D12_CPU_DESCRIPTOR_HANDLE MeshRenderer::dsvHandle() const {
    return m_dsvHeap->GetCPUDescriptorHandleForHeapStart();
}

void MeshRenderer::bind(ID3D12GraphicsCommandList* cmdList) {
    cmdList->SetGraphicsRootSignature(m_rootSignature.Get());
    cmdList->SetPipelineState(m_pso.Get());
    cmdList->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
}

void MeshRenderer::drawMesh(ID3D12GraphicsCommandList* cmdList,
                             const GpuMesh& mesh,
                             const SubMesh& submesh,
                             const ModelTransformCB& transform,
                             const ModelMaterialCB& material) {
    // Set constant buffers via root constants
    cmdList->SetGraphicsRoot32BitConstants(0, 36, &transform, 0);
    cmdList->SetGraphicsRoot32BitConstants(1, 16, &material, 0);

    // Bind vertex + index buffers
    cmdList->IASetVertexBuffers(0, 1, &mesh.vbView);
    cmdList->IASetIndexBuffer(&mesh.ibView);

    // Draw
    cmdList->DrawIndexedInstanced(submesh.indexCount, 1, submesh.indexOffset, 0, 0);
}
