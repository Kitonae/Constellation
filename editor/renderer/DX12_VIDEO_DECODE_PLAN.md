# DX12 Video Decode Migration Plan

## Status

- **Phase 1** (DXGI Shared Textures): IMPLEMENTED, compiles clean
- **Phase 2** (D3D11On12 + NV12 zero-copy): IMPLEMENTED, compiles clean
- **Phase 3** (Full D3D12 Video Decode): Planned, not started

## Overview

Replace the D3D11/DXVA video decode pipeline (GPU decode → CPU readback → GPU re-upload) with a zero-copy GPU path. This eliminates the primary performance bottleneck in the native renderer's video playback.

**Current bottleneck**: `video_decoder.cpp:readOneFrame()` copies every decoded pixel through CPU memory. At 1080p/30fps = ~237 MB/s wasted bandwidth. At 4K = ~950 MB/s.

---

## Current Architecture

```
MF SourceReader + D3D11 DXVA
  → GPU decode to D3D11 texture (NV12 internally)
  → MF converts NV12 → RGB32 (BGRA) on GPU
  → CopySubresourceRegion to D3D11 staging texture
  → Map staging → memcpy rows to std::vector<uint8_t>  ← BOTTLENECK
  → TextureCache.uploadPixels() → UPLOAD heap → DEFAULT heap
  → effects_ps.hlsl renders textured quad
```

### Key files (current)

| File | Role |
|------|------|
| `video_decoder.h/cpp` | DXVA init, decode loop, CPU readback |
| `app.h/cpp` | D3D12 device, shared D3D11 device, render loop |
| `texture_cache.h/cpp` | WIC image load, pixel upload, SRV management |
| `render_pipeline.h/cpp` | Root signature, PSO, drawQuad |
| `shaders/effects_ps.hlsl` | CSS-style effects on BGRA texture |
| `shaders/quad_vs.hlsl` | Procedural quad from SV_VertexID |

---

## Target Architecture (Phase 1 — DXGI Shared Textures)

```
MF SourceReader + D3D11 DXVA (unchanged)
  → GPU decode to D3D11 texture (NV12 internally)
  → MF converts NV12 → RGB32 (BGRA) on GPU (unchanged)
  → CopySubresourceRegion to shared DXGI texture (~50μs GPU-to-GPU)
  → D3D12 opens shared handle → ID3D12Resource (already on GPU)
  → Create SRV → render with existing effects_ps.hlsl (no shader changes)
```

**Result**: ~240x faster video frame path (12ms → 0.05ms per 1080p frame).

---

## Phase 1: DXGI Shared Textures (eliminates CPU readback)

**Effort**: ~1-2 days | **Risk**: Low | **Shader changes**: None

This approach keeps MF doing all the hard work (demuxing, bitstream parsing, DPB management, NV12→BGRA conversion) and only changes how the decoded BGRA frame gets from D3D11 to D3D12.

### 1.1 VideoFrame struct change

```cpp
// video_decoder.h — replace CPU pixels with GPU texture
struct VideoFrame {
    // Remove: std::vector<uint8_t> pixels;
    ComPtr<ID3D12Resource>   d3d12Texture;   // shared BGRA texture (D3D12 side)
    ComPtr<ID3D11Texture2D>  d3d11Shared;    // shared BGRA texture (D3D11 side)
    HANDLE                   sharedHandle = nullptr;
    uint32_t width = 0;
    uint32_t height = 0;
    double   timestamp = -1.0;
};
```

### 1.2 Create shared textures in frame pool

During `VideoDecoder::open()`, allocate shared textures instead of CPU pixel buffers. The D3D12 device creates the texture with `D3D12_HEAP_FLAG_SHARED`, then the D3D11 device opens it via the NT handle.

