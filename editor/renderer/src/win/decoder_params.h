#pragma once
// What a VideoDecoder needs from App to open on the GPU. Windows: the D3D12
// device and queue, the shared D3D11/DXVA device, and the fences that order
// decode against render.

#include "video_decoder.h"

struct DecoderParams {
    ID3D12Device* d3d12Device = nullptr;
    ID3D11Device* d3d11Device = nullptr;
    IMFDXGIDeviceManager* dxgiManager = nullptr;
    ID3D11On12Device2* d3d11On12 = nullptr;
    ID3D12CommandQueue* d3d12Queue = nullptr;
    bool nv12Mode = false;
    bool verbose = false;
    DecoderSync sync;
};
