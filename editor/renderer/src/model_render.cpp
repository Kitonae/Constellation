#define NOMINMAX
#include "model_source.h"
#include <d3d11.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include <algorithm>
#include <cstddef>
#include <cstring>
#include <stdexcept>

using Microsoft::WRL::ComPtr;

namespace {
void check(HRESULT result, const char* message) {
    if (FAILED(result)) throw std::runtime_error(message);
}

// Same orthographic frame and base-colour lighting as media/modelContent.js.
// This is a source render on the loader thread, not work repeated per output
// frame. The DX12 compositor caches it and applies the clip's layout/effects.
const char* shader = R"(
cbuffer Material : register(b0) { float4 tint; float cutoff; float alphaMode; float2 padding; };
Texture2D baseMap : register(t0);
SamplerState textureSampler : register(s0);
struct Vertex { float3 p : POSITION; float3 n : NORMAL; float2 uv : TEXCOORD; float4 color : COLOR; };
struct Pixel { float4 p : SV_POSITION; float3 n : NORMAL; float2 uv : TEXCOORD; float4 color : COLOR; };
Pixel VSMain(Vertex v) {
    Pixel o;
    o.p = float4(v.p.xy, 0.5 - v.p.z * 0.25, 1);
    o.n = v.n; o.uv = v.uv; o.color = v.color;
    return o;
}
float4 PSMain(Pixel v) : SV_TARGET {
    float4 base = baseMap.Sample(textureSampler, v.uv) * tint * v.color;
    if (alphaMode < 0.5) base.a = 1;
    clip(base.a - cutoff);
    if (alphaMode < 1.5) base.a = 1;
    float3 n = dot(v.n, v.n) > 1e-12 ? normalize(v.n) : float3(0, 0, 1);
    float light = 0.4 + 0.6 * abs(dot(n, normalize(float3(3, 4, 5))));
    float3 linearColor = max(base.rgb * light, 0);
    float3 srgb = lerp(1.055 * pow(linearColor, 1.0/2.4) - 0.055,
                       linearColor * 12.92, step(linearColor, 0.0031308));
    return float4(srgb, base.a);
}
)";

ComPtr<ID3DBlob> compile(const char* entry, const char* target) {
    ComPtr<ID3DBlob> code, errors;
    const HRESULT result = D3DCompile(shader, strlen(shader), "model-source", nullptr, nullptr,
        entry, target, D3DCOMPILE_ENABLE_STRICTNESS, 0, &code, &errors);
    if (FAILED(result)) throw std::runtime_error(errors ? static_cast<const char*>(errors->GetBufferPointer()) : "Cannot compile model shader");
    return code;
}
} // namespace