```cpp
// In VideoDecoder::open(), replace:
//   f.pixels.resize(m_width * m_height * 4);
// With:
D3D12_HEAP_PROPERTIES hp = { D3D12_HEAP_TYPE_DEFAULT };
D3D12_RESOURCE_DESC td = {};
td.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
td.Width = m_width;  td.Height = m_height;
td.DepthOrArraySize = 1;  td.MipLevels = 1;
td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
td.SampleDesc.Count = 1;
td.Flags = D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS;

m_d3d12Device->CreateCommittedResource(&hp, D3D12_HEAP_FLAG_SHARED,
    &td, D3D12_RESOURCE_STATE_COMMON, nullptr,
    IID_PPV_ARGS(&f.d3d12Texture));

// Get NT shared handle
m_d3d12Device->CreateSharedHandle(f.d3d12Texture.Get(), nullptr,
    GENERIC_ALL, nullptr, &f.sharedHandle);

// Open on D3D11 side
ComPtr<ID3D11Device1> dev1;
m_d3d11Device.As(&dev1);
dev1->OpenSharedResource1(f.sharedHandle, IID_PPV_ARGS(&f.d3d11Shared));
```

### 1.3 Replace CPU readback with GPU copy

In `readOneFrame()`, replace the staging→Map→memcpy path (lines 466-506) with a single GPU copy:

```cpp
// DXVA path — frame is on GPU as D3D11 texture
// OLD: staging texture → Map → memcpy rows → force alpha opaque
// NEW: GPU-to-GPU copy to shared texture
m_d3d11Ctx->CopySubresourceRegion(
    dest.d3d11Shared.Get(), 0, 0, 0, 0,   // destination: shared texture
    tex.Get(), subIdx, nullptr);            // source: MF's decoded texture
m_d3d11Ctx->Flush();  // ensure copy is submitted to GPU
```

### 1.4 Add TextureCache::registerExternal()

New method to create an SRV for an external D3D12 resource without uploading:

```cpp
const CachedTexture* TextureCache::registerExternal(
    const std::string& key, ID3D12Resource* resource,
    uint32_t width, uint32_t height, DXGI_FORMAT format);
```

This allocates an SRV descriptor in the existing heap and calls `CreateShaderResourceView` on the external resource. No upload buffers needed.

### 1.5 Update render loop

In `app.cpp` render(), replace `uploadPixels()` with the GPU texture:

```cpp
// OLD:
tex = m_textureCache.uploadPixels(texKey, frame->pixels.data(),
    frame->width, frame->height, DXGI_FORMAT_B8G8R8A8_UNORM);

// NEW:
tex = m_textureCache.registerExternal(texKey, frame->d3d12Texture.Get(),
    frame->width, frame->height, DXGI_FORMAT_B8G8R8A8_UNORM);
```

### 1.6 Pass D3D12 device to VideoDecoder

Update `open()` signature to accept the D3D12 device for shared texture creation:

```cpp
bool open(const std::string& filePath,
          ID3D12Device* d3d12Device,           // NEW — for shared textures
          ID3D11Device* sharedDevice = nullptr,
          IMFDXGIDeviceManager* sharedManager = nullptr);
```

### 1.7 Software decode fallback

The software decode path (lines 509-547) still returns CPU pixels. Keep this path functional by maintaining a `std::vector<uint8_t> pixelsFallback` field used only when DXVA is unavailable. The render loop checks which field is populated.

### Phase 1 verification

- [ ] DXVA decode produces frames visible on screen (no black frames, no corruption)
- [ ] Software fallback still works when D3D11 video support is unavailable
- [ ] Frame pool lifecycle correct (no leaked shared handles, no GPU memory growth)
- [ ] Seek/scrub works correctly (shared textures reused properly)
- [ ] Performance: CPU readback time eliminated (verify with GPU profiler or timing)
- [ ] Debug overlay still renders (unrelated to video path)

---

## Phase 2: D3D11On12 + NV12 Output (zero-copy, one fewer GPU conversion)

**Effort**: ~3-5 days | **Risk**: Medium | **Shader changes**: New NV12 pixel shader

Replace the standalone D3D11 device with D3D11On12 wrapping the DX12 device. Request NV12 output from MF instead of RGB32. Decoded textures are D3D12 resources natively — no copy, no conversion until the pixel shader.

### 2.1 D3D11On12 device creation

Replace `D3D11CreateDevice` in `app.cpp:65-86`:

```cpp
ComPtr<ID3D11Device> d3d11Device;
HRESULT hr = D3D11On12CreateDevice(
    m_device.Get(),                    // existing D3D12 device
    D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
    nullptr, 0,                        // use D3D12 device's feature level
    reinterpret_cast<IUnknown**>(m_cmdQueue.GetAddressOf()), 1,
    0,                                 // node mask
    &d3d11Device, &m_d3d11Context, nullptr);

m_d3d11Device = d3d11Device;
d3d11Device.As(&m_d3d11On12Device);    // ID3D11On12Device2
```

