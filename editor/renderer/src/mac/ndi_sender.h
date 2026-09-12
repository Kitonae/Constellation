#pragma once
// NDI video output sender.
//
// Captures the rendered drawable each frame via a GPU readback into a ring
// of shared buffers and streams it to the network as an NDI source. The
// ring means readback never stalls the render loop.

#include "objc_ref.h"
#if HAS_NDI
#include <Processing.NDI.Lib.h>
#else
typedef void* NDIlib_send_instance_t;
#endif
#include <cstdint>
#include <string>
#include <vector>

class NDISender {
public:
    ~NDISender();

    // Initialize NDI library, create sender, allocate the staging ring.
    bool init(const ObjcRef& device, const std::string& sourceName,
              uint32_t width, uint32_t height, double fps);

    // Record a copy of the drawable into the current staging buffer. Call
    // after the screen's render pass has ended and before the overlay pass.
    // `frameFenceValue` is the render timeline value the frame signals; the
    // copy is complete once the frame event passes it.
    void capture(const ObjcRef& commandBuffer, const ObjcRef& drawableTexture, uint64_t frameFenceValue);

    // Which screen feeds this sender. Only that screen is captured, so two
    // open windows do not interleave into one NDI stream.
    void setSourceScreen(const std::string& screenId) { m_screenId = screenId; }
    const std::string& sourceScreen() const { return m_screenId; }

    // Send the oldest ready frame to NDI asynchronously. Call after the
    // frame's command buffer has been committed.
    void send(const ObjcRef& frameEvent);

    void shutdown();

    bool isActive() const { return m_sender != nullptr; }
    const char* sourceName() const { return m_sourceName.c_str(); }
    int numConnections() const;

private:
    // NDI
    NDIlib_send_instance_t m_sender = nullptr;
    std::string m_sourceName;
    bool m_ndiInitialized = false;

    // Staging ring buffer for GPU -> CPU readback
    static constexpr int RING_SIZE = 3;
    ObjcRef m_staging[RING_SIZE];      // id<MTLBuffer>, shared storage
    uint64_t m_fenceValues[RING_SIZE] = {};
    int m_captureIdx = 0;   // next slot to copy into
    int m_sendIdx = 0;      // next slot to read from for NDI
    int m_pendingFrames = 0;

    // Frame dimensions
    uint32_t m_width = 0;
    uint32_t m_height = 0;
    uint32_t m_rowPitch = 0;
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
