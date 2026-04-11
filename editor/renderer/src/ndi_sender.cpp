#include "ndi_sender.h"
#include <cstdio>
#include <cstring>

#if !HAS_NDI
// Stub implementation when NDI SDK is not available
NDISender::~NDISender() {}
bool NDISender::init(ID3D12Device*, ID3D12CommandQueue*, const std::string&, uint32_t, uint32_t, double) { return false; }
void NDISender::capture(ID3D12GraphicsCommandList*, ID3D12Resource*) {}
void NDISender::send() {}
void NDISender::shutdown() {}
int NDISender::numConnections() const { return 0; }
#else

NDISender::~NDISender() { shutdown(); }

bool NDISender::init(ID3D12Device* device, ID3D12CommandQueue* cmdQueue,
                      const std::string& sourceName, uint32_t width, uint32_t height, double fps) {
    if (!device || !cmdQueue || width == 0 || height == 0) return false;

    // Initialize NDI library
    if (!NDIlib_initialize()) {
        printf("[NDI] NDIlib_initialize failed (CPU not supported?)\n");
        return false;
    }
    m_ndiInitialized = true;

    // Create NDI sender
    m_sourceName = sourceName;
    NDIlib_send_create_t createDesc;
    createDesc.p_ndi_name = m_sourceName.c_str();
    createDesc.p_groups = nullptr;
    createDesc.clock_video = true;
    createDesc.clock_audio = false;

    m_sender = NDIlib_send_create(&createDesc);
    if (!m_sender) {
        printf("[NDI] Failed to create sender '%s'\n", m_sourceName.c_str());
        return false;
    }

    m_cmdQueue = cmdQueue;
    m_width = width;
    m_height = height;

    // Frame rate
    if (fps > 59.0 && fps < 61.0) {
        m_frameRateN = 60000; m_frameRateD = 1000;
    } else if (fps > 29.0 && fps < 31.0) {
        m_frameRateN = 30000; m_frameRateD = 1000;
    } else {
        m_frameRateN = (int)(fps * 1000.0); m_frameRateD = 1000;
    }

    // Create staging textures (READBACK heap) for GPU → CPU copy
    D3D12_RESOURCE_DESC texDesc = {};
    texDesc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    texDesc.Width = width;
    texDesc.Height = height;
    texDesc.DepthOrArraySize = 1;
    texDesc.MipLevels = 1;
    texDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    texDesc.SampleDesc.Count = 1;
    texDesc.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;

    // Query the row pitch for readback
    D3D12_PLACED_SUBRESOURCE_FOOTPRINT footprint = {};
    device->GetCopyableFootprints(&texDesc, 0, 1, 0, &footprint, nullptr, nullptr, nullptr);
    m_rowPitch = footprint.Footprint.RowPitch;

    // Create readback buffers (not textures — must use buffer for READBACK heap)
    UINT64 bufferSize = (UINT64)m_rowPitch * height;

    D3D12_HEAP_PROPERTIES hp = {};
    hp.Type = D3D12_HEAP_TYPE_READBACK;

    D3D12_RESOURCE_DESC bufDesc = {};
    bufDesc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    bufDesc.Width = bufferSize;
    bufDesc.Height = 1;
    bufDesc.DepthOrArraySize = 1;
    bufDesc.MipLevels = 1;
    bufDesc.SampleDesc.Count = 1;
    bufDesc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;

    for (int i = 0; i < RING_SIZE; i++) {
        HRESULT hr = device->CreateCommittedResource(
            &hp, D3D12_HEAP_FLAG_NONE,
            &bufDesc, D3D12_RESOURCE_STATE_COPY_DEST, nullptr,
            IID_PPV_ARGS(&m_staging[i]));
        if (FAILED(hr)) {
            printf("[NDI] Staging buffer %d creation failed: 0x%08x\n", i, hr);
            shutdown();
            return false;
        }
    }

    // NDI CPU-side frame buffer (compact, no row pitch padding)
    m_ndiBuffer.resize((size_t)width * height * 4);

    // Fence for tracking readback completion
    device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&m_fence));
    m_fenceEvent = CreateEvent(nullptr, FALSE, FALSE, nullptr);

    printf("[NDI] Sender created: \"%s\" (%ux%u, %d/%d fps, ring=%d)\n",
        m_sourceName.c_str(), width, height, m_frameRateN, m_frameRateD, RING_SIZE);
    return true;
}