### 2.2 NV12 output from MF

In `configureDecoder()`, request NV12 instead of RGB32:

```cpp
// OLD: outputType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_RGB32);
// NEW:
outputType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
```

### 2.3 Unwrap D3D12 resource

In `readOneFrame()`, use `UnwrapUnderlyingResource` instead of any copy:

```cpp
ComPtr<ID3D12Resource> d3d12Res;
hr = m_d3d11On12Device->UnwrapUnderlyingResource(
    tex.Get(),           // MF's D3D11 texture (backed by D3D12)
    m_d3d12Queue,        // D3D12 command queue
    IID_PPV_ARGS(&d3d12Res));
// Resource is now in D3D12_RESOURCE_STATE_COMMON
// Must call ReturnUnderlyingResource() after render completes
```

**Important**: `UnwrapUnderlyingResource` requires Windows 10 version 2004 (Build 19041+). Available on all Windows 11 systems.

**Caveat**: MF's textures are often texture arrays (`ArraySize > 1`). The `subresourceIndex` from `IMFDXGIBuffer::GetSubresourceIndex()` identifies the array slice. SRV creation must target that specific slice.

### 2.4 NV12 pixel shader

New `shaders/nv12_effects_ps.hlsl` combining YUV→RGB conversion with effects:

```hlsl
Texture2D<float>  texY  : register(t0);  // R8_UNORM, PlaneSlice=0, full res
Texture2D<float2> texUV : register(t1);  // R8G8_UNORM, PlaneSlice=1, half res
SamplerState samp : register(s0);

// ... include all EffectsCB and helper functions from effects_ps.hlsl ...

float4 PSMain(float4 pos : SV_Position, float2 uv : TEXCOORD0) : SV_TARGET {
    float  y    = texY.Sample(samp, uv);
    float2 cbcr = texUV.Sample(samp, uv);

    // BT.709 YCbCr → RGB (limited range)
    float3 yuv = float3(y - 16.0/255.0, cbcr.x - 128.0/255.0, cbcr.y - 128.0/255.0);
    float3 rgb;
    rgb.r = 1.164 * yuv.x + 1.793 * yuv.z;
    rgb.g = 1.164 * yuv.x - 0.213 * yuv.y - 0.533 * yuv.z;
    rgb.b = 1.164 * yuv.x + 2.112 * yuv.y;

    float4 color = float4(saturate(rgb), 1.0);

    // Apply effects (same as effects_ps.hlsl)
    // brightness, contrast, saturate, grayscale, sepia, hue-rotate, invert
    // ... (copy effect chain from effects_ps.hlsl) ...

    color.a *= opacity;
    return color;
}
```

### 2.5 NV12 SRV creation (PlaneSlice)

D3D12 allows addressing individual NV12 planes via `PlaneSlice`:

```cpp
// Y plane SRV
D3D12_SHADER_RESOURCE_VIEW_DESC ySrv = {};
ySrv.Format = DXGI_FORMAT_R8_UNORM;
ySrv.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
ySrv.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
ySrv.Texture2D.MipLevels = 1;
ySrv.Texture2D.PlaneSlice = 0;  // Y plane

// UV plane SRV
D3D12_SHADER_RESOURCE_VIEW_DESC uvSrv = {};
uvSrv.Format = DXGI_FORMAT_R8G8_UNORM;
uvSrv.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
uvSrv.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
uvSrv.Texture2D.MipLevels = 1;
uvSrv.Texture2D.PlaneSlice = 1;  // UV plane
```

### 2.6 Root signature / PSO changes

Current root signature has 1 SRV in slot 2. Video rendering needs 2 SRVs (Y + UV). Options:

**Option A** (simpler): Add a second descriptor table slot for the UV SRV. Use the existing PSO for images, a new PSO for NV12 video.

**Option B** (cleaner): Expand slot 2 to a 2-descriptor table. Images use only the first; video uses both. Single root signature, two PSOs.

### 2.7 ReturnUnderlyingResource lifecycle

After the render queue finishes using the NV12 texture, return it to D3D11On12:

