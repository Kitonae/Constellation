#pragma once
// NDI video output sender.
//
// Captures the rendered back buffer each frame via GPU readback and
// streams it to the network as an NDI source. Uses a ring buffer of
// staging textures so readback never stalls the render loop.

#include <d3d12.h>
#include <wrl/client.h>
#if HAS_NDI
#include <Processing.NDI.Lib.h>
#else
// Stub types when NDI SDK is not available
typedef void* NDIlib_send_instance_t;
#endif
#include <string>
#include <vector>
#include <cstdint>

using Microsoft::WRL::ComPtr;

class NDISender {
public:
    ~NDISender();

    // Initialize NDI library, create sender, allocate staging ring buffer.
    bool init(ID3D12Device* device, ID3D12CommandQueue* cmdQueue,
              const std::string& sourceName, uint32_t width, uint32_t height, double fps);

    // Record a copy command from the back buffer to the current staging texture.
    // Call this BEFORE the back buffer transitions to PRESENT state.
    // The back buffer must be in COPY_SOURCE or RENDER_TARGET state.
    // A back buffer whose size does not match the sender's is skipped: copying
    // it with a mismatched footprint produced garbage.
    void capture(ID3D12GraphicsCommandList* cmdList, ID3D12Resource* backBuffer);

    // Which screen feeds this sender. Only that screen is captured, so two
    // open windows no longer interleave into one NDI stream.
    void setSourceScreen(const std::string& screenId) { m_screenId = screenId; }
    const std::string& sourceScreen() const { return m_screenId; }

    // Send the oldest ready frame to NDI asynchronously.
    // Call this AFTER the command list has been executed (post-Present is fine).
    void send();

    void shutdown();

    bool isActive() const { return m_sender != nullptr; }
    const char* sourceName() const { return m_sourceName.c_str(); }
    int numConnections() const;
    ID3D12Fence* decodeFence() const { return m_fence.Get(); }
    UINT64 currentFenceValue() const { return m_fenceValue; }

private:
    // NDI
    NDIlib_send_instance_t m_sender = nullptr;
    std::string m_sourceName;
    bool m_ndiInitialized = false;

    // Staging ring buffer for GPU → CPU readback
    static constexpr int RING_SIZE = 3;
    ComPtr<ID3D12Resource> m_staging[RING_SIZE];
    UINT64 m_fenceValues[RING_SIZE] = {};
    int m_captureIdx = 0;   // next slot to copy into
    int m_sendIdx = 0;      // next slot to read from for NDI
    int m_pendingFrames = 0;

    // Readback fence
    ID3D12CommandQueue* m_cmdQueue = nullptr;
    ComPtr<ID3D12Fence> m_fence;
    HANDLE m_fenceEvent = nullptr;
    UINT64 m_fenceValue = 0;

    // Frame dimensions
    uint32_t m_width = 0;
    uint32_t m_height = 0;
    uint32_t m_rowPitch = 0;  // staging buffer row pitch (may differ from width*4)
    int m_frameRateN = 60000;
    int m_frameRateD = 1000;

    // NDI frame buffers (CPU side, persistent for async send).
    //
    // NDIlib_send_send_video_async_v2 keeps reading p_data until the *next*
    // async call returns, so writing into the same buffer before that call
    // tore the frame. Two buffers is exactly what the SDK's contract needs.
    std::vector<uint8_t> m_ndiBuffers[2];
    int m_ndiBufIdx = 0;

    std::string m_screenId;
};