bool renderModelSource(const ModelSource& model, uint32_t size, std::vector<uint8_t>& rgba, std::string& error) {
    rgba.clear();
    error.clear();
    if (size == 0 || size > 4096 || model.parts.empty()) { error = "Invalid model render size or geometry"; return false; }
    try {
        ComPtr<ID3D11Device> device;
        ComPtr<ID3D11DeviceContext> context;
        const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_0};
        HRESULT result = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, 0,
            levels, 1, D3D11_SDK_VERSION, &device, nullptr, &context);
        if (FAILED(result)) result = D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0,
            levels, 1, D3D11_SDK_VERSION, &device, nullptr, &context);
        check(result, "Cannot create model graphics device");
        const auto vsCode = compile("VSMain", "vs_5_0");
        const auto psCode = compile("PSMain", "ps_5_0");
        ComPtr<ID3D11VertexShader> vs;
        ComPtr<ID3D11PixelShader> ps;
        check(device->CreateVertexShader(vsCode->GetBufferPointer(), vsCode->GetBufferSize(), nullptr, &vs), "Cannot create model vertex shader");
        check(device->CreatePixelShader(psCode->GetBufferPointer(), psCode->GetBufferSize(), nullptr, &ps), "Cannot create model pixel shader");
        D3D11_INPUT_ELEMENT_DESC attributes[] = {
            {"POSITION", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, offsetof(ModelVertex, position), D3D11_INPUT_PER_VERTEX_DATA, 0},
            {"NORMAL", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, offsetof(ModelVertex, normal), D3D11_INPUT_PER_VERTEX_DATA, 0},
            {"TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT, 0, offsetof(ModelVertex, uv), D3D11_INPUT_PER_VERTEX_DATA, 0},
            {"COLOR", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, offsetof(ModelVertex, color), D3D11_INPUT_PER_VERTEX_DATA, 0},
        };
        ComPtr<ID3D11InputLayout> layout;
        check(device->CreateInputLayout(attributes, 4, vsCode->GetBufferPointer(), vsCode->GetBufferSize(), &layout), "Cannot create model input layout");

        UINT colorQuality = 0, depthQuality = 0;
        device->CheckMultisampleQualityLevels(DXGI_FORMAT_R8G8B8A8_UNORM, 4, &colorQuality);
        device->CheckMultisampleQualityLevels(DXGI_FORMAT_D32_FLOAT, 4, &depthQuality);
        D3D11_TEXTURE2D_DESC targetDesc{};
        targetDesc.Width = targetDesc.Height = size;
        targetDesc.MipLevels = targetDesc.ArraySize = 1;
        targetDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
        targetDesc.SampleDesc.Count = colorQuality && depthQuality ? 4 : 1;
        targetDesc.BindFlags = D3D11_BIND_RENDER_TARGET;
        ComPtr<ID3D11Texture2D> target;
        check(device->CreateTexture2D(&targetDesc, nullptr, &target), "Cannot create model render target");
        ComPtr<ID3D11RenderTargetView> rtv;
        check(device->CreateRenderTargetView(target.Get(), nullptr, &rtv), "Cannot create model render view");
        auto depthDesc = targetDesc;
        depthDesc.Format = DXGI_FORMAT_D32_FLOAT;
        depthDesc.BindFlags = D3D11_BIND_DEPTH_STENCIL;
        ComPtr<ID3D11Texture2D> depth;
        ComPtr<ID3D11DepthStencilView> dsv;
        check(device->CreateTexture2D(&depthDesc, nullptr, &depth), "Cannot create model depth target");
        check(device->CreateDepthStencilView(depth.Get(), nullptr, &dsv), "Cannot create model depth view");
        D3D11_RASTERIZER_DESC rasterDesc{};
        rasterDesc.FillMode = D3D11_FILL_SOLID;
        rasterDesc.CullMode = D3D11_CULL_NONE;
        rasterDesc.DepthClipEnable = TRUE;
        rasterDesc.MultisampleEnable = TRUE;
        ComPtr<ID3D11RasterizerState> raster;
        check(device->CreateRasterizerState(&rasterDesc, &raster), "Cannot create model rasterizer");
        D3D11_BLEND_DESC blendDesc{};
        auto& blend = blendDesc.RenderTarget[0];
        blend.BlendEnable = TRUE;
        blend.SrcBlend = D3D11_BLEND_SRC_ALPHA;
        blend.DestBlend = D3D11_BLEND_INV_SRC_ALPHA;
        blend.BlendOp = blend.BlendOpAlpha = D3D11_BLEND_OP_ADD;
        blend.SrcBlendAlpha = D3D11_BLEND_ONE;
        blend.DestBlendAlpha = D3D11_BLEND_INV_SRC_ALPHA;
        blend.RenderTargetWriteMask = D3D11_COLOR_WRITE_ENABLE_ALL;
        ComPtr<ID3D11BlendState> blending;
        check(device->CreateBlendState(&blendDesc, &blending), "Cannot create model blending");
        D3D11_SAMPLER_DESC samplerDesc{};
        samplerDesc.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
        samplerDesc.AddressU = samplerDesc.AddressV = samplerDesc.AddressW = D3D11_TEXTURE_ADDRESS_WRAP;
        samplerDesc.MaxLOD = D3D11_FLOAT32_MAX;
        const float clear[4] = {};
        context->ClearRenderTargetView(rtv.Get(), clear);
        context->ClearDepthStencilView(dsv.Get(), D3D11_CLEAR_DEPTH, 1, 0);
        ID3D11RenderTargetView* targets[] = {rtv.Get()};
        context->OMSetRenderTargets(1, targets, dsv.Get());
        context->OMSetBlendState(blending.Get(), nullptr, UINT_MAX);
        const D3D11_VIEWPORT viewport = {0, 0, (float)size, (float)size, 0, 1};
        context->RSSetViewports(1, &viewport);
        context->RSSetState(raster.Get());
        context->IASetInputLayout(layout.Get());
        context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        context->VSSetShader(vs.Get(), nullptr, 0);
        context->PSSetShader(ps.Get(), nullptr, 0);

        for (const auto& part : model.parts) {
            if (part.vertices.empty() || part.indices.empty()) continue;
            auto address = [](int wrap) {
                return wrap == 33071 ? D3D11_TEXTURE_ADDRESS_CLAMP :
                    wrap == 33648 ? D3D11_TEXTURE_ADDRESS_MIRROR : D3D11_TEXTURE_ADDRESS_WRAP;
            };
            samplerDesc.AddressU = address(part.wrapS);
            samplerDesc.AddressV = address(part.wrapT);
            ComPtr<ID3D11SamplerState> sampler;
            check(device->CreateSamplerState(&samplerDesc, &sampler), "Cannot create model sampler");
            ID3D11SamplerState* samplers[] = {sampler.Get()};
            context->PSSetSamplers(0, 1, samplers);
            D3D11_BUFFER_DESC bufferDesc{};
            bufferDesc.Usage = D3D11_USAGE_IMMUTABLE;
            bufferDesc.BindFlags = D3D11_BIND_VERTEX_BUFFER;
            bufferDesc.ByteWidth = (UINT)(part.vertices.size() * sizeof(ModelVertex));
            D3D11_SUBRESOURCE_DATA initial{};
            initial.pSysMem = part.vertices.data();
            ComPtr<ID3D11Buffer> vertices, indices, constants;
            check(device->CreateBuffer(&bufferDesc, &initial, &vertices), "Cannot upload model vertices");
            bufferDesc.BindFlags = D3D11_BIND_INDEX_BUFFER;
            bufferDesc.ByteWidth = (UINT)(part.indices.size() * sizeof(uint32_t));
            initial.pSysMem = part.indices.data();
            check(device->CreateBuffer(&bufferDesc, &initial, &indices), "Cannot upload model indices");
            const float material[] = {part.tint[0], part.tint[1], part.tint[2], part.tint[3], part.alphaCutoff, (float)part.alphaMode, 0, 0};
            bufferDesc.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
            bufferDesc.ByteWidth = sizeof(material);
            initial.pSysMem = material;
            check(device->CreateBuffer(&bufferDesc, &initial, &constants), "Cannot upload model material");
            D3D11_TEXTURE2D_DESC textureDesc{};
            textureDesc.Width = part.textureWidth; textureDesc.Height = part.textureHeight;
            textureDesc.MipLevels = textureDesc.ArraySize = textureDesc.SampleDesc.Count = 1;
            textureDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM_SRGB;
            textureDesc.Usage = D3D11_USAGE_IMMUTABLE;
            textureDesc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
            initial.pSysMem = part.texture.data();
            initial.SysMemPitch = part.textureWidth * 4;
            ComPtr<ID3D11Texture2D> texture;
            ComPtr<ID3D11ShaderResourceView> srv;
            check(device->CreateTexture2D(&textureDesc, &initial, &texture), "Cannot upload model texture");
            check(device->CreateShaderResourceView(texture.Get(), nullptr, &srv), "Cannot create model texture view");
            UINT stride = sizeof(ModelVertex), offset = 0;
            ID3D11Buffer* buffers[] = {vertices.Get()};
            context->IASetVertexBuffers(0, 1, buffers, &stride, &offset);
            context->IASetIndexBuffer(indices.Get(), DXGI_FORMAT_R32_UINT, 0);
            ID3D11Buffer* materialBuffers[] = {constants.Get()};
            context->PSSetConstantBuffers(0, 1, materialBuffers);
            ID3D11ShaderResourceView* textures[] = {srv.Get()};
            context->PSSetShaderResources(0, 1, textures);
            context->DrawIndexed((UINT)part.indices.size(), 0, 0);
        }

        // Read once on this background thread. The returned straight-alpha
        // pixels enter the same DX12 texture cache as other static sources.
        auto resolvedDesc = targetDesc;
        resolvedDesc.SampleDesc.Count = 1;
        resolvedDesc.BindFlags = 0;
        ComPtr<ID3D11Texture2D> resolved;
        check(device->CreateTexture2D(&resolvedDesc, nullptr, &resolved), "Cannot resolve model frame");
        if (targetDesc.SampleDesc.Count > 1) context->ResolveSubresource(resolved.Get(), 0, target.Get(), 0, targetDesc.Format);
        else context->CopyResource(resolved.Get(), target.Get());
        resolvedDesc.Usage = D3D11_USAGE_STAGING;
        resolvedDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        ComPtr<ID3D11Texture2D> readback;
        check(device->CreateTexture2D(&resolvedDesc, nullptr, &readback), "Cannot create model readback");
        context->CopyResource(readback.Get(), resolved.Get());
        D3D11_MAPPED_SUBRESOURCE mapped{};
        check(context->Map(readback.Get(), 0, D3D11_MAP_READ, 0, &mapped), "Cannot read model frame");
        rgba.resize(size_t(size) * size * 4);
        for (uint32_t y = 0; y < size; y++)
            std::memcpy(rgba.data() + size_t(y)*size*4, static_cast<uint8_t*>(mapped.pData) + size_t(y)*mapped.RowPitch, size*4);
        context->Unmap(readback.Get(), 0);
        for (size_t i = 0; i < rgba.size(); i += 4) {
            const uint32_t alpha = rgba[i+3];
            if (alpha) for (int c = 0; c < 3; c++) rgba[i+c] = (uint8_t)std::min(255u, (rgba[i+c]*255u + alpha/2)/alpha);
        }
        return true;
    } catch (const std::exception& exception) {
        rgba.clear();
        error = exception.what();
        return false;
    }
}