```cpp
// After ExecuteCommandLists + fence signal:
UINT64 fenceVal = m_currentFenceValue;
ID3D12Fence* fences[] = { m_renderFence.Get() };
UINT64 values[] = { fenceVal };
m_d3d11On12Device->ReturnUnderlyingResource(
    tex11.Get(), 1, values, fences);
```

### Phase 2 verification

- [ ] NV12 decode produces correct colors (BT.601 vs BT.709 matrix selection)
- [ ] Effects (brightness, contrast, etc.) work identically on NV12 path
- [ ] Texture array subresource indexing correct (no wrong-frame artifacts)
- [ ] ReturnUnderlyingResource called for every unwrapped texture (no leaks)
- [ ] D3D11On12 memory usage stable over time (known issue #40 was fixed)
- [ ] Fallback to Phase 1 shared-texture path if D3D11On12 creation fails

---

## Phase 3: Full D3D12 Video Decode (eliminates D3D11 entirely)

**Effort**: ~2-3 weeks | **Risk**: High | **Prerequisite**: Phase 2 NV12 shader

Eliminate D3D11 and MF's decode pipeline. Use MF only for demuxing (or replace with FFmpeg). Submit compressed bitstream directly to `ID3D12VideoDecodeCommandList::DecodeFrame()`.

### 3.1 New D3D12 video decode resources

```cpp
class D3D12VideoDecoder {
    ComPtr<ID3D12VideoDevice>            m_videoDevice;
    ComPtr<ID3D12VideoDecoder>           m_decoder;
    ComPtr<ID3D12VideoDecoderHeap>       m_decoderHeap;
    ComPtr<ID3D12CommandQueue>           m_decodeQueue;   // VIDEO_DECODE type
    ComPtr<ID3D12CommandAllocator>       m_decodeAlloc;
    ComPtr<ID3D12VideoDecodeCommandList> m_decodeCmdList;
    ComPtr<ID3D12Fence>                  m_decodeFence;
    ComPtr<ID3D12Resource>               m_outputTextures[4];    // NV12 ring buffer
    ComPtr<ID3D12Resource>               m_referenceFrames[16];  // DPB (H.264 max)
    ComPtr<ID3D12Resource>               m_bitstreamBuffer;      // compressed data
};
```

### 3.2 Feature support check

```cpp
ComPtr<ID3D12VideoDevice> videoDevice;
m_device->QueryInterface(IID_PPV_ARGS(&videoDevice));

D3D12_FEATURE_DATA_VIDEO_DECODE_SUPPORT support = {};
support.Configuration.DecodeProfile = D3D12_VIDEO_DECODE_PROFILE_H264;
support.Width = 1920; support.Height = 1080;
support.DecodeFormat = DXGI_FORMAT_NV12;
videoDevice->CheckFeatureSupport(D3D12_FEATURE_VIDEO_DECODE_SUPPORT,
    &support, sizeof(support));
// Check support.SupportFlags & D3D12_VIDEO_DECODE_SUPPORT_FLAG_SUPPORTED
```

### 3.3 Demuxing strategy

**Option A — Keep MF for demuxing only**: Configure `IMFSourceReader` to return compressed samples without decoding. This avoids adding FFmpeg as a dependency but is harder to extract raw NAL units from.

**Option B — Use FFmpeg** (recommended): `avformat_open_input()` / `av_read_frame()` for demuxing, `av_parser_parse2()` for NAL parsing. FFmpeg's `d3d12va` hwaccel code (`libavcodec/d3d12va_h264.c`) shows exactly how to map parsed H.264 to DXVA structures:

```c
// FFmpeg pattern for DXVA pic params:
ff_dxva2_h264_fill_picture_parameters(avctx, ctx, &pic_params);
ff_dxva2_h264_fill_scaling_lists(avctx, ctx, &qmatrix);
```

### 3.4 Bitstream parsing & DPB management

For each compressed frame, fill DXVA structures:

- `DXVA_PicParams_H264` — picture parameters (POC, reference lists, flags)
- `DXVA_Qmatrix_H264` — quantization matrices from SPS
- `DXVA_Slice_H264_Short` — slice byte offsets into bitstream buffer

DPB management (Decoded Picture Buffer):
- Track up to 16 reference frames for H.264
- Mark frames as short-term/long-term references based on slice headers
- Evict frames per MMCO (Memory Management Control Operations)
- Getting this wrong causes green frames or blocky artifacts

### 3.5 DecodeFrame submission

```cpp
D3D12_VIDEO_DECODE_INPUT_STREAM_ARGUMENTS inputArgs = {};
inputArgs.pHeap = m_decoderHeap.Get();
inputArgs.CompressedBitstream.pBuffer = m_bitstreamBuffer.Get();
inputArgs.CompressedBitstream.Size = bitstreamSize;
inputArgs.ReferenceFrames.NumTexture2Ds = dpbSize;
inputArgs.ReferenceFrames.ppTexture2Ds = refTextureArray;
inputArgs.NumFrameArguments = 3;  // pic params + qmatrix + slice control

D3D12_VIDEO_DECODE_OUTPUT_STREAM_ARGUMENTS outputArgs = {};
outputArgs.pOutputTexture2D = m_outputTextures[ringIdx].Get();

m_decodeCmdList->ResourceBarrier(...);  // VIDEO_DECODE_WRITE for output
m_decodeCmdList->DecodeFrame(m_decoder.Get(), &outputArgs, &inputArgs);
m_decodeCmdList->Close();
m_decodeQueue->ExecuteCommandLists(1, ...);
m_decodeQueue->Signal(m_decodeFence.Get(), ++m_fenceValue);
```

### 3.6 Cross-queue synchronization

```
Video decode queue:  DecodeFrame() → Signal(decodeFence, N)
3D render queue:     Wait(decodeFence, N) → ResourceBarrier → DrawQuad
```

The decode queue runs in parallel with rendering — decode frame N+1 while rendering frame N.

### 3.7 Codec support matrix

| Codec | Profile GUID | Hardware support |
|-------|-------------|-----------------|
| H.264 | `D3D12_VIDEO_DECODE_PROFILE_H264` | Universal (all modern GPUs) |
| HEVC Main | `D3D12_VIDEO_DECODE_PROFILE_HEVC_MAIN` | Most GPUs (2015+) |
| HEVC Main10 | `D3D12_VIDEO_DECODE_PROFILE_HEVC_MAIN10` | Most GPUs (2015+) |
| VP9 | `D3D12_VIDEO_DECODE_PROFILE_VP9` | Intel/AMD (varies) |
| AV1 | `D3D12_VIDEO_DECODE_PROFILE_AV1` | RTX 30xx+, Intel Arc, RX 7000+ |

Always call `CheckFeatureSupport` per codec/resolution. Fall back to Phase 2 (D3D11On12+MF) for unsupported codecs.

### Phase 3 verification

- [ ] H.264 baseline/main/high profiles decode correctly
- [ ] Reference frame management produces correct inter-frame predictions
- [ ] Seek works (flush DPB, find nearest keyframe, decode forward)
- [ ] Resolution changes handled (recreate decoder heap + textures)
- [ ] Graceful fallback when codec unsupported by hardware
- [ ] Memory stable over extended playback (no DPB leaks)
- [ ] Multi-queue parallelism measurably improves throughput

---

## Relationship to UI Media Layer

The native renderer receives project state from the UI via:
- `PushSnapshot(json)` — full timeline + clip data (via Wails Go bridge → SSE)
- `PushTime(double)` — current presentation time (~60fps)

### What changes for the UI

**Phase 1-2**: Nothing. The snapshot format and time protocol are unchanged. The native renderer internally changes how it processes video, but the UI-facing API is identical.

**Phase 3**: If the UI's planned topology/transform abstraction (from the MF architecture plan) is implemented, the snapshot format could carry a structured effect pipeline instead of flat effect arrays. The native renderer could then build a GPU-side topology walker. However, this is optional — the current flat effect arrays work fine with all three phases.

### Intersection with MF architecture plan

| MF Architecture Plan Item | DX12 Video Decode Impact |
|---------------------------|-------------------------|
| topology.js (DAG nodes) | Phase 3 could expose decode/render as topology nodes |
| transform.js (MFT abstraction) | GPU effects are already transforms; NV12 shader combines YUV→RGB + effects in one pass |
| sink.js (display sinks) | Native renderer IS a sink; no change needed |
| Presentation descriptors | Multi-stream (video+audio) would need audio decode path in native renderer (future) |

The two plans are **largely independent**. The DX12 video decode work is entirely within the native renderer. The MF architecture plan is entirely within the UI JavaScript layer. They can proceed in parallel without conflicts.

---

## Reference Implementations

| Source | What to learn from it |
|--------|----------------------|
| [D3D12TranslationLayer/VideoDecode.cpp](https://github.com/microsoft/D3D12TranslationLayer/blob/master/src/VideoDecode.cpp) | Complete DecodeFrame pipeline, resource barriers, DPB management |
| [D3D11On12/VideoDecode.cpp](https://github.com/microsoft/D3D11On12/blob/master/src/VideoDecode.cpp) | D3D11 video API mapped onto D3D12 |
| [FFmpeg d3d12va_decode.c](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/d3d12va_decode.c) | Async 36-deep pipeline, fence sync, reference-only mode |
| [FFmpeg d3d12va_h264.c](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/d3d12va_h264.c) | H.264-specific DXVA param filling |
| [Chromium d3d12_video_decoder.cc](https://source.chromium.org/chromium/chromium/src/+/main:media/gpu/windows/) | Shared-handle D3D11/D3D12 interop pattern |
| [OBS d3d12-capture.cpp](https://github.com/obsproject/obs-studio/blob/master/plugins/win-capture/graphics-hook/d3d12-capture.cpp) | D3D11On12 wrapping |

### Microsoft documentation

- [D3D11On12CreateDevice](https://learn.microsoft.com/en-us/windows/win32/api/d3d11on12/nf-d3d11on12-d3d11on12createdevice)
- [ID3D11On12Device2::UnwrapUnderlyingResource](https://learn.microsoft.com/en-us/windows/win32/api/d3d11on12/nf-d3d11on12-id3d11on12device2-unwrapunderlyingresource)
- [ID3D11On12Device2::ReturnUnderlyingResource](https://learn.microsoft.com/en-us/windows/win32/api/d3d11on12/nf-d3d11on12-id3d11on12device2-returnunderlyingresource)
- [D3D12 Video Overview](https://learn.microsoft.com/en-us/windows/win32/medfound/direct3d-12-video-overview)
- [D3D12_FEATURE_DATA_VIDEO_DECODE_SUPPORT](https://learn.microsoft.com/en-us/windows/win32/api/d3d12video/ns-d3d12video-d3d12_feature_data_video_decode_support)
- [Supporting D3D11 Video Decoding in Media Foundation](https://learn.microsoft.com/en-us/windows/win32/medfound/supporting-direct3d-11-video-decoding-in-media-foundation)
- [NV12 Subresources / PlaneSlice](https://learn.microsoft.com/en-us/windows/win32/direct3d12/subresources)

### Known issues

- **D3D11On12 GPU memory leak** ([issue #40](https://github.com/microsoft/D3D11On12/issues/40)) — fixed in Windows updates, ensure recent OS version
- **D3D11On12 overhead** — "moderate CPU overhead, minimal GPU overhead, significant memory overhead" (Microsoft docs). Acceptable for video decode workload.
- **MF texture arrays** — MF allocates a single texture array (`ArraySize > 1`), not individual textures. `IMFDXGIBuffer::GetSubresourceIndex()` identifies the slice. Phase 1 handles this via `CopySubresourceRegion` with the correct `subIdx`.

---

## Decision Log

| Decision | Rationale |
|----------|-----------|
| Phase 1 uses DXGI shared textures, not D3D11On12 | Simpler, fewer moving parts, avoids D3D11On12 memory overhead. One GPU copy (~50μs) is negligible vs CPU readback (~12ms). |
| Phase 1 keeps RGB32 output from MF | No shader changes needed. MF's GPU-side NV12→BGRA conversion is fast enough. Optimize later in Phase 2. |
| Phase 2 uses D3D11On12 + NV12 | True zero-copy. NV12 shader does YUV→RGB + effects in one pass (fewer GPU memory reads). |
| Phase 3 recommends FFmpeg over MF-only demuxing | FFmpeg has proven DXVA structure filling (`ff_dxva2_h264_fill_picture_parameters`). Extracting raw NAL units from MF SourceReader is underdocumented. |
| Software fallback always available | Some systems lack D3D11 video support. CPU decode path must remain functional across all phases. |