void NDISender::capture(ID3D12GraphicsCommandList* cmdList, ID3D12Resource* backBuffer) {
    if (!m_sender || !cmdList || !backBuffer) return;

    // Don't queue more than RING_SIZE frames
    if (m_pendingFrames >= RING_SIZE) return;

    int idx = m_captureIdx % RING_SIZE;

    // Transition back buffer to COPY_SOURCE
    D3D12_RESOURCE_BARRIER barrier = {};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource = backBuffer;
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_COPY_SOURCE;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    cmdList->ResourceBarrier(1, &barrier);

    // Copy back buffer → staging readback buffer
    D3D12_TEXTURE_COPY_LOCATION src = {};
    src.pResource = backBuffer;
    src.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
    src.SubresourceIndex = 0;

    D3D12_PLACED_SUBRESOURCE_FOOTPRINT footprint = {};
    footprint.Footprint.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    footprint.Footprint.Width = m_width;
    footprint.Footprint.Height = m_height;
    footprint.Footprint.Depth = 1;
    footprint.Footprint.RowPitch = m_rowPitch;

    D3D12_TEXTURE_COPY_LOCATION dst = {};
    dst.pResource = m_staging[idx].Get();
    dst.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
    dst.PlacedFootprint = footprint;

    cmdList->CopyTextureRegion(&dst, 0, 0, 0, &src, nullptr);

    // Transition back buffer back to RENDER_TARGET (endFrame will transition to PRESENT)
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_SOURCE;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
    cmdList->ResourceBarrier(1, &barrier);

    // Track this frame's fence value
    m_fenceValue++;
    m_fenceValues[idx] = m_fenceValue;
    m_captureIdx++;
    m_pendingFrames++;
}

void NDISender::send() {
    if (!m_sender || m_pendingFrames <= 0) return;

    int idx = m_sendIdx % RING_SIZE;
    UINT64 required = m_fenceValues[idx];

    // Wait for the GPU copy to complete (should be done by now since Present blocked)
    if (m_fence->GetCompletedValue() < required) {
        m_fence->SetEventOnCompletion(required, m_fenceEvent);
        WaitForSingleObject(m_fenceEvent, 5); // 5ms max, should be instant
        if (m_fence->GetCompletedValue() < required) {
            // Still not done — skip this frame
            return;
        }
    }

    // Map staging buffer and copy to NDI buffer
    void* mapped = nullptr;
    D3D12_RANGE readRange = {0, (SIZE_T)m_rowPitch * m_height};
    if (SUCCEEDED(m_staging[idx]->Map(0, &readRange, &mapped))) {
        uint32_t dstPitch = m_width * 4;
        const uint8_t* src = (const uint8_t*)mapped;
        uint8_t* dst = m_ndiBuffer.data();

        if (m_rowPitch == dstPitch) {
            memcpy(dst, src, (size_t)dstPitch * m_height);
        } else {
            for (uint32_t y = 0; y < m_height; y++) {
                memcpy(dst + y * dstPitch, src + y * m_rowPitch, dstPitch);
            }
        }

        D3D12_RANGE noWrite = {0, 0};
        m_staging[idx]->Unmap(0, &noWrite);
    }

    // Send to NDI asynchronously
    NDIlib_video_frame_v2_t frame;
    frame.xres = (int)m_width;
    frame.yres = (int)m_height;
    frame.FourCC = NDIlib_FourCC_video_type_RGBA;  // swap chain is R8G8B8A8
    frame.frame_rate_N = m_frameRateN;
    frame.frame_rate_D = m_frameRateD;
    frame.picture_aspect_ratio = 0.0f;  // square pixels
    frame.frame_format_type = NDIlib_frame_format_type_progressive;
    frame.timecode = NDIlib_send_timecode_synthesize;
    frame.p_data = m_ndiBuffer.data();
    frame.line_stride_in_bytes = (int)(m_width * 4);
    frame.p_metadata = nullptr;
    frame.timestamp = 0;

    NDIlib_send_send_video_async_v2(m_sender, &frame);

    m_sendIdx++;
    m_pendingFrames--;
}

int NDISender::numConnections() const {
    if (!m_sender) return 0;
    return NDIlib_send_get_no_connections(m_sender, 0);
}

void NDISender::shutdown() {
    if (m_sender) {
        // Flush async send
        NDIlib_send_send_video_async_v2(m_sender, nullptr);
        NDIlib_send_destroy(m_sender);
        m_sender = nullptr;
    }

    for (auto& s : m_staging) s.Reset();
    m_fence.Reset();
    if (m_fenceEvent) { CloseHandle(m_fenceEvent); m_fenceEvent = nullptr; }

    if (m_ndiInitialized) {
        NDIlib_destroy();
        m_ndiInitialized = false;
    }

    m_ndiBuffer.clear();
    m_pendingFrames = 0;
    m_captureIdx = 0;
    m_sendIdx = 0;
    printf("[NDI] Sender destroyed\n");
}

#endif // HAS_NDI
